import { EventEmitter } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import type { ConversationRow, ConversationWakeupRow } from '../src/db/db.js';
import type { ProviderAdapter, TurnSpec } from '../src/providers/types.js';
import type { ConversationEvent } from '../src/runtime/events.js';
import { createConversationManager } from '../src/runtime/conversationManager.js';
import {
  createConversationWakeupScheduler,
  type ConversationWakeupScheduler,
} from '../src/scheduled/wakeups.js';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/db/migrations');
const BASE = new Date('2026-07-29T12:00:00.000Z');
const flush = () => new Promise((resolve) => setImmediate(resolve));

function recordingAdapter() {
  const runs: Array<{ prompt: string; finish: () => void }> = [];
  const adapter: ProviderAdapter = {
    id: 'claude',
    mintSessionId: () => 'sid',
    runTurn(spec: TurnSpec, onEvent) {
      let resolveDone!: () => void;
      const done = new Promise<void>((resolve) => {
        resolveDone = resolve;
      });
      runs.push({
        prompt: spec.prompt,
        finish: () => {
          onEvent({
            type: 'text_final',
            turnId: spec.turnId,
            markdown: 'done',
            at: BASE.toISOString(),
          } as ConversationEvent);
          onEvent({ type: 'turn_done', turnId: spec.turnId } as ConversationEvent);
          resolveDone();
        },
      });
      return {
        done,
        kill: resolveDone,
        respondToApproval: () => true,
      };
    },
    readTranscript: async () => [],
  };
  return { adapter, runs };
}

