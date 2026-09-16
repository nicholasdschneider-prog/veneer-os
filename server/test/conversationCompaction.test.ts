import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import type { ConversationRow } from '../src/db/db.js';
import { createConversationManager } from '../src/runtime/conversationManager.js';
import type {
  CompactSessionResult,
  CompactSessionSpec,
  ProviderAdapter,
  TurnSpec,
} from '../src/providers/types.js';
import type { ConversationActivity, ConversationEvent, ConversationStatus } from '../src/runtime/events.js';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/db/migrations');
const flush = () => new Promise((resolve) => setImmediate(resolve));

function openTestDb(
  sessionReady = true,
  provider: 'claude' | 'codex' = 'claude',
): { db: Database.Database; conv: ConversationRow } {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db, MIGRATIONS);
  db.prepare("INSERT INTO users (email, display_name, role) VALUES ('owner@example.com', 'Owner', 'owner')").run();
  db.prepare(
    `INSERT INTO conversations
      (id, assistant_id, user_id, title, provider, native_session_id, channel, last_input_tokens)
     VALUES ('conv-1', 1, 1, 'Compaction test', ?, 'native-current', 'web', 90000)`,
  ).run(provider);
  if (sessionReady) {
    db.prepare("INSERT INTO settings (key, value_json) VALUES ('turn_ran:conv-1', 'true')").run();
  }
  return {
    db,
    conv: db.prepare("SELECT * FROM conversations WHERE id = 'conv-1'").get() as ConversationRow,
  };
}

function controlledAdapter(withCompaction = true, id: 'claude' | 'codex' = 'claude') {
  const runs: TurnSpec[] = [];
  const compactions: Array<{
    spec: CompactSessionSpec;
    killed: boolean;
    resolve: (result: CompactSessionResult) => void;
    reject: (err: Error) => void;
  }> = [];
  const visibleEvents: ConversationEvent[] = [
    {
      type: 'turn_started',
      turnId: 'visible-turn',
      role: 'user',
      text: 'Keep this visible',
      at: '2026-08-19T12:00:00.000Z',
      via: 'web',
    },
    {
      type: 'text_final',
      turnId: 'visible-turn',
      markdown: 'Still visible after compaction.',
      at: '2026-08-19T12:00:01.000Z',
    },
  ];
  const adapter: ProviderAdapter = {
    id,
    mintSessionId: () => 'minted',
    runTurn(spec) {
      runs.push(spec);
      return {
        done: new Promise<void>(() => undefined),
        kill() {},
        respondToApproval: () => false,
      };
    },
    readTranscript: async () => visibleEvents,
    ...(withCompaction
      ? {
          compactSession(spec: CompactSessionSpec) {
            let resolve!: (result: CompactSessionResult) => void;
            let reject!: (err: Error) => void;
            const done = new Promise<CompactSessionResult>((res, rej) => {
              resolve = res;
              reject = rej;
            });
            const record = { spec, killed: false, resolve, reject };
            compactions.push(record);
            return {
              done,
              kill() {
                record.killed = true;
                reject(new Error('native compaction interrupted'));
              },
            };
          },
        }
      : {}),
  };
  return { adapter, runs, compactions, visibleEvents };
}

function manager(db: Database.Database, adapter: ProviderAdapter) {
  return createConversationManager({
    db,
    adapters: { [adapter.id]: adapter },
    resolveWorkspace: () => ({
      workspaceDir: '/workspace/current',
      assistantSlug: 'assistant',
      elevated: false,
      fullAccess: true,
    }),
    log: { warn() {}, error() {} },
  });
}

