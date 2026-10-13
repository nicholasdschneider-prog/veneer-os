import { saveRoutine, tickRoutines, type Routine } from '../src/botWorkflows/routines.js';
import { humanDecisionAnswerWake } from '../src/bots/delivery.js';
import { coalescePeriodicChecks, routineReason } from '../src/botWorkflows/periodicChecks.js';
import type { UserRow } from '../src/db/db.js';
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

  it('defers automatic wakeups without losing or duplicating them', () => {
    let allowed = false;
    scheduler.stop();
    scheduler = createConversationWakeupScheduler({db,manager,now:()=>new Date(current),log,canDispatch:()=>allowed});
    const wake = scheduler.schedule({conversationId:conv.id,actorUserId:1,key:'capacity-test',reason:'Check progress',scheduledFor:new Date(BASE.getTime()+2000)});
    if (!wake.ok) throw new Error('fixture failed');
    current = new Date(BASE.getTime()+3000);
    scheduler.tick();
    expect(adapter.runs).toHaveLength(0);
    expect(scheduler.listPending(conv.id)).toHaveLength(1);
    allowed = true; scheduler.tick();
    expect(adapter.runs).toHaveLength(1);
    expect(scheduler.listPending(conv.id)).toHaveLength(0);
    scheduler.tick();
    expect(adapter.runs).toHaveLength(1);
  });

  it('checks result replies before a full page of deferred automatic wakes', () => {
    const canDispatch = vi.fn((_row: ConversationWakeupRow) => false);
    scheduler.stop();
    scheduler = createConversationWakeupScheduler({db,manager,now:()=>new Date(current),log,canDispatch});
    const insert = db.prepare("INSERT INTO conversation_wakeups(id,conversation_id,wake_key,reason,scheduled_for,actor_user_id) VALUES(?,?,?,'Check',?,1)");
    for (let i=0;i<51;i++) insert.run(`ordinary-${i}`,conv.id,`ordinary-${i}`,new Date(BASE.getTime()-2000).toISOString());
    insert.run('reply',conv.id,'message-thread:reply',new Date(BASE.getTime()-1000).toISOString());
    scheduler.tick();
    expect(canDispatch.mock.calls[0]?.[0]).toMatchObject({id:'reply'});
    expect(scheduler.listPending(conv.id)).toHaveLength(52);
  });

  it('delivers human decision answers first and leaves bot-recorded or non-answer events in line', () => {
    const canDispatch = vi.fn((row: ConversationWakeupRow) => humanDecisionAnswerWake(db, row.id));
    scheduler.stop();
    scheduler = createConversationWakeupScheduler({db,manager,now:()=>new Date(current),log,canDispatch});
    db.pragma('foreign_keys = OFF');
    db.prepare("INSERT INTO bot_decisions(id,conversation_id,source_key,proposal_key,proposal_json,assignee_id) VALUES('d1',?,'s','p','{}',1)").run(conv.id);
    const event = db.prepare("INSERT INTO bot_decision_events(id,decision_id,version,kind,actor_id,actor_conversation_id,payload_json,request_key) VALUES(?,'d1',1,?,1,?,'{}',?)");
    event.run('human-answer','answered',null,'k1');
    event.run('bot-answer','answered',conv.id,'k2');
    event.run('claim','handling',null,'k3');
    const insert = db.prepare("INSERT INTO conversation_wakeups(id,conversation_id,wake_key,reason,scheduled_for,actor_user_id) VALUES(?,?,?,'Check',?,1)");
    for (let i=0;i<51;i++) insert.run(`ordinary-${i}`,conv.id,`ordinary-${i}`,new Date(BASE.getTime()-3000).toISOString());
    for (const id of ['bot-answer','claim','human-answer']) insert.run(id,conv.id,`bot-decision:${id}`,new Date(BASE.getTime()-1000).toISOString());
    expect(humanDecisionAnswerWake(db,'human-answer')).toBe(true);
    expect(humanDecisionAnswerWake(db,'bot-answer')).toBe(false);
    expect(humanDecisionAnswerWake(db,'claim')).toBe(false);
    expect(humanDecisionAnswerWake(db,'ordinary-0')).toBe(false);
    scheduler.tick();
    expect(canDispatch.mock.calls[0]?.[0]).toMatchObject({id:'human-answer'});
    expect(canDispatch.mock.calls.map(([row])=>row.id)).not.toContain('bot-answer');
    expect(db.prepare("SELECT status FROM conversation_wakeups WHERE id='human-answer'").get()).toEqual({status:'cancelled'});
  });

  function periodic() {
    db.prepare('INSERT INTO bot_registrations(conversation_id,name,registered_by) VALUES(?,?,1)').run(conv.id, 'Backup');
    const user = db.prepare('SELECT * FROM users WHERE id=1').get() as UserRow;
    const r = saveRoutine(db, user, conv.id, {
      name: 'Backup', instructions: 'Check changed work', kind: 'schedule',
      schedule: {type: 'cron', expression: '* * * * *'}, enabled: true,
    });
    db.prepare('UPDATE bot_routines SET next_run_at=? WHERE id=?').run(BASE.toISOString(), r.id);
    return r;
  }

  function legacyCheck(r: Routine, id: string, minute: number, queued = true, trigger: string | null = null) {
    const at = new Date(BASE.getTime() + minute * 60_000).toISOString();
    const reason = routineReason(r.name, r.instructions, `Scheduled for ${at}`);
    db.prepare('INSERT INTO conversation_wakeups(id,conversation_id,actor_user_id,wake_key,reason,scheduled_for,status) VALUES(?,?,1,?,?,?,?)')
      .run(id, conv.id, `bot-routine:${r.id}:${id}`, reason, at, queued ? 'delivered' : 'pending');
    db.prepare('INSERT INTO bot_routine_deliveries(id,routine_id,event_id,wakeup_id,trigger_kind) VALUES(?,?,?,?,?)')
      .run(id, r.id, `schedule:${at}`, id, trigger);
    if (!queued) return null;
    const prompt = `Hey, can you pick this back up for me?\n\n${reason}\n\nPlease check what changed while you were away before you continue.`;
    const messageId = Number(db.prepare("INSERT INTO queued_messages(conversation_id,prompt,actor_user_id,origin_json,sort_order) VALUES(?,?,1,?,?)")
      .run(conv.id, prompt, JSON.stringify({kind:'wakeup',from:'Backup',to:'Backup'}), minute).lastInsertRowid);
    db.prepare("INSERT INTO hub_inbound_messages(idempotency_key,conversation_id,message_id,source_kind) VALUES(?,?,?,'wakeup')")
      .run(`wakeup:${id}`, conv.id, messageId);
    return messageId;
  }

  it('keeps one periodic backup behind a busy chat, then permits one behind its running check', async () => {
    periodic();
    manager.postMessage(conv, 'Real work');
    await flush();
    for (let minute = 0; minute < 8; minute++) {
      current = new Date(BASE.getTime() + minute * 60_000);
      tickRoutines(db, current);
      scheduler.tick();
    }
    expect(db.prepare('SELECT count(*) n FROM queued_messages').get()).toEqual({n:1});
    expect(db.prepare('SELECT count(*) n FROM bot_routine_deliveries').get()).toEqual({n:8});
    expect(adapter.runs).toHaveLength(1);
    adapter.runs[0]!.finish();
    await flush();
    expect(adapter.runs).toHaveLength(2);
    current = new Date(BASE.getTime() + 8 * 60_000);
    tickRoutines(db, current); scheduler.tick();
    expect(db.prepare('SELECT count(*) n FROM queued_messages').get()).toEqual({n:1});
    expect(adapter.runs).toHaveLength(2);
  });

  it('runs routine wakes of a registered bot in its lane, keeps one backup there, and never delays the human', async () => {
    periodic(); // registers wake-conv as a bot
    for (let minute = 0; minute < 6; minute++) {
      current = new Date(BASE.getTime() + minute * 60_000);
      tickRoutines(db, current);
      scheduler.tick();
      await flush();
    }
    const lane = (db.prepare("SELECT conversation_id FROM coordination_lanes WHERE owner_id='wake-conv'").get() as {conversation_id:string}).conversation_id;
    expect(adapter.runs).toHaveLength(1);
    // Same backlog bound as a chat without a lane: one running, at most two behind it.
    expect(db.prepare('SELECT conversation_id, count(*) n FROM queued_messages GROUP BY 1').all()).toEqual([{conversation_id:lane,n:2}]);
    expect(db.prepare('SELECT count(*) n FROM bot_routine_deliveries').get()).toEqual({n:6});
    expect((db.prepare('SELECT count(*) n FROM conversation_wakeups').get() as {n:number}).n).toBeLessThan(6);
    expect(db.prepare("SELECT count(*) n FROM turn_origins WHERE conversation_id='wake-conv'").get()).toEqual({n:0});
    expect(manager.postMessage(conv, 'Human ask').disposition).toBe('running');
    await flush();
    expect(adapter.runs).toHaveLength(2);
    expect(adapter.runs[1]!.prompt).toContain('Human ask');
    adapter.runs[0]!.finish(); adapter.runs[1]!.finish();
    await flush();
    expect(adapter.runs).toHaveLength(3);
    expect(adapter.runs[2]!.prompt).toContain('Run your routine');
    adapter.runs[2]!.finish(); await flush();
  });

  it('coalesces proven legacy backlog at startup without replaying it or losing receipts', async () => {
    const r = periodic();
    const keep = legacyCheck(r, 'old-1', 0);
    legacyCheck(r, 'old-2', 1);
    legacyCheck(r, 'old-3', 2, false);
    manager.resumeInterruptedTurns();
    await flush();
    expect(adapter.runs).toHaveLength(1);
    expect(db.prepare('SELECT count(*) n FROM bot_routine_coalescing').get()).toEqual({n:2});
    expect(db.prepare('SELECT count(*) n FROM hub_inbound_messages').get()).toEqual({n:2});
    expect(db.prepare('SELECT count(*) n FROM queued_messages').get()).toEqual({n:0});
    expect(manager.deliverWakeup(conv, 'ignored retry', 'old-2').disposition).toBe('duplicate');
    expect(db.prepare('SELECT message_id FROM hub_inbound_messages WHERE idempotency_key=?').get('wakeup:old-1')).toEqual({message_id:keep});
    adapter.runs[0]!.finish(); await flush();
    expect(adapter.runs).toHaveLength(1);
  });

  it('preserves events, one-shots, edited messages, unrelated messages and uncertain dispatches', () => {
    const r = periodic();
    legacyCheck(r, 'keep', 0);
    legacyCheck(r, 'redundant', 1);
    const event = legacyCheck(r, 'event', 2, true, 'event');
    const once = legacyCheck(r, 'once', 3, true, 'once');
    const edited = legacyCheck(r, 'edited', 4);
    db.prepare('UPDATE queued_messages SET prompt=? WHERE id=?').run('Human correction', edited);
    const unknown = legacyCheck(r, 'unknown', 5);
    db.prepare("INSERT INTO turn_origins(conversation_id,turn_id,prompt_text,event_at,message_id,origin_json) VALUES(?,'uncertain','opaque',?,?,?)")
      .run(conv.id, BASE.toISOString(), unknown, '{}');
    const protectedId = legacyCheck(r, 'steering', 6)!;
    const dispatched = legacyCheck(r, 'dispatched', 7)!;
    db.prepare('DELETE FROM queued_messages WHERE id=?').run(dispatched);
    const human = Number(db.prepare('INSERT INTO queued_messages(conversation_id,prompt) VALUES(?,?)').run(conv.id, 'Run your routine Backup').lastInsertRowid);
    expect(coalescePeriodicChecks(db, conv.id, new Set([protectedId]))).toHaveLength(1);
    const ids = (db.prepare('SELECT id FROM queued_messages').all() as {id:number}[]).map(x=>x.id);
    for (const id of [event, once, edited, unknown, protectedId, human]) expect(ids).toContain(id);
    expect(db.prepare("SELECT status FROM conversation_wakeups WHERE id='dispatched'").get()).toEqual({status:'delivered'});
    expect(coalescePeriodicChecks(db, conv.id, new Set([protectedId]))).toEqual([]);
  });

  it('keeps distinct routines and ambiguous legacy provenance separate', () => {
    const r = periodic();
    legacyCheck(r, 'one', 0);
    legacyCheck(r, 'two', 1);
    db.prepare("UPDATE bot_routine_deliveries SET event_id='source:real-event' WHERE id='two'").run();
    const r2 = {...r, id:'second'};
    db.prepare("INSERT INTO bot_routines(id,conversation_id,created_by,name,instructions,kind,schedule_json,timezone,enabled) VALUES(?,?,1,?,?,'schedule',?,'UTC',1)")
      .run(r2.id, conv.id, r2.name, r2.instructions, r2.schedule_json);
    legacyCheck(r2, 'three', 2);
    expect(coalescePeriodicChecks(db,conv.id)).toEqual([]);
    expect(db.prepare('SELECT count(*) n FROM queued_messages').get()).toEqual({n:3});
  });

  it('coalesces pending wakeups before dispatch even when the scheduler already read the due batch', async () => {
    const r = periodic();
    manager.postMessage(conv,'Busy'); await flush();
    legacyCheck(r, 'pending-1', 0, false);
    legacyCheck(r, 'pending-2', 1, false);
    current = new Date(BASE.getTime()+120_000);
    scheduler.tick();
    expect(db.prepare('SELECT count(*) n FROM queued_messages').get()).toEqual({n:1});
    expect(db.prepare("SELECT status FROM conversation_wakeups WHERE id='pending-2'").get()).toEqual({status:'cancelled'});
    adapter.runs[0]!.finish(); await flush();
    expect(adapter.runs).toHaveLength(2);
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
