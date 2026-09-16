/**
 * Liveness guard for one provider turn.
 *
 * Veneer runs one turn at a time per conversation and nothing later can start
 * until `handle.done` settles, so a provider that never finishes would wedge
 * the chat forever. The original guard was a single absolute timer, which
 * measured elapsed time rather than liveness: it killed 45-minute turns that
 * were actively working (Aug 2026: 36 Codex turns died mid-flight, 35 of them
 * having started new agent work in the preceding minute).
 *
 * This replaces it with two timers:
 *
 * - an **inactivity window** that only genuine forward progress restarts, and
 *   that legitimate blocking (a human approval, a tool call still running)
 *   suspends via `hold()`/`release()`;
 * - an absolute **ceiling** that nothing resets or pauses, so a turn that stays
 *   superficially "busy" forever still dies.
 *
 * The distinction that matters: a turn looping on poll-style tools (`wait`,
 * `list…`) is NOT alive — that is exactly the zombie shape the guard exists to
 * reap — so those calls neither count as activity nor hold the window open.
 */
export type TurnTimeoutReason = 'inactivity' | 'ceiling';

export interface TurnWatchdog {
  /** Forward progress from the provider: restart the inactivity window. */
  activity(): void;
  /**
   * Suspend the inactivity window while something legitimate blocks the turn
   * (pending human approval, in-flight non-poll tool call). Ref-counted, so
   * concurrent holds each need their own `release()`.
   */
  hold(): void;
  /** Release one `hold()`. The window restarts when the last hold clears. */
  release(): void;
  /** The turn is over: cancel both timers. */
  stop(): void;
}

export interface TurnWatchdogOptions {
  /** Idle time with no provider progress before the turn is reaped. */
  inactivityMs: number;
  /** Absolute wall-clock cap on the turn, never reset and never paused. */
  ceilingMs: number;
  onExpire(reason: TurnTimeoutReason): void;
}

export function createTurnWatchdog({ inactivityMs, ceilingMs, onExpire }: TurnWatchdogOptions): TurnWatchdog {
  let idleTimer: NodeJS.Timeout | null = null;
  let holds = 0;
  let expired = false;
  let stopped = false;

  function fire(reason: TurnTimeoutReason): void {
    if (expired || stopped) return;
    expired = true;
    clearIdle();
    clearTimeout(ceilingTimer);
    onExpire(reason);
  }

  function clearIdle(): void {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  }

  function armIdle(): void {
    clearIdle();
    if (stopped || expired || holds > 0) return;
    idleTimer = setTimeout(() => fire('inactivity'), inactivityMs);
    idleTimer.unref?.();
  }

  const ceilingTimer = setTimeout(() => fire('ceiling'), ceilingMs);
  ceilingTimer.unref?.();
  armIdle();

  return {
    activity() {
      if (stopped || expired) return;
      armIdle();
    },
    hold() {
      if (stopped || expired) return;
      holds += 1;
      clearIdle();
    },
    release() {
      if (stopped || expired || holds === 0) return;
      holds -= 1;
      // Whatever was blocking just finished, which is itself progress.
      armIdle();
    },
    stop() {
      if (stopped) return;
      stopped = true;
      clearIdle();
      clearTimeout(ceilingTimer);
    },
  };
}

/** Minutes, rounded, for a user-facing timeout message. */
function minutesOf(ms: number): number {
  return Math.max(1, Math.round(ms / 60_000));
}

/** The one sentence a timed-out turn shows the user, for every provider. */
export function turnTimeoutMessage(reason: TurnTimeoutReason, inactivityMs: number, ceilingMs: number): string {
  if (reason === 'ceiling') {
    const hours = ceilingMs / 3_600_000;
    const label = Number.isInteger(hours) ? `${hours} hour${hours === 1 ? '' : 's'}` : `${minutesOf(ceilingMs)} minutes`;
    return `Turn hit the ${label} limit and was stopped.`;
  }
  return `Turn stalled — no activity for ${minutesOf(inactivityMs)} minutes — and was stopped.`;
}

/**
 * Poll-style tools whose calls prove nothing about liveness.
 *
 * A turn that spawns children and then loops on `wait` is indistinguishable
 * from a wedged one by tool traffic alone: the real liveness signal is the
 * child lifecycle event a completing `wait` produces, not the call itself. Any
 * `list…` tool is the same shape — a read that no agent repeats for a quarter
 * of an hour while genuinely working.
 */
export function isPollingToolName(toolName: string): boolean {
  // mcp__server__tool → tool; Codex/Grok already hand us bare names.
  const bare = (/^mcp__[^_]+(?:_[^_]+)*?__(.+)$/.exec(toolName)?.[1] ?? toolName).toLowerCase();
  return bare === 'wait' || bare === 'list' || bare.startsWith('list_') || bare.startsWith('listagents');
}
