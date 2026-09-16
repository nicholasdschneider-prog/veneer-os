import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { loadConfig } from '../src/config.js';
import { buildAgentRuntime } from '../src/runtime/buildAgentRuntime.js';
import type { DopplerRuntime } from '../src/secrets/doppler.js';
import {
  createClaudeAccountFailover,
  createFailoverGuard,
  pickFailoverAccount,
  worstUsedPercent,
  failoverContinuationMessage,
  SWITCH_COOLDOWN_MS,
  type ClaudeSessionLimitEvent,
  type FailoverCandidate,
} from '../src/providers/claude/accountFailover.js';
import { createClaudeAdapter } from '../src/providers/claude/adapter.js';
import { createSecretStore } from '../src/secrets/store.js';
import { createUsageStore } from '../src/usage/store.js';
import type { ConversationEvent } from '../src/runtime/events.js';
import type { ConversationRow } from '../src/db/db.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const FAKE_CLAUDE = path.join(FIXTURES, 'fake-claude.mjs');
const silent = { warn: () => undefined, error: () => undefined };
const PROBE_RESULT = { probed: false, captured: 0, error: null };
const dirs: string[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-failover-'));
  dirs.push(dir);
  return dir;
}

function candidate(id: string, usedPercent: number | null): FailoverCandidate {
  return { id, label: id.toUpperCase(), usedPercent };
}

