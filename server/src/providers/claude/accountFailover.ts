import type Database from 'better-sqlite3';
import type { ConversationRow } from '../../db/db.js';
import type { ConversationManager } from '../../runtime/conversationManager.js';
import type { SecretStore } from '../../secrets/store.js';
import type { ClaudeProbe } from '../../usage/claudeProbe.js';
import type { UsageStore } from '../../usage/store.js';
import { parseClaudeLimitReset } from './rateLimitMessage.js';

/**
 * Automatic Claude account failover.
 *
 * A subscription session limit ends the turn with a 429 `rate_limit` assistant
 * message (see adapter.ts / rateLimitMessage.ts). When several subscriptions
 * are connected, sitting out the reset window is a choice nobody makes on
 * purpose: this switches the globally active account to the one with the most
 * headroom and asks the conversation to pick up where it left off.
 *
 * Everything above `createClaudeAccountFailover` is pure so the ranking and the
 * loop guard can be unit-tested without a runner.
 */

/** Skip an account already this deep into either window — it is about to limit too. */
export const HEADROOM_CUTOFF_PERCENT = 90;
/** One auto-switch per conversation per this long. */
export const SWITCH_COOLDOWN_MS = 10 * 60 * 1000;
/** How long a limited account stays out when its message named no reset time. */
export const DEFAULT_EXHAUSTION_MS = 5 * 60 * 60 * 1000;
/** Usage older than this is re-probed before ranking (the probe single-flights). */
const USAGE_MAX_AGE_MS = 60 * 1000;

/**
 * The continuation the switched-to agent reads. The chat notice below is live
 * only (it is not in the provider transcript, so it vanishes on reload), so the
 * durable record of what happened lives here, in the message itself.
 */
export function failoverContinuationMessage(
  limitedLabel: string,
  nextLabel: string,
  alreadySwitched = false,
): string {
  return (
    'Continue where you left off; the previous turn was cut off by a Claude usage limit on '
    + `${limitedLabel}. Veneer ${alreadySwitched ? 'is already on' : 'switched to'} ${nextLabel}.`
  );
}

/** Windows that decide headroom: the 5-hour window and every weekly (incl. model-scoped). */
export function isHeadroomWindow(rateLimitType: string): boolean {
  return rateLimitType === 'five_hour' || rateLimitType.startsWith('seven_day');
}

export interface FailoverCandidate {
  id: string;
  label: string;
  /** Worst window, whole percent. null = no telemetry stored for this account yet. */
  usedPercent: number | null;
}

/** Worst headroom window across an account's snapshots; null when it has none. */
export function worstUsedPercent(
  snapshots: { rateLimitType: string; utilization: number }[],
): number | null {
  const relevant = snapshots.filter((snap) => isHeadroomWindow(snap.rateLimitType));
  if (relevant.length === 0) return null;
  return Math.max(...relevant.map((snap) => Math.round(snap.utilization * 100)));
}

/**
 * The connected account with the most headroom, or null when none qualifies.
 * Excluded ids (the account that just limited, plus anything still exhausted)
 * and anything past the cutoff on any window are dropped; the rest rank by
 * worst window ascending. An account with no telemetry yet ranks last — it may
 * well be free, but a measured account is the safer switch.
 */
export function pickFailoverAccount(
  candidates: FailoverCandidate[],
  exclude: ReadonlySet<string> = new Set(),
): FailoverCandidate | null {
  const eligible = candidates.filter(
    (account) =>
      !exclude.has(account.id) &&
      (account.usedPercent === null || account.usedPercent <= HEADROOM_CUTOFF_PERCENT),
  );
  if (eligible.length === 0) return null;
  return [...eligible].sort(
    (a, b) =>
      (a.usedPercent ?? Infinity) - (b.usedPercent ?? Infinity) || a.id.localeCompare(b.id),
  )[0]!;
}

export interface FailoverGuard {
  /** False while this conversation is inside its post-switch cooldown. */
  canSwitch(conversationId: string, now?: number): boolean;
  noteSwitch(conversationId: string, now?: number): void;
  /** Keep an account out of the running until `until` (epoch ms). */
  markExhausted(accountId: string, until: number): void;
  /** Ids still exhausted at `now`. */
  exhausted(now?: number): Set<string>;
}

/** In-memory only: a restart is a fine moment to try every account again. */
export function createFailoverGuard(cooldownMs: number = SWITCH_COOLDOWN_MS): FailoverGuard {
  const lastSwitchAt = new Map<string, number>();
  const exhaustedUntil = new Map<string, number>();
  return {
    canSwitch(conversationId, now = Date.now()) {
      const last = lastSwitchAt.get(conversationId);
      return last === undefined || now - last >= cooldownMs;
    },
    noteSwitch(conversationId, now = Date.now()) {
      lastSwitchAt.set(conversationId, now);
    },
    markExhausted(accountId, until) {
      const current = exhaustedUntil.get(accountId) ?? 0;
      if (until > current) exhaustedUntil.set(accountId, until);
    },
    exhausted(now = Date.now()) {
      const ids = new Set<string>();
      for (const [id, until] of exhaustedUntil) {
        if (until > now) ids.add(id);
        else exhaustedUntil.delete(id);
      }
      return ids;
    },
  };
}

