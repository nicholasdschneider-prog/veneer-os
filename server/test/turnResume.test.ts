import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import type { ConversationRow } from '../src/db/db.js';
import { createConversationManager } from '../src/runtime/conversationManager.js';
import { resolveAgentTokenContext } from '../src/runtime/agentTokens.js';
import type {
  CompactSessionResult,
  CompactSessionSpec,
  ProviderAdapter,
  SteerDelivery,
  TurnSpec,
} from '../src/providers/types.js';
import type { ConversationEvent, ConversationQueueSnapshot, TurnOutcome } from '../src/runtime/events.js';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/db/migrations');
const flush = () => new Promise((r) => setImmediate(r));

function openTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db, MIGRATIONS);
  db.prepare("INSERT INTO users (email, display_name, role) VALUES ('owner@example.com', 'Sam', 'owner')").run();
  db.prepare(
    `INSERT INTO conversations (id, assistant_id, user_id, title, provider, native_session_id, channel)
     VALUES ('conv-1', 1, 1, 'Test', 'claude', 'sid-1', 'web')`,
  ).run();
  return db;
}

/**
 * Records each runTurn's prompt + whether it spawned as a first turn. A turn
 * only "completes" when the test drives it: finish() produces content (so it
 * establishes the session) then ends; fail() errors before any content/session
 * then ends (models a turn that died before the API round trip).
 */
type SteerOutcome = boolean | SteerDelivery;
/** `echo` emits the synthetic turn_started the real adapter emits on replay. */
type SteerFactory = (ctx: { text: string; echo: () => void }) => SteerOutcome;

function recordingAdapter({
  steerResult = true,
  supportsSteer = true,
  compaction = false,
  provider = 'claude',
  transcript = [],
}: {
  steerResult?: SteerOutcome | SteerFactory;
  supportsSteer?: boolean;
  compaction?: boolean;
  provider?: 'claude' | 'codex' | 'grok';
  transcript?: ConversationEvent[];
} = {}) {
  const runs: {
    prompt: string;
    displayPrompt: string | null;
    firstTurn: boolean;
    dangerous: boolean;
    developerInstructions: string | null;
    refreshDeveloperInstructions: boolean;
    establish: () => void;
    finish: () => void;
    recover: () => void;
    endWith: (outcome: TurnOutcome) => void;
    fail: () => void;
  }[] = [];
  const steers: string[] = [];
  /** What reason each interrupt reached the provider with. */
  const killReasons: string[] = [];
  const compactions: {
    spec: CompactSessionSpec;
    resolve: (result: CompactSessionResult) => void;
    reject: (err: Error) => void;
  }[] = [];
  const adapter: ProviderAdapter = {
    id: provider,
    mintSessionId: () => 'sid',
    runTurn(spec: TurnSpec, onEvent) {
      let resolveDone!: () => void;
      const done = new Promise<void>((r) => (resolveDone = r));
      runs.push({
        prompt: spec.prompt,
        displayPrompt: spec.displayPrompt ?? null,
        firstTurn: spec.firstTurn,
        dangerous: spec.dangerous ?? false,
        developerInstructions: spec.developerInstructions ?? null,
        refreshDeveloperInstructions: spec.refreshDeveloperInstructions ?? false,
        // Produce content (the API round trip → the session file now exists on
        // disk) but do NOT end the turn: models a turn interrupted by a
        // ship/restart/crash before handle.done ever runs.
        establish: () => {
          onEvent({ type: 'text_final', turnId: spec.turnId, markdown: 'answer', at: '2026-01-01T00:00:00Z' } as ConversationEvent);
        },
        finish: () => {
          onEvent({ type: 'text_final', turnId: spec.turnId, markdown: 'answer', at: '2026-01-01T00:00:00Z' } as ConversationEvent);
          onEvent({ type: 'turn_done', turnId: spec.turnId } as ConversationEvent);
          resolveDone();
        },
        recover: () => {
          onEvent({ type: 'error', message: 'temporary provider problem', fatal: false } as ConversationEvent);
          onEvent({ type: 'text_final', turnId: spec.turnId, markdown: 'recovered answer', at: '2026-01-01T00:00:00Z' } as ConversationEvent);
          onEvent({ type: 'turn_done', turnId: spec.turnId, outcome: 'completed' } as ConversationEvent);
          resolveDone();
        },
        endWith: (outcome) => {
          onEvent({ type: 'turn_done', turnId: spec.turnId, outcome } as ConversationEvent);
          resolveDone();
        },
        fail: () => {
          onEvent({ type: 'error', message: 'died before the round trip', fatal: true } as ConversationEvent);
          onEvent({ type: 'turn_done', turnId: spec.turnId } as ConversationEvent);
          resolveDone();
        },
      });
      return {
        done,
        kill: (reason?: string) => {
          killReasons.push(reason ?? 'user');
          resolveDone();
        },
        ...(supportsSteer
          ? {
              steer: async (text: string): Promise<SteerOutcome> => {
                steers.push(text);
                const echo = (): void => {
                  onEvent({
                    type: 'turn_started',
                    turnId: spec.turnId,
                    role: 'user',
                    text,
                    at: '2026-01-01T00:00:00Z',
                    via: 'web',
                  });
                };
                if (typeof steerResult === 'function') return steerResult({ text, echo });
                if (steerResult === true) echo();
                return steerResult;
              },
            }
          : {}),
        respondToApproval: () => true,
      };
    },
    readTranscript: async () => transcript,
    ...(compaction
      ? {
          compactSession(spec: CompactSessionSpec) {
            let resolve!: (result: CompactSessionResult) => void;
            let reject!: (err: Error) => void;
            const done = new Promise<CompactSessionResult>((res, rej) => {
              resolve = res;
              reject = rej;
            });
            compactions.push({ spec, resolve, reject });
            return { done, kill: () => reject(new Error('interrupted')) };
          },
        }
      : {}),
  };
  return { adapter, runs, steers, killReasons, compactions };
}