afterEach(() => {
  delete process.env.FAKE_CLAUDE_MODE;
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('claude failover — picking the account with the most headroom', () => {
  it('ranks by the worst window, so a fresh 5-hour meter cannot hide a spent week', () => {
    expect(
      worstUsedPercent([
        { rateLimitType: 'five_hour', utilization: 0.04 },
        { rateLimitType: 'seven_day', utilization: 0.71 },
        // Not a headroom window — ignored rather than mistaken for a meter.
        { rateLimitType: 'opus_something', utilization: 0.99 },
      ]),
    ).toBe(71);
    expect(worstUsedPercent([])).toBeNull();

    const picked = pickFailoverAccount([candidate('a', 71), candidate('b', 12), candidate('c', 40)]);
    expect(picked?.id).toBe('b');
  });

  it('skips anything past the 90% cutoff on either window', () => {
    expect(pickFailoverAccount([candidate('a', 91), candidate('b', 88)])?.id).toBe('b');
    // 90 exactly is still usable; 91 is not.
    expect(pickFailoverAccount([candidate('a', 91), candidate('b', 90)])?.id).toBe('b');
    expect(pickFailoverAccount([candidate('a', 91), candidate('b', 99)])).toBeNull();
  });

  it('skips excluded accounts — the one that just limited, and anything exhausted', () => {
    const all = [candidate('limited', 5), candidate('exhausted', 8), candidate('spare', 60)];
    expect(pickFailoverAccount(all, new Set(['limited', 'exhausted']))?.id).toBe('spare');
    expect(pickFailoverAccount(all, new Set(['limited', 'exhausted', 'spare']))).toBeNull();
  });

  it('prefers a measured account over one with no telemetry, but takes it over nothing', () => {
    expect(pickFailoverAccount([candidate('unknown', null), candidate('known', 85)])?.id).toBe('known');
    expect(pickFailoverAccount([candidate('unknown', null), candidate('spent', 95)])?.id).toBe('unknown');
  });
});

describe('claude failover — loop guard', () => {
  it('allows one switch per conversation per cooldown', () => {
    const guard = createFailoverGuard();
    const t0 = 1_000_000;
    expect(guard.canSwitch('c1', t0)).toBe(true);
    guard.noteSwitch('c1', t0);
    expect(guard.canSwitch('c1', t0 + 60_000)).toBe(false);
    // A different conversation has its own budget.
    expect(guard.canSwitch('c2', t0 + 60_000)).toBe(true);
    expect(guard.canSwitch('c1', t0 + SWITCH_COOLDOWN_MS)).toBe(true);
  });

  it('keeps a limited account out until its reset, then lets it back', () => {
    const guard = createFailoverGuard();
    const t0 = 1_000_000;
    guard.markExhausted('a', t0 + 5_000);
    // A later reset extends the exclusion; an earlier one never shortens it.
    guard.markExhausted('a', t0 + 1_000);
    expect([...guard.exhausted(t0)]).toEqual(['a']);
    expect([...guard.exhausted(t0 + 4_999)]).toEqual(['a']);
    expect([...guard.exhausted(t0 + 5_001)]).toEqual([]);
  });
});

/** Minimal stand-ins for the runner's manager + conversations table. */
function harness() {
  const dir = tmpDir();
  const secrets = createSecretStore(dir, {});
  const usage = createUsageStore(dir, { activeAccountId: () => secrets.activeClaudeAccountId() });
  const a = secrets.addClaudeAccount({ token: 'sk-ant-oat01-A', email: 'a@example.com', label: 'Account A' });
  const b = secrets.addClaudeAccount({ token: 'sk-ant-oat01-B', email: 'b@example.com', label: 'Account B' });
  secrets.setActiveClaudeAccount(a.id);
  const conv = { id: 'conv-1', user_id: 1, provider: 'claude' } as unknown as ConversationRow;
  const db = { prepare: () => ({ get: (id: string) => (id.startsWith('conv-') ? { ...conv, id } : undefined) }) } as unknown as Database.Database;
  const notices: string[] = [];
  const delivered: { conversationId: string; text: string; wakeupId: string }[] = [];
  const bus = new EventEmitter();
  bus.on('event', (_id: string, event: ConversationEvent) => {
    if (event.type === 'notice') notices.push(event.message);
  });
  const manager = {
    bus,
    deliverWakeup: (_conv: ConversationRow, text: string, wakeupId: string) => {
      delivered.push({ conversationId: _conv.id, text, wakeupId });
      return { messageId: delivered.length, disposition: 'queued' as const, queue: { messages: [] } };
    },
  };
  return { dir, secrets, usage, db, manager, notices, delivered, accountA: a, accountB: b, conv };
}

// The wording current Claude Code builds emit: a local IANA zone, not UTC.
const RESET_TEXT = "You've hit your session limit · resets 6:50pm (America/Indianapolis)";

function limitEvent(overrides: Partial<ClaudeSessionLimitEvent> = {}): ClaudeSessionLimitEvent {
  return { conversationId: 'conv-1', accountId: null, text: RESET_TEXT, at: new Date(), ...overrides };
}

describe('claude failover — detect, switch, continue', () => {
  it('switches to the account with headroom and asks the chat to resume', async () => {
    const h = harness();
    h.usage.recordClaudeFor(h.accountA.id, { rateLimitType: 'five_hour', utilization: 1, resetsAt: null, status: 'rejected' }, 'probe');
    h.usage.recordClaudeFor(h.accountB.id, { rateLimitType: 'five_hour', utilization: 0.1, resetsAt: null, status: 'allowed' }, 'probe');
    const failover = createClaudeAccountFailover({ ...h, log: silent });

    await failover.handleSessionLimit(limitEvent({ accountId: h.accountA.id }));

    expect(h.secrets.activeClaudeAccountId()).toBe(h.accountB.id);
    expect(h.notices).toEqual(['Session limit hit on Account A. Switched to Account B, continuing.']);
    expect(h.delivered).toHaveLength(1);
    // The notice is live-only; the durable message must carry the facts itself.
    expect(h.delivered[0]!.text).toBe(
      'Continue where you left off; the previous turn was cut off by a Claude usage limit on '
        + 'Account A. Veneer switched to Account B.',
    );
  });

  it('leaves the account alone when nothing qualifies, and never switches twice in the window', async () => {
    const h = harness();
    h.usage.recordClaudeFor(h.accountB.id, { rateLimitType: 'seven_day', utilization: 0.97, resetsAt: null, status: null }, 'probe');
    const failover = createClaudeAccountFailover({ ...h, log: silent });

    await failover.handleSessionLimit(limitEvent({ accountId: h.accountA.id }));
    expect(h.secrets.activeClaudeAccountId()).toBe(h.accountA.id);
    expect(h.delivered).toEqual([]);

    // B frees up, but A is still exhausted and the chat may switch once more
    // (the earlier attempt never spent its budget because it never switched).
    h.usage.recordClaudeFor(h.accountB.id, { rateLimitType: 'seven_day', utilization: 0.2, resetsAt: null, status: null }, 'probe');
    await failover.handleSessionLimit(limitEvent({ accountId: h.accountA.id }));
    expect(h.secrets.activeClaudeAccountId()).toBe(h.accountB.id);

    // Now the cooldown bites: a second limit in the same chat changes nothing.
    await failover.handleSessionLimit(limitEvent({ accountId: h.accountB.id }));
    expect(h.secrets.activeClaudeAccountId()).toBe(h.accountB.id);
    expect(h.delivered).toHaveLength(1);
  });

  it('never switches back to the account that just limited', async () => {
    const h = harness();
    h.usage.recordClaudeFor(h.accountA.id, { rateLimitType: 'five_hour', utilization: 0.01, resetsAt: null, status: null }, 'probe');
    h.usage.recordClaudeFor(h.accountB.id, { rateLimitType: 'five_hour', utilization: 0.5, resetsAt: null, status: null }, 'probe');
    const failover = createClaudeAccountFailover({ ...h, log: silent });

    // A's meters look empty (stale telemetry) but A is the one that limited.
    await failover.handleSessionLimit(limitEvent({ accountId: h.accountA.id }));
    expect(h.secrets.activeClaudeAccountId()).toBe(h.accountB.id);
  });

  it('only continues when another chat already switched the global account', async () => {
    const h = harness();
    const failover = createClaudeAccountFailover({ ...h, log: silent });
    h.secrets.setActiveClaudeAccount(h.accountB.id); // another conversation got there first

    await failover.handleSessionLimit(limitEvent({ accountId: h.accountA.id }));

    expect(h.secrets.activeClaudeAccountId()).toBe(h.accountB.id);
    expect(h.notices).toEqual(['Session limit hit on Account A. Already on Account B, continuing.']);
    expect(h.delivered).toHaveLength(1);
    expect(h.delivered[0]!.text).toBe(
      'Continue where you left off; the previous turn was cut off by a Claude usage limit on '
        + 'Account A. Veneer is already on Account B.',
    );
  });

  it('switches once for simultaneous chats and continues every affected chat once', async () => {
    const h = harness();
    const gate = Promise.withResolvers<void>();
    const probe = { refreshIfStale: async () => { await gate.promise; return PROBE_RESULT; } };
    const switchAccount = vi.spyOn(h.secrets, 'setActiveClaudeAccount');
    const failover = createClaudeAccountFailover({ ...h, probe, log: silent });
    const pending = Array.from({ length: 20 }, (_, index) => failover.handleSessionLimit(
      limitEvent({ conversationId: `conv-${index}`, accountId: h.accountA.id }),
    ));
    // A duplicate callback waiting on the same probe must not enqueue twice.
    pending.push(failover.handleSessionLimit(limitEvent({ accountId: h.accountA.id })));
    gate.resolve();
    await Promise.all(pending);
    expect(switchAccount).toHaveBeenCalledTimes(1);
    expect(h.delivered).toHaveLength(20);
    expect(new Set(h.delivered.map((item) => item.conversationId)).size).toBe(20);
    expect(h.notices.filter((text) => text.includes('Already on'))).toHaveLength(19);
  });

  it('reuses the account switched during the probe even if another account ranks better', async () => {
    const h = harness();
    const c = h.secrets.addClaudeAccount({ token: 'test-C', label: 'Account C' });
    h.usage.recordClaudeFor(h.accountB.id, { rateLimitType: 'five_hour', utilization: 0.6 }, 'probe');
    h.usage.recordClaudeFor(c.id, { rateLimitType: 'five_hour', utilization: 0.1 }, 'probe');
    const gate = Promise.withResolvers<void>();
    const failover = createClaudeAccountFailover({
      ...h, probe: { refreshIfStale: async () => { await gate.promise; return PROBE_RESULT; } }, log: silent,
    });
    const pending = failover.handleSessionLimit(limitEvent({ accountId: h.accountA.id }));
    h.secrets.setActiveClaudeAccount(h.accountB.id);
    gate.resolve();
    await pending;
    expect(h.secrets.activeClaudeAccountId()).toBe(h.accountB.id);
    expect(h.delivered[0]?.text).toBe(failoverContinuationMessage('Account A', 'Account B', true));
  });

  it('does not continue onto an already-switched account that also hit its limit', async () => {
    const h = harness();
    const guard = createFailoverGuard();
    const gate = Promise.withResolvers<void>();
    const failover = createClaudeAccountFailover({
      ...h, guard, probe: { refreshIfStale: async () => { await gate.promise; return PROBE_RESULT; } }, log: silent,
    });
    const pending = failover.handleSessionLimit(limitEvent({ accountId: h.accountA.id }));
    h.secrets.setActiveClaudeAccount(h.accountB.id);
    // A different chat reports B exhausted while A's handler is probing.
    guard.markExhausted(h.accountB.id, Date.now() + 60_000);
    gate.resolve();
    await pending;
    expect(h.delivered).toEqual([]);
    const c = h.secrets.addClaudeAccount({ token: 'test-C', label: 'Account C' });
    await failover.handleSessionLimit(limitEvent({ accountId: h.accountA.id }));
    expect(h.secrets.activeClaudeAccountId()).toBe(c.id);
    expect(h.delivered).toHaveLength(1);
  });

  it('rejects an already-switched account without headroom and tolerates a failed probe', async () => {
    const h = harness();
    h.secrets.setActiveClaudeAccount(h.accountB.id);
    h.usage.recordClaudeFor(h.accountB.id, { rateLimitType: 'five_hour', utilization: 1 }, 'probe');
    const c = h.secrets.addClaudeAccount({ token: 'test-C', label: 'Account C' });
    const failover = createClaudeAccountFailover({
      ...h, probe: { refreshIfStale: async () => { throw new Error('offline'); } }, log: silent,
    });
    await failover.handleSessionLimit(limitEvent({ accountId: h.accountA.id }));
    expect(h.secrets.activeClaudeAccountId()).toBe(c.id);
    expect(h.delivered).toHaveLength(1);
  });

  it('constructs a runtime with recovery wired and attributes late usage to the spawn account', async () => {
    const h = harness();
    const db = new Database(':memory:');
    migrate(db, path.join(FIXTURES, '../../src/db/migrations'));
    db.prepare("INSERT INTO users (id, email, display_name, role) VALUES (1, 'test@example.com', 'Test', 'owner')").run();
    db.prepare(`INSERT INTO conversations (id, assistant_id, user_id, title, provider, native_session_id, channel)
      VALUES ('conv-1', 1, 1, 'Limit test', 'claude', 'fake-session', 'web')`).run();
    const config = loadConfig({ VP_IDENTITY: 'dev', DATA_DIR: h.dir, VP_SOURCE_DIR: path.join(h.dir, 'source'), VP_CLAUDE_BIN: FAKE_CLAUDE });
    const probe = { refreshIfStale: vi.fn(async () => PROBE_RESULT) };
    const runtime = buildAgentRuntime({
      config, db, secrets: h.secrets, usage: h.usage, claudeProbe: probe,
      doppler: { get: () => null } as unknown as DopplerRuntime,
    });
    const deliver = vi.spyOn(runtime.manager, 'deliverWakeup').mockImplementation(h.manager.deliverWakeup);
    try {
      process.env.FAKE_CLAUDE_MODE = 'session-limit';
      const turn = runtime.adapters.claude!.runTurn({
        cwd: FIXTURES, conversationId: 'conv-1', nativeSessionId: 'fake-session', firstTurn: true, prompt: 'go', turnId: 'runtime-limit',
      }, () => undefined);
      h.secrets.setActiveClaudeAccount(h.accountB.id);
      await turn.done;
      await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
      expect(probe.refreshIfStale).toHaveBeenCalled();
      expect(h.delivered[0]?.text).toBe(failoverContinuationMessage('Account A', 'Account B', true));
      expect(h.usage.claudeSnapshotsFor(h.accountA.id)).toEqual([
        expect.objectContaining({ rateLimitType: 'five_hour', utilization: 1 }),
      ]);
      expect(h.usage.claudeSnapshotsFor(h.accountB.id)).toEqual([]);
    } finally {
      runtime.manager.shutdown();
      db.close();
    }
  });

  it('is driven by a real 429 turn — and only by a 429 turn', async () => {
    const h = harness();
    h.usage.recordClaudeFor(h.accountB.id, { rateLimitType: 'five_hour', utilization: 0.1, resetsAt: null, status: null }, 'probe');
    const failover = createClaudeAccountFailover({ ...h, log: silent });
    const seen: ClaudeSessionLimitEvent[] = [];
    const adapter = createClaudeAdapter({
      claudeBin: FAKE_CLAUDE,
      turnTimeoutMs: 10_000,
      log: silent,
      getAccountId: () => h.secrets.activeClaudeAccountId(),
      onSessionLimit: (event) => {
        seen.push(event);
        void failover.handleSessionLimit(event);
      },
    });

    process.env.FAKE_CLAUDE_MODE = 'plain-failure';
    const events: ConversationEvent[] = [];
    await adapter.runTurn(
      { cwd: FIXTURES, conversationId: 'conv-1', nativeSessionId: 'fake-session', firstTurn: true, prompt: 'go', turnId: 't0' },
      (event) => events.push(event),
    ).done;
    expect(events.some((event) => event.type === 'turn_done' && event.outcome === 'failed')).toBe(true);
    expect(seen).toEqual([]); // an ordinary failure must never move accounts

    process.env.FAKE_CLAUDE_MODE = 'session-limit';
    await adapter.runTurn(
      { cwd: FIXTURES, conversationId: 'conv-1', nativeSessionId: 'fake-session', firstTurn: true, prompt: 'go', turnId: 't1' },
      () => undefined,
    ).done;

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ conversationId: 'conv-1', accountId: h.accountA.id });
    // The handler runs on the adapter's callback; give its microtasks a tick.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(h.secrets.activeClaudeAccountId()).toBe(h.accountB.id);
    expect(h.delivered[0]?.text).toBe(failoverContinuationMessage('Account A', 'Account B'));
  });
});