/** What the Claude adapter reports when a turn dies on a session limit. */
export interface ClaudeSessionLimitEvent {
  conversationId: string | null;
  /** Account the turn actually ran on (captured at spawn), or null if unknown. */
  accountId: string | null;
  /** The limit message text, which usually names the reset time. */
  text: string;
  at: Date;
}

export interface ClaudeAccountFailoverOptions {
  db: Database.Database;
  secrets: SecretStore;
  usage: UsageStore;
  manager: Pick<ConversationManager, 'bus' | 'deliverWakeup'>;
  probe?: Pick<ClaudeProbe, 'refreshIfStale'>;
  guard?: FailoverGuard;
  log?: Pick<Console, 'warn'>;
}

export interface ClaudeAccountFailover {
  /** Never rejects: failover is best effort on top of a turn that already failed. */
  handleSessionLimit(event: ClaudeSessionLimitEvent): Promise<void>;
}

export function createClaudeAccountFailover(opts: ClaudeAccountFailoverOptions): ClaudeAccountFailover {
  const guard = opts.guard ?? createFailoverGuard();
  const log = opts.log ?? console;
  const conversationStmt = opts.db.prepare('SELECT * FROM conversations WHERE id = ?');

  function notice(conversationId: string, message: string): void {
    opts.manager.bus.emit('event', conversationId, { type: 'notice', message });
  }

  async function run(event: ClaudeSessionLimitEvent): Promise<void> {
    if (!event.conversationId) return;
    const nowMs = event.at.getTime();
    const limitedId = event.accountId ?? opts.secrets.activeClaudeAccountId();
    // The account that just limited is out until it resets, whatever else
    // happens below — otherwise the next conversation switches straight back.
    if (limitedId) {
      const reset = parseClaudeLimitReset(event.text, event.at);
      guard.markExhausted(limitedId, reset ? reset.getTime() : nowMs + DEFAULT_EXHAUSTION_MS);
    }
    // One switch per conversation per cooldown: a chat that limits again
    // immediately is telling us switching did not help.
    if (!guard.canSwitch(event.conversationId, nowMs)) return;
    const conv = conversationStmt.get(event.conversationId) as ConversationRow | undefined;
    if (!conv) return;

    if (opts.probe) {
      await opts.probe.refreshIfStale(USAGE_MAX_AGE_MS).catch(() => null);
    }
    // The probe yields: another chat may switch accounts, exhaust the spare,
    // or handle this same failure before it returns. Decide from current state.
    const decisionMs = Date.now();
    if (!guard.canSwitch(event.conversationId, decisionMs)) return;
    const accounts = opts.secrets.listClaudeAccounts();
    const activeId = opts.secrets.activeClaudeAccountId();
    const labelFor = (id: string | null): string =>
      accounts.find((account) => account.id === id)?.label ?? 'the previous account';
    const usageById = new Map(opts.usage.allClaudeAccounts().map((entry) => [entry.accountId, entry]));
    const candidates: FailoverCandidate[] = accounts.map((account) => ({
      id: account.id,
      label: account.label,
      usedPercent: worstUsedPercent(usageById.get(account.id)?.snapshots ?? []),
    }));
    const exclude = guard.exhausted(decisionMs);
    if (limitedId) exclude.add(limitedId);
    // Prefer an account another chat already activated, provided it still has
    // headroom. Selection, activation, and continuation have no await between them.
    const alreadyActive = limitedId && activeId !== limitedId
      ? pickFailoverAccount(candidates.filter((account) => account.id === activeId), exclude)
      : null;
    const next = alreadyActive ?? pickFailoverAccount(candidates, exclude);
    // Nobody has headroom: leave the failure message (it carries the reset time).
    if (!next) return;
    if (!alreadyActive && !opts.secrets.setActiveClaudeAccount(next.id)) return;

    guard.noteSwitch(event.conversationId, decisionMs);
    notice(
      event.conversationId,
      `Session limit hit on ${labelFor(limitedId)}. ${alreadyActive ? 'Already on' : 'Switched to'} ${next.label}, continuing.`,
    );
    opts.manager.deliverWakeup(
      conv,
      failoverContinuationMessage(labelFor(limitedId), next.label, Boolean(alreadyActive)),
      `claude-failover:${event.conversationId}:${nowMs}`,
    );
  }

  return {
    handleSessionLimit(event) {
      return run(event).catch((err: Error) => {
        log.warn(`[claude] account failover failed: ${err.message}`);
      });
    },
  };
}
