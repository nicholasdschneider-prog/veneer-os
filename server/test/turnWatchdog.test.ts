import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createTurnWatchdog, isPollingToolName, turnTimeoutMessage } from '../src/providers/turnWatchdog.js';
import { createClaudeAdapter } from '../src/providers/claude/adapter.js';
import { createCodexAdapter } from '../src/providers/codexAppServer/adapter.js';
import { createGrokAdapter, grokSubagentLifecycle } from '../src/providers/grok/adapter.js';
import type { ConversationEvent } from '../src/runtime/events.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const FAKE_CLAUDE = path.join(FIXTURES, 'fake-claude.mjs');
const FAKE_CODEX = path.join(FIXTURES, 'fake-app-server.mjs');
const FAKE_GROK = path.join(FIXTURES, 'fake-acp-server.mjs');
const silent = { warn: () => undefined, error: () => undefined };
const dirs: string[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-watchdog-'));
  dirs.push(dir);
  return dir;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, message: string, budgetMs = 15_000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(15);
  }
  throw new Error(message);
}

function readLog(file: string): { method: string; params: Record<string, unknown> }[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

afterEach(() => {
  delete process.env.FAKE_CLAUDE_MODE;
  delete process.env.EMIT_COLLAB_WAIT;
  delete process.env.REQUEST_LOG;
  delete process.env.AWAIT_CANCEL;
  delete process.env.CANCEL_RESPONSE_DELAY_MS;
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('turn watchdog', () => {
  // Timer budgets here are deliberately lopsided rather than tight: under the
  // full suite this process shares a machine with ~180 other forks, so a
  // `sleep(n)` can overshoot by hundreds of milliseconds. Every "must fire"
  // case sleeps many times its window, and every "must not fire" case keeps
  // its activity interval far under its window, so jitter cannot flip a result.
  it('reaps a turn that goes quiet, and never reaps one that keeps working', async () => {
    const quiet: string[] = [];
    createTurnWatchdog({ inactivityMs: 60, ceilingMs: 30_000, onExpire: (r) => quiet.push(r) });
    await sleep(800);
    expect(quiet).toEqual(['inactivity']);

    const busy: string[] = [];
    const working = createTurnWatchdog({ inactivityMs: 2_000, ceilingMs: 30_000, onExpire: (r) => busy.push(r) });
    for (let i = 0; i < 8; i++) {
      await sleep(30);
      working.activity();
    }
    expect(busy).toEqual([]);
    working.stop();
  });

  it('suspends the window while a hold is open and resumes when it clears', async () => {
    const fired: string[] = [];
    const watchdog = createTurnWatchdog({ inactivityMs: 60, ceilingMs: 30_000, onExpire: (r) => fired.push(r) });
    watchdog.hold();
    await sleep(800);
    expect(fired).toEqual([]); // a running tool is blocked, not dead
    watchdog.release();
    await sleep(800);
    expect(fired).toEqual(['inactivity']);
  });

  it('fires the ceiling however alive the turn looks', async () => {
    const fired: string[] = [];
    const watchdog = createTurnWatchdog({ inactivityMs: 30_000, ceilingMs: 80, onExpire: (r) => fired.push(r) });
    watchdog.hold(); // even a permanent hold cannot outlast the ceiling
    const ticker = setInterval(() => watchdog.activity(), 10);
    await sleep(800);
    clearInterval(ticker);
    expect(fired).toEqual(['ceiling']);
    watchdog.stop();
  });

  it('stop() disarms both timers', async () => {
    const fired: string[] = [];
    const watchdog = createTurnWatchdog({ inactivityMs: 40, ceilingMs: 60, onExpire: (r) => fired.push(r) });
    watchdog.stop();
    await sleep(800);
    expect(fired).toEqual([]);
  });

  it('classifies poll-style tools, and only those, as proving nothing', () => {
    for (const name of ['wait', 'mcp__agents__wait', 'mcp__veneer_browser__wait', 'list', 'mcp__agents__list_todos']) {
      expect(isPollingToolName(name)).toBe(true);
    }
    for (const name of ['Bash', 'shell', 'Agent', 'mcp__agents__handoff', 'file_change', 'WebFetch']) {
      expect(isPollingToolName(name)).toBe(false);
    }
  });

  it('names the reason it stopped the turn', () => {
    expect(turnTimeoutMessage('ceiling', 900_000, 21_600_000)).toContain('6 hours');
    expect(turnTimeoutMessage('inactivity', 900_000, 21_600_000)).toContain('15 minutes');
  });
});

describe('claude turns measure liveness, not elapsed time', () => {
  it('runs delegated agents in the foreground so nothing outlives the turn', async () => {
    process.env.FAKE_CLAUDE_MODE = 'spawn-env';
    const adapter = createClaudeAdapter({ claudeBin: FAKE_CLAUDE, turnTimeoutMs: 10_000, log: silent });
    const events: ConversationEvent[] = [];
    const handle = adapter.runTurn(
      { cwd: FIXTURES, nativeSessionId: 'fake-session', firstTurn: true, prompt: 'go', turnId: 't1' },
      (event) => events.push(event),
    );
    await handle.done;
    const output = events.find((event) => event.type === 'text_final');
    const summary = JSON.parse(output && output.type === 'text_final' ? output.markdown : '{}') as {
      disableBackgroundTasks: string | null;
    };

    expect(summary.disableBackgroundTasks).toBe('1');
  });

  it('leaves no delegated agent unresolved when the turn completes', async () => {
    // The gap this closes: a background subagent could still be 'running' when
    // the parent sent its final reply, so its result reached nobody.
    process.env.FAKE_CLAUDE_MODE = 'subagent';
    const adapter = createClaudeAdapter({ claudeBin: FAKE_CLAUDE, turnTimeoutMs: 10_000, log: silent });
    const events: ConversationEvent[] = [];
    const handle = adapter.runTurn(
      { cwd: FIXTURES, nativeSessionId: 'fake-session', firstTurn: true, prompt: 'go', turnId: 't1' },
      (event) => events.push(event),
    );
    await handle.done;

    const statuses = new Map<string, string>();
    for (const event of events) {
      if (event.type === 'subagent_started' || event.type === 'subagent_updated') {
        statuses.set(event.agentKey, event.status);
      }
    }
    expect(statuses.size).toBeGreaterThan(0);
    expect([...statuses.values()].every((status) => status === 'completed' || status === 'failed')).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'turn_done', outcome: 'completed' });
  });

  it('kills a turn that only polls, and spares one blocked on a real tool', async () => {
    process.env.FAKE_CLAUDE_MODE = 'poll-loop';
    // The idle window has to outlast the child's own startup: the watchdog is
    // armed when runTurn is called, but the fake CLI is a real node process,
    // and under the full suite it can take a second or more to print its first
    // line. A window shorter than that reaps the turn before it ever polls.
    const INACTIVITY_MS = 4_000;
    const polling = createClaudeAdapter({
      claudeBin: FAKE_CLAUDE,
      turnTimeoutMs: 60_000,
      turnInactivityMs: INACTIVITY_MS,
      log: silent,
    });
    const pollEvents: ConversationEvent[] = [];
    const pollHandle = polling.runTurn(
      { cwd: FIXTURES, nativeSessionId: 'fake-session', firstTurn: true, prompt: 'go', turnId: 't1' },
      (event) => pollEvents.push(event),
    );
    await pollHandle.done;
    expect(pollEvents.some((e) => e.type === 'tool_started' && e.toolName === 'mcp__agents__wait')).toBe(true);
    expect(pollEvents.some((e) => e.type === 'error' && e.message.includes('no activity'))).toBe(true);
    expect(pollEvents.at(-1)).toMatchObject({ type: 'turn_done', outcome: 'timed_out' });

    process.env.FAKE_CLAUDE_MODE = 'slow-tool';
    const blocked = createClaudeAdapter({
      claudeBin: FAKE_CLAUDE,
      turnTimeoutMs: 60_000,
      turnInactivityMs: INACTIVITY_MS,
      log: silent,
    });
    const slowEvents: ConversationEvent[] = [];
    const slowHandle = blocked.runTurn(
      { cwd: FIXTURES, nativeSessionId: 'fake-session', firstTurn: true, prompt: 'go', turnId: 't2' },
      (event) => slowEvents.push(event),
    );
    await waitFor(() => slowEvents.some((e) => e.type === 'tool_started'), 'the slow tool never started');
    // Idle for longer than the whole budget, measured from the moment the tool
    // started, with nothing else emitted: only the hold can keep this alive.
    await sleep(INACTIVITY_MS + 1_000);
    expect(slowEvents.some((e) => e.type === 'error')).toBe(false);
    slowHandle.kill();
    await slowHandle.done;
  }, 60_000);

  it('the ceiling still reaps a turn that never stops emitting', async () => {
    process.env.FAKE_CLAUDE_MODE = 'poll-loop';
    const adapter = createClaudeAdapter({
      claudeBin: FAKE_CLAUDE,
      turnTimeoutMs: 300,
      turnInactivityMs: 30_000,
      log: silent,
    });
    const events: ConversationEvent[] = [];
    const handle = adapter.runTurn(
      { cwd: FIXTURES, nativeSessionId: 'fake-session', firstTurn: true, prompt: 'go', turnId: 't1' },
      (event) => events.push(event),
    );
    await handle.done;
    expect(events.some((e) => e.type === 'error' && e.message.includes('limit'))).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'turn_done', outcome: 'timed_out' });
  });
});