describe('conversation wake-up scheduler', () => {
  let db: Database.Database;
  let current: Date;
  let conv: ConversationRow;
  let adapter: ReturnType<typeof recordingAdapter>;
  let manager: ReturnType<typeof createConversationManager>;
  let scheduler: ConversationWakeupScheduler;
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db, MIGRATIONS);
    db.prepare("INSERT INTO users (id, email, display_name, role) VALUES (1, 'wake@example.com', 'Wake', 'owner')").run();
    db.prepare(
      `INSERT INTO conversations
       (id, assistant_id, user_id, title, provider, native_session_id, channel)
       VALUES ('wake-conv', 1, 1, 'Wake test', 'claude', 'wake-session', 'web')`,
    ).run();
    conv = db.prepare("SELECT * FROM conversations WHERE id = 'wake-conv'").get() as ConversationRow;
    current = new Date(BASE);
    adapter = recordingAdapter();
    manager = createConversationManager({
      db,
      adapters: { claude: adapter.adapter },
      resolveWorkspace: () => ({
        workspaceDir: '/tmp',
        assistantSlug: 'assistant',
        elevated: false,
        fullAccess: false,
      }),
      log: { warn: vi.fn(), error: vi.fn() },
    });
    scheduler = createConversationWakeupScheduler({
      db,
      manager,
      now: () => new Date(current),
      log,
    });
  });

  afterEach(async () => {
    scheduler.stop();
    manager.shutdown();
    await flush();
    db.close();
    vi.clearAllMocks();
  });

  it('replaces a pending wake with the same key and supports list and cancel', () => {
    const first = scheduler.schedule({
      conversationId: conv.id,
      actorUserId: conv.user_id,
      key: 'build-check',
      reason: 'Check build one',
      scheduledFor: new Date(BASE.getTime() + 60_000),
    });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('expected first wake');

    const second = scheduler.schedule({
      conversationId: conv.id,
      actorUserId: conv.user_id,
      key: 'build-check',
      reason: 'Check the newer build',
      scheduledFor: new Date(BASE.getTime() + 120_000),
    });
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error('expected second wake');
    expect(second.replacedWakeupId).toBe(first.wakeup.id);

    expect(
      scheduler.list(conv.id).map((row) => ({ id: row.id, status: row.status, reason: row.reason })),
    ).toEqual(
      expect.arrayContaining([
        { id: first.wakeup.id, status: 'cancelled', reason: 'Check build one' },
        { id: second.wakeup.id, status: 'pending', reason: 'Check the newer build' },
      ]),
    );
    expect(scheduler.cancel(conv.id, second.wakeup.id)).toMatchObject({
      ok: true,
      wakeup: { status: 'cancelled' },
    });
    expect(scheduler.cancel(conv.id, second.wakeup.id)).toEqual({ ok: false, error: 'not_pending' });
  });

  it('queues a due wake behind active work, then runs it in the same conversation', async () => {
    manager.postMessage(conv, 'long active turn');
    const scheduled = scheduler.schedule({
      conversationId: conv.id,
      actorUserId: conv.user_id,
      key: 'monitor',
      reason: 'Check the test process',
      scheduledFor: new Date(BASE.getTime() + 10_000),
    });
    if (!scheduled.ok) throw new Error('expected wake');

    current = new Date(BASE.getTime() + 20_000);
    scheduler.tick();

    expect(adapter.runs.map((run) => run.prompt)).toEqual(['long active turn']);
    expect(manager.queueSnapshot(conv.id).messages).toHaveLength(1);
    expect(manager.queueSnapshot(conv.id).messages[0]?.text).toContain('Check the test process');
    expect(db.prepare('SELECT status FROM conversation_wakeups WHERE id = ?').get(scheduled.wakeup.id)).toEqual({
      status: 'delivered',
    });

    adapter.runs[0]!.finish();
    await flush();
    expect(adapter.runs).toHaveLength(2);
    expect(adapter.runs[1]!.prompt).toBe(
      'Hey, can you pick this back up for me?\n\n' +
        'Check the test process\n\n' +
        'Please check what changed while you were away before you continue.',
    );
    expect(adapter.runs[1]!.prompt).not.toContain(scheduled.wakeup.id);
    expect(adapter.runs[1]!.prompt).not.toContain(current.toISOString());
    adapter.runs[1]!.finish();
    await flush();
  });

  it('delivers an overdue persisted wake after the scheduler is recreated', async () => {
    db.prepare(
      "INSERT INTO users (id, email, display_name, role) VALUES (2, 'member@example.com', 'Member', 'member')",
    ).run();
    const scheduled = scheduler.schedule({
      conversationId: conv.id,
      actorUserId: 2,
      key: 'restart-check',
      reason: 'Continue after runner restart',
      scheduledFor: new Date(BASE.getTime() + 30_000),
    });
    if (!scheduled.ok) throw new Error('expected wake');
    scheduler.stop();

    current = new Date(BASE.getTime() + 90_000);
    scheduler = createConversationWakeupScheduler({
      db,
      manager,
      now: () => new Date(current),
      log,
    });
    scheduler.tick();

    expect(adapter.runs).toHaveLength(1);
    expect(adapter.runs[0]!.prompt).toContain('Continue after runner restart');
    expect(db.prepare('SELECT actor_user_id FROM pending_turns WHERE conversation_id = ?').get(conv.id))
      .toEqual({ actor_user_id: 2 });
    expect(db.prepare('SELECT status FROM conversation_wakeups WHERE id = ?').get(scheduled.wakeup.id)).toEqual({
      status: 'delivered',
    });
    adapter.runs[0]!.finish();
    await flush();
  });

  it('retries a crash after enqueue without creating a duplicate continuation', async () => {
    manager.postMessage(conv, 'active turn');
    const scheduled = scheduler.schedule({
      conversationId: conv.id,
      actorUserId: conv.user_id,
      key: 'crash-window',
      reason: 'Recover exactly once',
      scheduledFor: new Date(BASE.getTime() + 5_000),
    });
    if (!scheduled.ok) throw new Error('expected wake');
    current = new Date(BASE.getTime() + 10_000);

    let failAfterEnqueue = true;
    scheduler = createConversationWakeupScheduler({
      db,
      manager: {
        deliverWakeup(row, text, wakeupId, actorUserId) {
          const result = manager.deliverWakeup(row, text, wakeupId, actorUserId);
          if (failAfterEnqueue) {
            failAfterEnqueue = false;
            throw new Error('simulated crash after durable enqueue');
          }
          return result;
        },
      },
      now: () => new Date(current),
      log,
    });

    scheduler.tick();
    expect(db.prepare('SELECT status FROM conversation_wakeups WHERE id = ?').get(scheduled.wakeup.id)).toEqual({
      status: 'pending',
    });
    expect(manager.queueSnapshot(conv.id).messages).toHaveLength(1);

    scheduler.tick();
    expect(db.prepare('SELECT status FROM conversation_wakeups WHERE id = ?').get(scheduled.wakeup.id)).toEqual({
      status: 'delivered',
    });
    expect(manager.queueSnapshot(conv.id).messages).toHaveLength(1);
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM hub_inbound_messages WHERE source_kind = 'wakeup'").get(),
    ).toEqual({ count: 1 });

    adapter.runs[0]!.finish();
    await flush();
    expect(adapter.runs).toHaveLength(2);
    adapter.runs[1]!.finish();
    await flush();
  });

  it('cascades pending wakes when their conversation is deleted', () => {
    const scheduled = scheduler.schedule({
      conversationId: conv.id,
      actorUserId: conv.user_id,
      key: 'deleted',
      reason: 'Must never run',
      scheduledFor: new Date(BASE.getTime() + 10_000),
    });
    expect(scheduled.ok).toBe(true);

    db.prepare('DELETE FROM conversations WHERE id = ?').run(conv.id);
    current = new Date(BASE.getTime() + 20_000);
    scheduler.tick();

    expect(db.prepare('SELECT * FROM conversation_wakeups').all()).toEqual([]);
    expect(adapter.runs).toEqual([]);
  });
  it('reschedules a pending wake and refuses times outside the allowed window', () => {
    const scheduled = scheduler.schedule({
      conversationId: conv.id,
      actorUserId: conv.user_id,
      key: 'movable',
      reason: 'Move me',
      scheduledFor: new Date(BASE.getTime() + 60_000),
    });
    if (!scheduled.ok) throw new Error('expected wake');

    const moved = scheduler.reschedule(conv.id, scheduled.wakeup.id, new Date(BASE.getTime() + 600_000));
    expect(moved).toMatchObject({ ok: true, wakeup: { status: 'pending' } });
    if (!moved.ok) throw new Error('expected move');
    expect(moved.wakeup.scheduled_for).toBe(new Date(BASE.getTime() + 600_000).toISOString());

    expect(scheduler.reschedule(conv.id, scheduled.wakeup.id, new Date(BASE.getTime() - 1_000))).toEqual({
      ok: false,
      error: 'invalid_time',
    });
    expect(
      scheduler.reschedule(conv.id, scheduled.wakeup.id, new Date(BASE.getTime() + 31 * 24 * 60 * 60 * 1_000)),
    ).toEqual({ ok: false, error: 'invalid_time' });
    expect(scheduler.reschedule(conv.id, 'missing-id', new Date(BASE.getTime() + 600_000))).toEqual({
      ok: false,
      error: 'not_found',
    });

    scheduler.cancel(conv.id, scheduled.wakeup.id);
    expect(scheduler.reschedule(conv.id, scheduled.wakeup.id, new Date(BASE.getTime() + 600_000))).toEqual({
      ok: false,
      error: 'not_pending',
    });
  });

  it('fires a pending wake immediately through the ordinary delivery path', async () => {
    const scheduled = scheduler.schedule({
      conversationId: conv.id,
      actorUserId: conv.user_id,
      key: 'fire-now',
      reason: 'Check it right now',
      scheduledFor: new Date(BASE.getTime() + 3_600_000),
    });
    if (!scheduled.ok) throw new Error('expected wake');

    const fired = scheduler.fire(conv.id, scheduled.wakeup.id);
    expect(fired).toMatchObject({ ok: true, wakeup: { status: 'delivered' } });
    expect(adapter.runs).toHaveLength(1);
    expect(adapter.runs[0]!.prompt).toContain('Check it right now');
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM hub_inbound_messages WHERE source_kind = 'wakeup'").get(),
    ).toEqual({ count: 1 });

    expect(scheduler.fire(conv.id, scheduled.wakeup.id)).toEqual({ ok: false, error: 'not_pending' });
    expect(scheduler.fire(conv.id, 'missing-id')).toEqual({ ok: false, error: 'not_found' });

    // The already-delivered row must not run a second time on the next tick.
    current = new Date(BASE.getTime() + 7_200_000);
    scheduler.tick();
    expect(adapter.runs).toHaveLength(1);

    adapter.runs[0]!.finish();
    await flush();
  });

  it('publishes the pending set on the bus after every mutation', () => {
    const bus = new EventEmitter();
    const seen: Array<{ conversationId: string; ids: string[] }> = [];
    bus.on('wakeups', (conversationId: string, rows: ConversationWakeupRow[]) =>
      seen.push({ conversationId, ids: rows.map((row) => row.id) }),
    );
    scheduler = createConversationWakeupScheduler({ db, manager, bus, now: () => new Date(current), log });

    const scheduled = scheduler.schedule({
      conversationId: conv.id,
      actorUserId: conv.user_id,
      key: 'bus',
      reason: 'Emit me',
      scheduledFor: new Date(BASE.getTime() + 60_000),
    });
    if (!scheduled.ok) throw new Error('expected wake');
    scheduler.reschedule(conv.id, scheduled.wakeup.id, new Date(BASE.getTime() + 120_000));
    scheduler.cancel(conv.id, scheduled.wakeup.id);

    expect(seen).toEqual([
      { conversationId: conv.id, ids: [scheduled.wakeup.id] },
      { conversationId: conv.id, ids: [scheduled.wakeup.id] },
      { conversationId: conv.id, ids: [] },
    ]);
  });
});