/**
 * A steer whose write landed but whose replay has not arrived: the manager must
 * report delivery without dropping the durable fallback.
 */
function pendingDeliveries() {
  const deliveries: { text: string; acknowledge: (accepted: boolean) => void }[] = [];
  const factory: SteerFactory = ({ text, echo }) => {
    let settle!: (accepted: boolean) => void;
    const acknowledged = new Promise<boolean>((resolve) => (settle = resolve));
    deliveries.push({
      text,
      acknowledge: (accepted) => {
        if (accepted) echo();
        settle(accepted);
      },
    });
    return { delivered: true, acknowledged };
  };
  return { factory, deliveries };
}

function makeManager(
  db: Database.Database,
  adapter: ProviderAdapter,
  captureMemoryTurn?: (conv: ConversationRow, events: ConversationEvent[]) => Promise<void>,
  fullAccess = false,
  steerAckWaitMs?: number,
) {
  return createConversationManager({
    db,
    adapters: { [adapter.id]: adapter },
    resolveWorkspace: () => ({ workspaceDir: '/tmp', assistantSlug: 'assistant', elevated: false, fullAccess }),
    captureMemoryTurn,
    ...(steerAckWaitMs === undefined ? {} : { steerAckWaitMs }),
    log: { warn: () => undefined, error: () => undefined },
  });
}