describe('conversation context compaction', () => {
  it.each(['claude', 'codex'] as const)(
    'publishes durable activity for %s while preserving the transcript and usage',
    async (providerId) => {
      const { db, conv } = openTestDb(true, providerId);
      const provider = controlledAdapter(true, providerId);
      const runtime = manager(db, provider.adapter);
      const liveEvents: ConversationEvent[] = [];
      const liveStatuses: Array<{ status: ConversationStatus; activity: ConversationActivity }> = [];
      runtime.bus.on('event', (_conversationId, event: ConversationEvent) => liveEvents.push(event));
      runtime.bus.on(
        'status',
        (_conversationId, status: ConversationStatus, activity: ConversationActivity) => {
          liveStatuses.push({ status, activity });
        },
      );

      const before = await runtime.snapshot(conv);
      const pending = runtime.compactConversation(conv);
      expect(runtime.statusOf(conv.id)).toBe('working');
      expect(runtime.activityOf(conv.id)).toBe('compacting');
      expect(liveStatuses.at(-1)).toEqual({ status: 'working', activity: 'compacting' });
      expect(runtime.isLive(conv.id)).toBe(true);
      expect(provider.compactions).toHaveLength(1);
      expect(provider.compactions[0]?.spec).toEqual({
        cwd: '/workspace/current',
        nativeSessionId: 'native-current',
        dangerous: true,
      });

      await expect(runtime.compactConversation(conv)).resolves.toMatchObject({
        ok: false,
        error: 'already_compacting',
      });
      const posted = runtime.postMessage(conv, 'Run after maintenance');
      expect(posted.disposition).toBe('queued');
      expect(provider.runs).toHaveLength(0);
      expect(runtime.sendQueuedMessageNow(conv, posted.messageId)).toMatchObject({
        ok: false,
        error: 'conflict',
      });
      expect(provider.compactions[0]?.killed).toBe(false);

      provider.compactions[0]!.resolve({ contextTokens: null });
      await expect(pending).resolves.toEqual({ ok: true, contextTokens: null });
      await flush();
      expect(runtime.activityOf(conv.id)).toBeNull();
      expect(liveStatuses.at(-1)).toEqual({ status: 'working', activity: null });

      expect(provider.runs.map((run) => run.prompt)).toEqual(['Run after maintenance']);
      expect(db.prepare("SELECT last_input_tokens FROM conversations WHERE id = 'conv-1'").get()).toEqual({
        last_input_tokens: null,
      });
      expect(liveEvents).toContainEqual({
        type: 'context_compacted',
        contextTokens: null,
        notice: 'Context compacted.',
      });
      const after = await runtime.snapshot(conv);
      expect(after.slice(0, before.length)).toEqual(before);
      expect(JSON.stringify(after)).not.toContain('contextCompaction');
    },
  );

  it('rejects active turns, unsupported providers, and sessions with no completed turn', async () => {
    const busyDb = openTestDb();
    const busyProvider = controlledAdapter();
    const busyRuntime = manager(busyDb.db, busyProvider.adapter);
    busyRuntime.postMessage(busyDb.conv, 'Still running');
    await expect(busyRuntime.compactConversation(busyDb.conv)).resolves.toMatchObject({
      ok: false,
      error: 'working',
    });

    const unsupportedDb = openTestDb();
    const unsupported = controlledAdapter(false);
    await expect(manager(unsupportedDb.db, unsupported.adapter).compactConversation(unsupportedDb.conv))
      .resolves.toMatchObject({ ok: false, error: 'unsupported' });

    const emptyDb = openTestDb(false);
    const emptyProvider = controlledAdapter();
    await expect(manager(emptyDb.db, emptyProvider.adapter).compactConversation(emptyDb.conv))
      .resolves.toMatchObject({ ok: false, error: 'not_ready' });
    expect(emptyProvider.compactions).toHaveLength(0);
  });

  it('interrupts maintenance cleanly and retains usage after provider failure', async () => {
    const interruptedDb = openTestDb();
    const interruptedProvider = controlledAdapter();
    const interruptedRuntime = manager(interruptedDb.db, interruptedProvider.adapter);
    const interrupted = interruptedRuntime.compactConversation(interruptedDb.conv);
    expect(interruptedRuntime.interrupt(interruptedDb.conv.id)).toBe(true);
    await expect(interrupted).resolves.toMatchObject({ ok: false, error: 'interrupted' });
    expect(interruptedProvider.compactions[0]?.killed).toBe(true);
    expect(interruptedRuntime.statusOf(interruptedDb.conv.id)).toBe('idle');
    expect(interruptedRuntime.activityOf(interruptedDb.conv.id)).toBeNull();

    const failedDb = openTestDb();
    const failedProvider = controlledAdapter();
    const failedRuntime = manager(failedDb.db, failedProvider.adapter);
    const failed = failedRuntime.compactConversation(failedDb.conv);
    failedProvider.compactions[0]!.reject(new Error('provider rejected compaction'));
    await expect(failed).resolves.toMatchObject({ ok: false, error: 'failed' });
    expect(failedRuntime.activityOf(failedDb.conv.id)).toBeNull();
    expect(failedDb.db.prepare("SELECT last_input_tokens FROM conversations WHERE id = 'conv-1'").get()).toEqual({
      last_input_tokens: 90000,
    });

    const staleDb = openTestDb();
    const staleProvider = controlledAdapter();
    const staleRuntime = manager(staleDb.db, staleProvider.adapter);
    const stale = staleRuntime.compactConversation(staleDb.conv);
    staleProvider.compactions[0]!.reject(new Error('thread not found'));
    await expect(stale).resolves.toMatchObject({
      ok: false,
      error: 'failed',
      message: expect.stringMatching(/session is no longer available/i),
    });

    const shortDb = openTestDb();
    const shortProvider = controlledAdapter();
    const shortRuntime = manager(shortDb.db, shortProvider.adapter);
    const shortEvents: ConversationEvent[] = [];
    shortRuntime.bus.on('event', (_conversationId, event: ConversationEvent) => shortEvents.push(event));
    const short = shortRuntime.compactConversation(shortDb.conv);
    shortProvider.compactions[0]!.reject(new Error('Not enough messages to compact.'));
    await expect(short).resolves.toMatchObject({
      ok: false,
      error: 'not_ready',
      message: expect.stringMatching(/not enough chat history/i),
    });
    expect(shortEvents).not.toContainEqual(expect.objectContaining({ type: 'context_compacted' }));
  });
});