describe('codex child lifecycle survives its parent turn', () => {
  it('takes a child terminal state from a wait call, and invents none', async () => {
    process.env.EMIT_COLLAB_WAIT = '1';
    const dir = tmpDir();
    const adapter = createCodexAdapter({ codexBin: FAKE_CODEX, turnTimeoutMs: 60_000, transcriptsDir: dir, log: silent });
    const events: ConversationEvent[] = [];
    const handle = adapter.runTurn(
      { cwd: dir, nativeSessionId: 't1', firstTurn: true, prompt: 'go', turnId: 'turn-1' },
      (event) => events.push(event),
    );
    await handle.done;

    const activity = events.filter((e) => e.type === 'subagent_started' || e.type === 'subagent_updated');
    // spawn → running, the silent wait adds nothing, the reporting wait ends it.
    expect(activity.map((e) => e.status)).toEqual(['running', 'completed']);
    expect(JSON.stringify(events)).not.toContain('waited-child-secret');
    expect(JSON.stringify(events)).not.toContain('raw child result');
  });
});

describe('grok cancellation distinguishes stopping from replacing', () => {
  function grokAdapter(dir: string) {
    return createGrokAdapter({
      grokBin: FAKE_GROK,
      turnTimeoutMs: 60_000,
      transcriptsDir: dir,
      log: silent,
      cancelCompletionTimeoutMs: 2_000,
      buildEnv: () => ({ ...process.env, GROK_HOME: path.join(dir, 'home') }),
    });
  }

  async function cancelParamsFor(reason: 'user' | 'send_now' | undefined): Promise<Record<string, unknown>> {
    process.env.AWAIT_CANCEL = '1';
    process.env.CANCEL_RESPONSE_DELAY_MS = '60';
    const dir = tmpDir();
    const requestLog = path.join(dir, 'requests.jsonl');
    process.env.REQUEST_LOG = requestLog;
    const adapter = grokAdapter(dir);
    const events: ConversationEvent[] = [];
    const handle = adapter.runTurn(
      { cwd: dir, nativeSessionId: 's1', firstTurn: true, prompt: 'go', turnId: 'turn-1' },
      (event) => events.push(event),
    );
    await waitFor(() => readLog(requestLog).some((r) => r.method === 'session/prompt'), 'no prompt');
    handle.kill(reason);
    await waitFor(() => readLog(requestLog).some((r) => r.method === 'session/cancel'), 'no cancel');
    await handle.done;
    return readLog(requestLog).find((r) => r.method === 'session/cancel')!.params;
  }

  it('keeps children running for "Send now" but abandons them on an explicit Stop', async () => {
    expect(await cancelParamsFor('send_now')).toEqual({ sessionId: 's1', cancelSubagents: false });
    expect(await cancelParamsFor('user')).toEqual({ sessionId: 's1', cancelSubagents: true });
    expect(await cancelParamsFor(undefined)).toEqual({ sessionId: 's1', cancelSubagents: true });
  });

  it('keeps children running when Veneer\'s own timeout fires', async () => {
    process.env.AWAIT_CANCEL = '1';
    process.env.CANCEL_RESPONSE_DELAY_MS = '60';
    const dir = tmpDir();
    const requestLog = path.join(dir, 'requests.jsonl');
    process.env.REQUEST_LOG = requestLog;
    const adapter = createGrokAdapter({
      grokBin: FAKE_GROK,
      turnTimeoutMs: 60_000,
      // Long enough that the fake ACP server is up and the session exists when
      // the window closes — otherwise there is no session to cancel and the
      // assertion below has nothing to read. (Real spawns take ~1s under the
      // full suite.)
      turnInactivityMs: 4_000,
      transcriptsDir: dir,
      log: silent,
      cancelCompletionTimeoutMs: 2_000,
      buildEnv: () => ({ ...process.env, GROK_HOME: path.join(dir, 'home') }),
    });
    const events: ConversationEvent[] = [];
    const handle = adapter.runTurn(
      { cwd: dir, nativeSessionId: 's1', firstTurn: true, prompt: 'go', turnId: 'turn-1' },
      (event) => events.push(event),
    );
    await handle.done;

    expect(events.some((e) => e.type === 'error' && e.message.includes('no activity'))).toBe(true);
    expect(readLog(requestLog).find((r) => r.method === 'session/cancel')?.params).toEqual({
      sessionId: 's1',
      cancelSubagents: false,
    });
  }, 60_000);

  it('reads child lifecycle off both spellings Grok uses', () => {
    expect(grokSubagentLifecycle('subagent_spawned', { subagentId: 'c1', description: 'Review the UI' })).toEqual({
      nativeId: 'c1',
      status: 'running',
      label: 'Review the UI',
    });
    expect(grokSubagentLifecycle('x.ai/subagent_finished', { subagent_id: 'c1' })).toEqual({
      nativeId: 'c1',
      status: 'completed',
    });
    expect(grokSubagentLifecycle('subagent_finished', { subagentId: 'c1', error: 'boom' })).toMatchObject({
      status: 'failed',
    });
    expect(grokSubagentLifecycle('agent_message_chunk', { subagentId: 'c1' })).toBeNull();
    expect(grokSubagentLifecycle('subagent_spawned', {})).toBeNull();
  });
});