describe('turn auto-resume', () => {
  let db: Database.Database;
  let conv: ConversationRow;
  beforeEach(() => {
    db = openTestDb();
    conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get('conv-1') as ConversationRow;
  });

  it('records a pending turn on start and clears it when the turn completes', async () => {
    const { adapter, runs } = recordingAdapter();
    const m = makeManager(db, adapter);
    m.postMessage(conv, 'do the thing');
    expect(db.prepare('SELECT * FROM pending_turns').all()).toHaveLength(1);
    runs[0]!.finish();
    await flush();
    expect(db.prepare('SELECT * FROM pending_turns').all()).toHaveLength(0);
  });

  it('binds toolbox materialization and agent callbacks to the initiating user', async () => {
    db.prepare(
      "INSERT INTO users (id, email, display_name, role) VALUES (2, 'member@example.com', 'Member', 'member')",
    ).run();
    const { adapter } = recordingAdapter();
    const materialized: Array<{ actorUserId: number; tokenEmail: string | null }> = [];
    const manager = createConversationManager({
      db,
      adapters: { claude: adapter },
      resolveWorkspace: () => ({ workspaceDir: '/tmp', assistantSlug: 'assistant', elevated: false }),
      materialize: (_target, token, _conversationId, actorUserId) => {
        materialized.push({
          actorUserId,
          tokenEmail: resolveAgentTokenContext(db, token)?.email ?? null,
        });
        return {
          mcpConfigPath: null,
          settingsPath: null,
          developerInstructions: '# Core Veneer rules',
          instructionHash: 'actor-test',
        };
      },
      log: { warn: () => undefined, error: () => undefined },
    });

    manager.postMessage(conv, 'member turn', 2);
    await flush();

    expect(materialized).toEqual([{ actorUserId: 2, tokenEmail: 'member@example.com' }]);
    expect(db.prepare('SELECT actor_user_id FROM pending_turns WHERE conversation_id = ?').get(conv.id))
      .toEqual({ actor_user_id: 2 });
  });

  it('passes the selected agent Full Access setting to the provider', () => {
    const normal = recordingAdapter();
    makeManager(db, normal.adapter).postMessage(conv, 'normal turn');
    expect(normal.runs[0]?.dangerous).toBe(false);

    const full = recordingAdapter();
    makeManager(db, full.adapter, undefined, true).postMessage(conv, 'full access turn');
    expect(full.runs[0]?.dangerous).toBe(true);
  });

  it.each(['codex', 'grok'] as const)('supplies required developer context and refreshes a resumed %s thread once', async (provider) => {
    db.prepare("UPDATE conversations SET provider = ?, provider_instruction_hash = 'old-hash' WHERE id = 'conv-1'").run(provider);
    db.prepare("INSERT INTO settings (key, value_json) VALUES ('turn_ran:conv-1', 'true')").run();
    const resumedConv = db.prepare("SELECT * FROM conversations WHERE id = 'conv-1'").get() as ConversationRow;
    const { adapter, runs } = recordingAdapter({ provider });
    const manager = makeManager(db, adapter);
    manager.postMessage(resumedConv, 'resume safely');

    expect(runs[0]?.firstTurn).toBe(false);
    expect(runs[0]?.developerInstructions).toContain('# Core Veneer rules');
    expect(runs[0]?.developerInstructions).toContain('# Fixed chat context');
    expect(runs[0]?.developerInstructions).toContain('veneer-jev');
    expect(runs[0]?.refreshDeveloperInstructions).toBe(true);
    runs[0]!.establish();
    const stored = db.prepare("SELECT provider_instruction_hash FROM conversations WHERE id = 'conv-1'").get() as {
      provider_instruction_hash: string | null;
    };
    expect(stored.provider_instruction_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(stored.provider_instruction_hash).not.toBe('old-hash');
    runs[0]!.finish();
    await flush();
    manager.postMessage(resumedConv, 'continue');
    expect(runs[1]?.refreshDeveloperInstructions).toBe(false);
    runs[1]!.finish();
  });

  it('keeps marked skill turns visible while sending Codex native syntax', () => {
    db.prepare("UPDATE conversations SET provider = 'codex' WHERE id = 'conv-1'").run();
    const codexConv = db.prepare("SELECT * FROM conversations WHERE id = 'conv-1'").get() as ConversationRow;
    const { adapter, runs } = recordingAdapter({ provider: 'codex' });
    const manager = makeManager(db, adapter);
    const events: ConversationEvent[] = [];
    manager.bus.on('event', (_conversationId, event) => events.push(event));
    const stored = '/review this\n\n<!-- veneer-skill:review -->';

    manager.postMessage(codexConv, stored);

    expect(runs[0]?.prompt).toBe('$review this');
    expect(runs[0]?.displayPrompt).toBe('/review this');
    expect(events).toContainEqual(expect.objectContaining({ type: 'turn_started', text: '/review this' }));
    expect(db.prepare("SELECT prompt FROM pending_turns WHERE conversation_id = 'conv-1'").get())
      .toEqual({ prompt: stored });
  });

  it('captures successful turns asynchronously but skips failed turns', async () => {
    const { adapter, runs } = recordingAdapter();
    const captured: ConversationEvent[][] = [];
    const m = makeManager(db, adapter, async (_conversation, events) => {
      captured.push(events);
    });
    m.postMessage(conv, 'remember this');
    runs[0]!.finish();
    await flush();
    expect(captured).toHaveLength(1);
    expect(captured[0]).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'turn_started', text: 'remember this' }),
      expect.objectContaining({ type: 'text_final', markdown: 'answer' }),
    ]));

    m.postMessage(conv, 'do not capture this failed turn');
    runs[1]!.fail();
    await flush();
    expect(captured).toHaveLength(1);
  });

  it('clears live failure status when a turn recovers and explicitly completes', async () => {
    const { adapter, runs } = recordingAdapter();
    const captured: ConversationEvent[][] = [];
    const manager = makeManager(db, adapter, async (_conversation, events) => {
      captured.push(events);
    });

    manager.postMessage(conv, 'recover after restart');
    runs[0]!.recover();
    await flush();

    expect(manager.statusOf(conv.id)).toBe('idle');
    // Error-bearing turns remain ineligible for automatic memory capture even
    // when the provider ultimately completes them.
    expect(captured).toHaveLength(0);
  });

  it.each(['failed', 'timed_out'] as const)('keeps live failure status for an explicit %s outcome', async (outcome) => {
    const { adapter, runs } = recordingAdapter();
    const manager = makeManager(db, adapter);

    manager.postMessage(conv, 'fail conclusively');
    runs[0]!.endWith(outcome);
    await flush();

    expect(manager.statusOf(conv.id)).toBe('failed');
  });

  it('continues the chat when automatic memory capture fails', async () => {
    const { adapter, runs } = recordingAdapter();
    const m = makeManager(db, adapter, async () => {
      throw new Error('both memory curator providers are unavailable');
    });

    m.postMessage(conv, 'first successful chat turn');
    runs[0]!.finish();
    await flush();

    m.postMessage(conv, 'second chat turn');
    expect(runs.map((run) => run.prompt)).toEqual([
      'first successful chat turn',
      'second chat turn',
    ]);
  });

  it('re-runs an interrupted turn at boot (simulated restart)', () => {
    // Manager A starts a turn but the process "dies" mid-turn (never finished),
    // so the pending row survives.
    const a = recordingAdapter();
    makeManager(db, a.adapter).postMessage(conv, 'build the feature');
    expect(a.runs).toHaveLength(1);
    expect(db.prepare('SELECT prompt, attempts FROM pending_turns WHERE conversation_id = ?').get('conv-1')).toMatchObject(
      { prompt: 'build the feature', attempts: 1 },
    );

    // Reboot: a fresh manager on the same DB resumes it once the API is up.
    const b = recordingAdapter();
    const mB = makeManager(db, b.adapter);
    expect(b.runs).toHaveLength(0); // nothing runs until resume is invoked
    mB.resumeInterruptedTurns();
    expect(b.runs.map((r) => r.prompt)).toEqual(['build the feature']);
    expect(
      (db.prepare('SELECT attempts FROM pending_turns WHERE conversation_id = ?').get('conv-1') as { attempts: number })
        .attempts,
    ).toBe(2); // the re-run bumped the attempt counter
  });

  it('pauses an exhausted turn without losing it, then lets the user retry', () => {
    db.prepare('INSERT INTO pending_turns (conversation_id, prompt, attempts) VALUES (?, ?, ?)').run(
      'conv-1',
      'looping turn',
      3,
    );
    const { adapter, runs } = recordingAdapter();
    const manager = makeManager(db, adapter);
    manager.resumeInterruptedTurns();
    expect(runs).toHaveLength(0);
    expect(db.prepare('SELECT prompt, attempts, status, error FROM pending_turns').get()).toMatchObject({
      prompt: 'looping turn',
      attempts: 3,
      status: 'failed',
    });
    expect(manager.statusOf('conv-1')).toBe('failed');

    expect(manager.retryFailedTurn(conv).ok).toBe(true);
    expect(runs.map((run) => run.prompt)).toEqual(['looping turn']);
    expect(db.prepare('SELECT attempts, status FROM pending_turns').get()).toMatchObject({ attempts: 1, status: 'pending' });
  });

  // ── BUG 4: first-turn flag must only flip once the session actually exists ──
  it('keeps creating (not resuming) the session when a turn dies before the round trip', async () => {
    const { adapter, runs } = recordingAdapter();
    const m = makeManager(db, adapter);
    m.postMessage(conv, 'first attempt');
    expect(runs[0]!.firstTurn).toBe(true); // brand-new session → --session-id
    runs[0]!.fail(); // errored before any content / session id
    await flush();
    // The session was never established, so the next turn must STILL create it —
    // resuming a session that doesn't exist would 404 forever (the bug).
    m.postMessage(conv, 'second attempt');
    expect(runs[1]!.firstTurn).toBe(true);
  });

  it('switches to --resume once a turn establishes the session', async () => {
    const { adapter, runs } = recordingAdapter();
    const m = makeManager(db, adapter);
    m.postMessage(conv, 'first');
    expect(runs[0]!.firstTurn).toBe(true);
    runs[0]!.finish(); // produced content → session established
    await flush();
    m.postMessage(conv, 'second');
    expect(runs[1]!.firstTurn).toBe(false); // now the session is resumable
  });

  // ── Regression: a ship/restart mid-turn must --resume, not re-create ──
  // The session file exists on disk the moment the round trip produces content,
  // but handle.done never runs when the process is killed. If isFirstTurn stays
  // true the resumed turn re-uses --session-id → "Session ID … is already in use".
  it('resumes with --resume after a restart that killed a turn post-round-trip', () => {
    // Manager A: turn establishes the session (content streamed), then the
    // process dies before completing — the pending row survives.
    const a = recordingAdapter();
    makeManager(db, a.adapter).postMessage(conv, 'add usage tracking');
    expect(a.runs[0]!.firstTurn).toBe(true); // brand-new session → --session-id
    a.runs[0]!.establish(); // API round trip happened; session file now exists
    // (no finish/done — the ship restart tore the process down here)

    // Reboot: a fresh manager on the same DB resumes the interrupted turn.
    const b = recordingAdapter();
    const mB = makeManager(db, b.adapter);
    mB.resumeInterruptedTurns();
    expect(b.runs.map((r) => r.prompt)).toEqual(['add usage tracking']);
    expect(b.runs[0]!.firstTurn).toBe(false); // --resume, not --session-id
  });

  // ── BUG 11: messages queued behind an in-flight turn survive a restart ──
  it('persists a queued message and replays it in order after resume on restart', async () => {
    db.prepare(
      "INSERT INTO users (id, email, display_name, role) VALUES (2, 'member@example.com', 'Member', 'member')",
    ).run();
    const a = recordingAdapter();
    const mA = makeManager(db, a.adapter);
    const agentOrigin = {
      kind: 'agent' as const,
      from: 'Researcher',
      to: 'Writer',
      sourceConversationId: 'research-chat',
      sourceConversationTitle: 'Market research',
    };
    mA.postMessage(conv, 'first turn', 2); // runs immediately
    mA.postMessage(conv, 'queued turn', 1, agentOrigin); // waits behind it
    expect(a.runs.map((r) => r.prompt)).toEqual(['first turn']);
    // The waiting message is durable; the running one has been shifted out.
    expect(db.prepare('SELECT prompt, actor_user_id, origin_json FROM queued_messages').all())
      .toMatchObject([{ prompt: 'queued turn', actor_user_id: 1, origin_json: JSON.stringify(agentOrigin) }]);
    expect(db.prepare('SELECT prompt, actor_user_id FROM pending_turns').get())
      .toMatchObject({ prompt: 'first turn', actor_user_id: 2 });

    // Reboot: a fresh manager on the same DB (the in-memory queue is gone).
    const b = recordingAdapter();
    const mB = makeManager(db, b.adapter);
    const replayed: ConversationEvent[] = [];
    mB.bus.on('event', (_conversationId, event: ConversationEvent) => replayed.push(event));
    mB.resumeInterruptedTurns();
    expect(b.runs.map((r) => r.prompt)).toEqual(['first turn']); // interrupted turn resumes first
    expect(db.prepare('SELECT actor_user_id FROM pending_turns').get()).toEqual({ actor_user_id: 2 });
    b.runs[0]!.finish();
    await flush();
    // Completing it drains the durably-queued message next, in FIFO order.
    expect(b.runs.map((r) => r.prompt)).toEqual(['first turn', 'queued turn']);
    expect(db.prepare('SELECT actor_user_id, origin_json FROM pending_turns').get()).toEqual({
      actor_user_id: 1,
      origin_json: JSON.stringify(agentOrigin),
    });
    expect(replayed).toContainEqual(expect.objectContaining({
      type: 'turn_started',
      text: 'queued turn',
      origin: agentOrigin,
    }));
    expect(db.prepare('SELECT * FROM queued_messages').all()).toHaveLength(0);
  });

  it('drops a durable queue row when its message is shifted into a turn', async () => {
    const { adapter } = recordingAdapter();
    const m = makeManager(db, adapter);
    m.postMessage(conv, 'runs now'); // shifted into a turn immediately
    expect(db.prepare('SELECT * FROM queued_messages').all()).toHaveLength(0);
  });

  it('does not inherit the chat creator’s connectors when a queued actor was deleted', async () => {
    db.prepare(
      "INSERT INTO users (id, email, display_name, role) VALUES (2, 'former@example.com', 'Former', 'member')",
    ).run();
    const first = recordingAdapter();
    const beforeRestart = makeManager(db, first.adapter);
    beforeRestart.postMessage(conv, 'owner turn', 1);
    beforeRestart.postMessage(conv, 'former member turn', 2);
    db.prepare('DELETE FROM users WHERE id = 2').run();
    expect(db.prepare('SELECT actor_user_id FROM queued_messages').get()).toEqual({ actor_user_id: null });

    const second = recordingAdapter();
    const afterRestart = makeManager(db, second.adapter);
    afterRestart.resumeInterruptedTurns();
    second.runs[0]!.finish();
    await flush();

    expect(second.runs.map((run) => run.prompt)).toEqual(['owner turn', 'former member turn']);
    expect(db.prepare('SELECT actor_user_id FROM pending_turns').get()).toEqual({ actor_user_id: null });
  });

  it('exposes, edits, removes, and durably reorders waiting messages', async () => {
    db.prepare(
      "INSERT INTO users (id, email, display_name, role) VALUES (2, 'member@example.com', 'Member', 'member')",
    ).run();
    const { adapter, runs } = recordingAdapter();
    const manager = makeManager(db, adapter);
    manager.postMessage(conv, 'running');
    const first = manager.postMessage(conv, 'first queued');
    const second = manager.postMessage(conv, 'second queued');

    expect(manager.queueSnapshot(conv.id).messages.map((message) => message.text)).toEqual([
      'first queued',
      'second queued',
    ]);
    expect(manager.updateQueuedMessage(conv.id, first.messageId, 'edited queued', 2).ok).toBe(true);
    expect(db.prepare('SELECT actor_user_id FROM queued_messages WHERE id = ?').get(first.messageId))
      .toEqual({ actor_user_id: 2 });
    expect(manager.reorderQueuedMessages(conv.id, [second.messageId, first.messageId]).ok).toBe(true);
    expect(manager.queueSnapshot(conv.id).messages.map((message) => message.text)).toEqual([
      'second queued',
      'edited queued',
    ]);

    runs[0]!.finish();
    await flush();
    expect(runs.map((run) => run.prompt)).toEqual(['running', 'second queued']);
    expect(manager.removeQueuedMessage(conv.id, first.messageId).ok).toBe(true);
    expect(manager.queueSnapshot(conv.id).messages).toEqual([]);
  });

  it('promotes the chosen queued message, interrupts, and sends it next', async () => {
    const { adapter, runs, killReasons } = recordingAdapter();
    const manager = makeManager(db, adapter);
    const liveSnapshots: ConversationQueueSnapshot[] = [];
    manager.bus.on('queue', (_conversationId, snapshot: ConversationQueueSnapshot) => liveSnapshots.push(snapshot));
    manager.postMessage(conv, 'running');
    const first = manager.postMessage(conv, 'first queued');
    const chosen = manager.postMessage(conv, 'chosen queued');

    const response = manager.sendQueuedMessageNow(conv, chosen.messageId);
    expect(response.ok).toBe(true);
    expect(manager.queueSnapshot(conv.id).messages.map((message) => message.text)).toEqual([
      'chosen queued',
      'first queued',
    ]);

    await flush();
    expect(runs.map((run) => run.prompt)).toEqual(['running', 'chosen queued']);
    expect(manager.queueSnapshot(conv.id).messages.map((message) => message.text)).toEqual(['first queued']);
    const removal = liveSnapshots.findLast((snapshot) => snapshot.messages.every((message) => message.id !== chosen.messageId));
    expect(removal?.revision).toBeGreaterThan(response.queue.revision);
    // "Send now" replaces what the parent is doing; it must not read as an
    // instruction to abandon the agents that parent already delegated to.
    expect(killReasons).toEqual(['send_now']);
  });

  it('steers a chosen queued message into the live turn without interrupting it', async () => {
    const { adapter, runs, steers, killReasons } = recordingAdapter();
    const manager = makeManager(db, adapter);
    manager.postMessage(conv, 'running');
    const first = manager.postMessage(conv, 'first queued');
    const chosen = manager.postMessage(conv, 'chosen queued');

    const result = await manager.steerQueuedMessageNow(conv, chosen.messageId);

    expect(result?.disposition).toBe('steered');
    expect(steers).toEqual(['chosen queued']);
    expect(killReasons).toEqual([]);
    expect(manager.queueSnapshot(conv.id).messages.map((message) => message.id)).toEqual([first.messageId]);
    expect(await manager.steerQueuedMessageNow(conv, chosen.messageId)).toBeNull();
    await flush();
    expect(runs.map((run) => run.prompt)).toEqual(['running']);
  });

  it('leaves a queued message untouched when the provider cannot steer', async () => {
    const { adapter, steers } = recordingAdapter({ steerResult: false });
    const manager = makeManager(db, adapter);
    manager.postMessage(conv, 'running');
    const queued = manager.postMessage(conv, 'waiting');

    const result = await manager.steerQueuedMessageNow(conv, queued.messageId);

    expect(result?.disposition).toBe('queued');
    expect(steers).toEqual(['waiting']);
    expect(manager.queueSnapshot(conv.id).messages.map((message) => message.text)).toEqual(['waiting']);
  });

  it('an explicit Stop reaches the provider as a user interrupt', async () => {
    const { adapter, killReasons } = recordingAdapter();
    const manager = makeManager(db, adapter);
    manager.postMessage(conv, 'running');
    expect(manager.interrupt(conv.id)).toBe(true);
    await flush();
    expect(killReasons).toEqual(['user']);
  });

  it('durably persists agent guidance until the active provider acknowledges steering', async () => {
    const { adapter, runs, steers } = recordingAdapter();
    const manager = makeManager(db, adapter);
    const events: ConversationEvent[] = [];
    manager.bus.on('event', (_conversationId, event: ConversationEvent) => events.push(event));
    manager.postMessage(conv, 'running');
    const origin = {
      kind: 'agent' as const,
      from: 'Researcher',
      to: 'Writer',
      sourceConversationId: 'research-chat',
      sourceConversationTitle: 'Market research',
    };

    const result = await manager.steerMessage(conv, 'coordination update', undefined, 1, origin);

    expect(result.disposition).toBe('steered');
    expect(steers).toEqual(['coordination update']);
    expect(runs.map((run) => run.prompt)).toEqual(['running']);
    expect(manager.queueSnapshot(conv.id).messages).toEqual([]);
    expect(db.prepare('SELECT * FROM queued_messages').all()).toEqual([]);
    expect(events).toContainEqual(expect.objectContaining({
      type: 'turn_started',
      text: 'coordination update',
      origin,
      messageId: result.messageId,
    }));
    expect(db.prepare('SELECT prompt_text, message_id, origin_json FROM turn_origins').get()).toEqual({
      prompt_text: 'coordination update',
      message_id: result.messageId,
      origin_json: JSON.stringify(origin),
    });
  });

  it('rehydrates agent authorship without mislabeling an older identical human prompt', async () => {
    const transcript: ConversationEvent[] = [];
    const { adapter, runs } = recordingAdapter({ transcript });
    const manager = makeManager(db, adapter);
    const origin = {
      kind: 'agent' as const,
      from: 'Researcher',
      to: 'Writer',
      sourceConversationId: 'research-chat',
      sourceConversationTitle: 'Market research',
    };
    const liveEvents: ConversationEvent[] = [];
    manager.bus.on('event', (_conversationId, event: ConversationEvent) => liveEvents.push(event));

    const posted = manager.postMessage(conv, 'same words', 1, origin);
    const started = liveEvents.find((event) => event.type === 'turn_started');
    expect(started?.type).toBe('turn_started');
    if (started?.type !== 'turn_started') return;
    runs[0]!.finish();
    await flush();

    transcript.push(
      {
        type: 'turn_started',
        turnId: 't1',
        role: 'user',
        text: 'same words',
        at: '2025-12-01T00:00:00.000Z',
        via: 'web',
      },
      {
        type: 'turn_started',
        turnId: 't2',
        role: 'user',
        text: 'same words',
        at: started.at,
        via: 'web',
      },
    );

    const snapshot = await manager.snapshot(conv);
    expect(snapshot[0]).not.toHaveProperty('origin');
    expect(snapshot[1]).toMatchObject({ origin, messageId: posted.messageId });
  });

  it('rehydrates an authenticated sender receipt onto both halves of its tool event', async () => {
    const transcript: ConversationEvent[] = [
      {
        type: 'tool_started',
        turnId: 'turn-1',
        toolId: 'send-1',
        toolName: 'mcp__agents__send_message',
        displayName: 'Using agents',
        inputPreview: 'truncated',
        agentMessageDetails: {
          kind: 'agent-message',
          targetConversationId: 'target-chat',
          text: 'Exact outbound message.',
        },
      },
      {
        type: 'tool_finished',
        turnId: 'turn-1',
        toolId: 'send-1',
        ok: true,
        resultPreview: 'Started the agent.',
      },
    ];
    db.prepare(
      `INSERT INTO conversations (id, assistant_id, user_id, title, provider, native_session_id, channel)
       VALUES ('target-chat', 1, 1, 'Target', 'claude', 'target-native', 'web')`,
    ).run();
    db.prepare(
      `INSERT INTO agent_message_receipts
         (source_conversation_id, target_conversation_id, message_id, message_text, disposition)
       VALUES ('conv-1', 'target-chat', 42, 'Exact outbound message.', 'steered')`,
    ).run();
    const { adapter } = recordingAdapter({ transcript });
    const manager = makeManager(db, adapter);

    const snapshot = await manager.snapshot(conv);
    expect(snapshot).toEqual([
      expect.objectContaining({
        type: 'tool_started',
        agentMessageDetails: expect.objectContaining({
          targetConversationId: 'target-chat',
          messageId: 42,
          disposition: 'steered',
          text: 'Exact outbound message.',
        }),
      }),
      expect.objectContaining({
        type: 'tool_finished',
        agentMessageDetails: expect.objectContaining({
          targetConversationId: 'target-chat',
          messageId: 42,
          disposition: 'steered',
          text: 'Exact outbound message.',
        }),
      }),
    ]);
  });

  it('holds rapid follow-ups through asynchronous startup and steers each once in order', async () => {
    const {adapter,runs,steers} = recordingAdapter();
    let release!: () => void;
    const startup = new Promise<void>(resolve=>{release=resolve;});
    const manager = createConversationManager({db,adapters:{claude:adapter},
      resolveWorkspace:()=>({workspaceDir:'/tmp',assistantSlug:'assistant',elevated:false,fullAccess:false}),
      loadMemoryBlock:async()=>{await startup; return null;},
      log:{warn:()=>undefined,error:()=>undefined}});
    manager.postMessage(conv,'Opening message');
    const first=manager.steerMessage(conv,'First rapid detail');
    const second=manager.steerMessage(conv,'Second rapid detail');
    expect(runs).toHaveLength(0);
    expect(manager.queueSnapshot(conv.id).messages.map(m=>[m.text,m.delivered])).toEqual([
      ['First rapid detail',true],['Second rapid detail',true]]);
    release();
    expect((await first).disposition).toBe('steered');
    expect((await second).disposition).toBe('steered');
    expect(runs).toHaveLength(1);
    expect(steers).toEqual(['First rapid detail','Second rapid detail']);
    expect(manager.queueSnapshot(conv.id).messages).toHaveLength(0);
    runs[0]!.finish(); await flush(); expect(runs).toHaveLength(1);
  });

  it('queues another user’s guidance instead of steering it into the current actor’s connectors', async () => {
    db.prepare(
      "INSERT INTO users (id, email, display_name, role) VALUES (2, 'member@example.com', 'Member', 'member')",
    ).run();
    const { adapter, runs, steers } = recordingAdapter();
    const manager = makeManager(db, adapter);
    manager.postMessage(conv, 'owner turn', 1);

    const result = await manager.steerMessage(conv, 'member guidance', undefined, 2);

    expect(result.disposition).toBe('queued');
    expect(steers).toEqual([]);
    expect(db.prepare('SELECT actor_user_id FROM queued_messages').get()).toEqual({ actor_user_id: 2 });
    runs[0]!.finish();
    await flush();
    expect(runs.map((run) => run.prompt)).toEqual(['owner turn', 'member guidance']);
    expect(db.prepare('SELECT actor_user_id FROM pending_turns').get()).toEqual({ actor_user_id: 2 });
  });

  it('retains agent guidance in the durable queue when live steering is rejected', async () => {
    const { adapter, runs, steers } = recordingAdapter({ steerResult: false });
    const manager = makeManager(db, adapter);
    manager.postMessage(conv, 'running');

    const result = await manager.steerMessage(conv, 'do not lose this');

    expect(result.disposition).toBe('queued');
    expect(steers).toEqual(['do not lose this']);
    expect(manager.queueSnapshot(conv.id).messages.map((message) => message.text)).toEqual(['do not lose this']);
    expect(db.prepare('SELECT prompt FROM queued_messages').all()).toMatchObject([{ prompt: 'do not lose this' }]);

    runs[0]!.finish();
    await flush();
    expect(runs.map((run) => run.prompt)).toEqual(['running', 'do not lose this']);
  });

  it('reports delivery while a busy provider has not echoed the steered line yet', async () => {
    const { factory, deliveries } = pendingDeliveries();
    const { adapter, runs, steers } = recordingAdapter({ steerResult: factory });
    const manager = makeManager(db, adapter, undefined, false, 5);
    manager.postMessage(conv, 'running');

    const result = await manager.steerMessage(conv, 'read this when you can');

    expect(result.disposition).toBe('delivered');
    expect(result.steerReason).toBeUndefined();
    expect(steers).toEqual(['read this when you can']);
    // The write landed but the CLI has not read it, so the fallback must stay.
    expect(db.prepare('SELECT prompt FROM queued_messages').all()).toMatchObject([
      { prompt: 'read this when you can' },
    ]);

    deliveries[0]!.acknowledge(true);
    await flush();
    expect(db.prepare('SELECT prompt FROM queued_messages').all()).toEqual([]);
    expect(manager.queueSnapshot(conv.id).messages).toEqual([]);
    expect(runs.map((run) => run.prompt)).toEqual(['running']);
  });

  it('runs a delivered-but-unread message as a fresh turn exactly once when the turn ends first', async () => {
    const { factory, deliveries } = pendingDeliveries();
    const { adapter, runs } = recordingAdapter({ steerResult: factory });
    const manager = makeManager(db, adapter, undefined, false, 5);
    manager.postMessage(conv, 'running');

    const result = await manager.steerMessage(conv, 'never read live');
    expect(result.disposition).toBe('delivered');

    // The provider process ended without consuming the line.
    deliveries[0]!.acknowledge(false);
    runs[0]!.finish();
    await flush();

    expect(runs.map((run) => run.prompt)).toEqual(['running', 'never read live']);
    expect(db.prepare('SELECT prompt FROM queued_messages').all()).toEqual([]);
  });

  it('keeps a delivered message when the turn it was steered into is stopped, even if a late echo arrives', async () => {
    const { factory, deliveries } = pendingDeliveries();
    const { adapter, runs, killReasons } = recordingAdapter({ steerResult: factory });
    const manager = makeManager(db, adapter, undefined, false, 5);
    manager.postMessage(conv, 'running');

    const result = await manager.steerMessage(conv, 'must survive the stop');
    expect(result.disposition).toBe('delivered');

    // Send now / Stop: whatever the dying process claims to have read is void.
    expect(manager.interrupt(conv.id, 'send_now')).toBe(true);
    deliveries[0]!.acknowledge(true);
    expect(db.prepare('SELECT prompt FROM queued_messages').all()).toMatchObject([
      { prompt: 'must survive the stop' },
    ]);

    await flush();
    expect(killReasons).toEqual(['send_now']);
    expect(runs.map((run) => run.prompt)).toEqual(['running', 'must survive the stop']);
    expect(db.prepare('SELECT prompt FROM queued_messages').all()).toEqual([]);
  });

  it('refuses to edit or remove a queued row the live agent is already holding', async () => {
    const { factory, deliveries } = pendingDeliveries();
    const { adapter, runs } = recordingAdapter({ steerResult: factory });
    const manager = makeManager(db, adapter, undefined, false, 5);
    manager.postMessage(conv, 'running');

    const result = await manager.steerMessage(conv, 'already in the agent’s hands');
    expect(result.disposition).toBe('delivered');
    expect(manager.queueSnapshot(conv.id).messages).toMatchObject([{ delivered: true }]);
    expect(manager.updateQueuedMessage(conv.id, result.messageId, 'rewritten')).toMatchObject({
      ok: false,
      error: 'conflict',
    });
    expect(manager.removeQueuedMessage(conv.id, result.messageId)).toMatchObject({
      ok: false,
      error: 'conflict',
    });
    expect(db.prepare('SELECT prompt FROM queued_messages').all()).toMatchObject([
      { prompt: 'already in the agent’s hands' },
    ]);

    // Once the steer settles the row is ordinary again.
    deliveries[0]!.acknowledge(false);
    await flush();
    expect(manager.queueSnapshot(conv.id).messages[0]).not.toHaveProperty('delivered');
    expect(manager.removeQueuedMessage(conv.id, result.messageId)).toMatchObject({ ok: true });
    runs[0]!.finish();
    await flush();
    expect(runs.map((run) => run.prompt)).toEqual(['running']);
  });

  it('reports steering when the provider echoes the line inside the acknowledgement wait', async () => {
    const { adapter, runs } = recordingAdapter({
      steerResult: ({ echo }) => {
        echo();
        return { delivered: true, acknowledged: Promise.resolve(true) };
      },
    });
    const manager = makeManager(db, adapter, undefined, false, 5_000);
    manager.postMessage(conv, 'running');

    const result = await manager.steerMessage(conv, 'acked right away');

    expect(result.disposition).toBe('steered');
    expect(db.prepare('SELECT prompt FROM queued_messages').all()).toEqual([]);
    expect(runs.map((run) => run.prompt)).toEqual(['running']);
  });

  it('reports why a message could not be steered', async () => {
    const noSteer = recordingAdapter({ supportsSteer: false });
    const manager = makeManager(db, noSteer.adapter);
    manager.postMessage(conv, 'running');

    const unsupported = await manager.steerMessage(conv, 'no mid-turn input here');
    expect(unsupported).toMatchObject({ disposition: 'queued', steerReason: 'no_steer_support' });
    noSteer.runs[0]!.finish();
    await flush();

    const rejected = recordingAdapter({ steerResult: false });
    const rejectedManager = makeManager(db, rejected.adapter);
    rejectedManager.postMessage(conv, 'running again');
    const failed = await rejectedManager.steerMessage(conv, 'write refused');
    expect(failed).toMatchObject({ disposition: 'queued', steerReason: 'write_failed' });
    rejected.runs[0]!.finish();
    await flush();
  });

  it('reports maintenance as the reason while the chat is compacting', async () => {
    db.prepare("INSERT INTO settings (key, value_json) VALUES ('turn_ran:conv-1', 'true')").run();
    const { adapter, compactions } = recordingAdapter({ compaction: true });
    const manager = makeManager(db, adapter);
    const compacting = manager.compactConversation(conv);

    const result = await manager.steerMessage(conv, 'wait for maintenance');
    expect(result).toMatchObject({ disposition: 'queued', steerReason: 'maintenance' });

    compactions[0]!.resolve({ contextTokens: null });
    await compacting;
  });

  it('stores a delivered receipt: the schema CHECK accepts every real disposition', () => {
    const insert = db.prepare(
      `INSERT INTO agent_message_receipts
         (source_conversation_id, target_conversation_id, message_id, message_text, disposition)
       VALUES ('conv-1', 'conv-1', ?, 'Exact outbound message.', ?)`,
    );
    for (const [index, disposition] of ['running', 'steered', 'delivered', 'queued', 'duplicate'].entries()) {
      expect(() => insert.run(index + 1, disposition)).not.toThrow();
    }
    expect(() => insert.run(99, 'invented')).toThrow();
  });

  it('starts agent guidance normally when the target chat is idle', async () => {
    const { adapter, runs, steers } = recordingAdapter();
    const manager = makeManager(db, adapter);

    const result = await manager.steerMessage(conv, 'start now');

    expect(result.disposition).toBe('running');
    expect(steers).toEqual([]);
    expect(runs.map((run) => run.prompt)).toEqual(['start now']);
    expect(manager.queueSnapshot(conv.id).messages).toEqual([]);
  });

  it('keeps later messages queued until an exhausted turn is retried or skipped', () => {
    db.prepare(
      "INSERT INTO pending_turns (conversation_id, prompt, attempts, status) VALUES (?, 'failed turn', 3, 'pending')",
    ).run(conv.id);
    const { adapter, runs } = recordingAdapter();
    const manager = makeManager(db, adapter);
    manager.resumeInterruptedTurns();
    const later = manager.postMessage(conv, 'later message');

    expect(later.disposition).toBe('queued');
    expect(runs).toHaveLength(0);
    expect(manager.queueSnapshot(conv.id).messages.map((message) => message.text)).toEqual(['later message']);

    expect(manager.discardFailedTurn(conv).ok).toBe(true);
    expect(runs.map((run) => run.prompt)).toEqual(['later message']);
  });

  it('does not dismiss an ask_user question when the user explicitly queues', () => {
    const { adapter } = recordingAdapter();
    const manager = makeManager(db, adapter);
    manager.postMessage(conv, 'running');
    const requestId = manager.askQuestion(conv.id, 'Choose one', [{ label: 'A', value: 'a' }], false);

    manager.queueMessage(conv, 'wait until later');
    expect(manager.getQuestion(requestId)?.status).toBe('pending');

    manager.postMessage(conv, 'answer by chatting');
    expect(manager.getQuestion(requestId)?.status).toBe('dismissed');
  });
});
