import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { migrate } from '../src/db/migrate.js';
import {
  classifyTurnOrigin, effectiveDailyBudget, governorFlags, overBudget, recordTurnUsage,
} from '../src/tokenGovernor/store.js';
import { referencedIds, rotationCheck, writeRotationHandoff } from '../src/tokenGovernor/rotation.js';
import { createWakeGovernor, localSlot, stripVolatile } from '../src/tokenGovernor/precheck.js';
import { createConversationWakeupScheduler } from '../src/scheduled/wakeups.js';
import type { ConversationRow, ConversationWakeupRow } from '../src/db/db.js';
import type { ConversationEvent } from '../src/runtime/events.js';

let db: Database.Database;
let tmp: string;
const BOT = 'bot-1';
const quiet = { info: () => {}, warn: () => {}, error: () => {} };

beforeEach(() => {
  db = new Database(':memory:');
  migrate(db, path.resolve('src/db/migrations'));
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'token-governor-'));
  db.prepare("INSERT INTO users(id,email,display_name,role) VALUES(1,'owner@example.com','Owner','owner')").run();
  for (const id of [BOT, 'lane-1', 'chief', 'other']) {
    db.prepare("INSERT INTO conversations(id,assistant_id,user_id,provider,native_session_id) VALUES(?,1,1,'codex',?)").run(id, `native-${id}`);
  }
  db.prepare("INSERT INTO bot_registrations(conversation_id,name,active,registered_by) VALUES(?, 'AutoShip Worker', 1, 1), ('chief', 'Archer', 1, 1)").run(BOT);
  db.prepare("INSERT INTO chief_of_staff_bots(conversation_id, owner_id) VALUES('chief', 1)").run();
  db.prepare('INSERT INTO token_governor_bots(conversation_id, rotation, precheck, budget) VALUES(?, 1, 1, 1)').run(BOT);
});

afterEach(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.useRealTimers();
});

function usage(conversationId: string, turnId: string, tokens: number, finishedAt: string, outcome: 'completed' | 'failed' = 'completed') {
  recordTurnUsage(db, {
    conversationId, turnId, origin: 'routine', wakeKey: null, provider: 'codex', outcome,
    usage: { inputTokens: 200_000, outputTokens: 10, totalInputTokens: tokens, totalOutputTokens: 0, totalTokens: tokens, cachedInputTokens: tokens - 1, modelCalls: 5 },
    startedAt: new Date(finishedAt), finishedAt: new Date(finishedAt),
  });
}

describe('ledger and budget', () => {
  it('classifies turn origins so human and James work is never treated as background', () => {
    expect(classifyTurnOrigin({ promptText: 'hello', channel: 'web', wakeKey: null })).toBe('human');
    expect(classifyTurnOrigin({ promptText: '[James link 12] do it', channel: 'web', wakeKey: null })).toBe('james');
    expect(classifyTurnOrigin({ promptText: 'x', channel: 'automation', wakeKey: null })).toBe('automation');
    const wake = { kind: 'wakeup' as const, from: 'a', to: 'a' };
    expect(classifyTurnOrigin({ origin: wake, promptText: 'x', channel: 'web', wakeKey: 'bot-routine:r:1' })).toBe('routine');
    expect(classifyTurnOrigin({ origin: wake, promptText: 'x', channel: 'web', wakeKey: 'follow-up' })).toBe('wakeup');
    expect(classifyTurnOrigin({ origin: { ...wake, humanTaskNote: true }, promptText: 'x', channel: 'web', wakeKey: null })).toBe('human');
    expect(classifyTurnOrigin({ origin: { kind: 'agent', from: 'b', to: 'a' }, promptText: 'x', channel: 'web', wakeKey: null })).toBe('agent');
  });

  it('attributes lane turns to the owning bot and records whole-turn tokens', () => {
    db.prepare("INSERT INTO coordination_threads(id,left_id,right_id) VALUES('t1', ?, 'other')").run(BOT);
    db.prepare("INSERT INTO coordination_lanes(conversation_id,thread_id,owner_id) VALUES('lane-1','t1',?)").run(BOT);
    usage('lane-1', 'turn-a', 5_000_000, '2026-11-03T10:00:00.000Z');
    expect(db.prepare('SELECT bot_id, input_tokens, model_calls, context_tokens FROM turn_token_usage').get())
      .toEqual({ bot_id: BOT, input_tokens: 5_000_000, model_calls: 5, context_tokens: 200_000 });
    expect(governorFlags(db, 'lane-1')?.botId).toBe(BOT);
  });

  it('sets an automatic budget from the bot’s own history and alerts the chief of staff once after repeated overruns', () => {
    const flags = governorFlags(db, BOT)!;
    const now = new Date('2026-11-10T12:00:00.000Z');
    expect(effectiveDailyBudget(db, flags, now)).toBeNull();
    for (const day of ['04', '05', '06', '07']) usage(BOT, `d${day}`, 30_000_000, `2026-11-${day}T12:00:00.000Z`);
    expect(effectiveDailyBudget(db, flags, now)).toBe(45_000_000);
    usage(BOT, 'today', 50_000_000, '2026-11-10T11:00:00.000Z');
    // Three exceeded days inside a week trigger exactly one note.
    for (const day of ['2026-11-08', '2026-11-09']) {
      db.prepare("INSERT INTO token_governor_events(bot_id,kind,at) VALUES(?, 'budget_exceeded', ?)").run(BOT, `${day}T12:00:00.000Z`);
    }
    expect(overBudget(db, flags, now)).toBe(true);
    expect(overBudget(db, flags, now)).toBe(true);
    const alerts = db.prepare("SELECT conversation_id, reason FROM conversation_wakeups WHERE wake_key LIKE 'token-governor-alert:%'").all() as { conversation_id: string; reason: string }[];
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.conversation_id).toBe('chief');
    expect(alerts[0]!.reason).toContain('AutoShip Worker');
    expect(db.prepare("SELECT COUNT(*) AS n FROM token_governor_events WHERE kind='budget_alert'").get()).toEqual({ n: 1 });
  });
});

describe('context rotation', () => {
  const base = () => ({ conversationId: BOT, provider: 'codex', contextTokens: 200_000, flags: governorFlags(db, BOT), firstTurn: false });

  it('rotates only past the threshold after a completed turn, and never with an unresolved effect', () => {
    expect(rotationCheck(db, { ...base(), flags: null }).reason).toBe('off');
    expect(rotationCheck(db, { ...base(), contextTokens: 120_000 }).reason).toBe('below_threshold');
    expect(rotationCheck(db, base()).reason).toBe('previous_turn_not_completed');
    usage(BOT, 'failed', 1_000, '2026-11-03T10:00:00.000Z', 'failed');
    expect(rotationCheck(db, base()).reason).toBe('previous_turn_not_completed');
    usage(BOT, 'ok', 1_000, '2026-11-03T11:00:00.000Z');
    expect(rotationCheck(db, base())).toMatchObject({ rotate: true, threshold: 150_000 });
    const unknown: ConversationEvent[] = [{ type: 'text_final', turnId: 't', markdown: 'The label purchase outcome remains UNKNOWN; reconcile first.', at: 'x' }];
    expect(rotationCheck(db, { ...base(), recentEvents: unknown }).reason).toBe('unknown_effect_in_reply');
    expect(rotationCheck(db, { ...base(), provider: 'grok' }).reason).toBe('provider');
  });

  it('waits three turns after a rotation before rotating again', () => {
    usage(BOT, 'ok', 1_000, '2026-11-03T11:00:00.000Z');
    db.prepare("INSERT INTO token_governor_events(bot_id,conversation_id,kind,at) VALUES(?, ?, 'rotation', '2026-11-03T11:30:00.000Z')").run(BOT, BOT);
    usage(BOT, 'after-1', 1_000, '2026-11-03T12:00:00.000Z');
    expect(rotationCheck(db, base()).reason).toBe('recently_rotated');
    usage(BOT, 'after-2', 1_000, '2026-11-03T12:10:00.000Z');
    usage(BOT, 'after-3', 1_000, '2026-11-03T12:20:00.000Z');
    expect(rotationCheck(db, base()).rotate).toBe(true);
  });

  it('hands over open work, owner directions and ids with a short recent excerpt', () => {
    db.prepare("INSERT INTO conversation_wakeups(id,conversation_id,wake_key,reason,scheduled_for) VALUES('w1', ?, 'follow-100122966', 'Check carrier pickup', '2026-11-03T15:00:00Z')").run(BOT);
    db.prepare("INSERT INTO bot_tasks(id,owner_conversation_id,title,status,status_line) VALUES('task1', ?, 'Reship 100122515', 'working', 'Waiting on supplier')").run(BOT);
    const events: ConversationEvent[] = [
      { type: 'turn_started', turnId: 't1', role: 'user', text: 'Nick: hold order 100122410 until Friday', at: '2026-11-02T10:00:00.000Z', via: 'web' },
      { type: 'text_final', turnId: 't1', markdown: 'Holding 100122410; ticket VLDD79 noted.', at: '2026-11-02T10:01:00.000Z' },
      { type: 'turn_started', turnId: 't2', role: 'user', text: 'routine wake', at: '2026-11-03T10:00:00.000Z', via: 'web', origin: { kind: 'wakeup', from: 'a', to: 'a' } },
      { type: 'text_final', turnId: 't2', markdown: 'x'.repeat(30_000), at: '2026-11-03T10:01:00.000Z' },
    ];
    const handoff = writeRotationHandoff(db, { cwd: tmp, conversationId: BOT, botId: BOT, events, previousContextTokens: 212_000, now: new Date('2026-11-03T12:00:00Z') });
    expect(handoff).toContain('Context rotation for the SAME chat');
    expect(handoff).toContain('212,000');
    expect(handoff).toContain('- Reship 100122515 [working] — Waiting on supplier (task task1)');
    expect(handoff).toContain('follow-100122966 at 2026-11-03T15:00:00Z: Check carrier pickup');
    expect(handoff).toContain('2026-11-02T10:00:00.000Z: Nick: hold order 100122410 until Friday');
    expect(handoff).not.toContain('routine wake\n');
    expect(handoff).toContain('orders 100122410');
    expect(handoff).toContain('tickets VLDD79');
    expect(handoff.length).toBeLessThan(30_000);
    const file = /Full redacted record of this chat: (\S+)/.exec(handoff)![1]!;
    expect(fs.readFileSync(file, 'utf8')).toContain('Holding 100122410');
    expect(referencedIds('ABCDEF 123456 A1B2C3').tickets).toEqual(['A1B2C3']);
  });
});

describe('wake precheck', () => {
  function addRoutine(config: object, timezone = 'America/Indiana/Indianapolis') {
    db.prepare(`INSERT INTO bot_routines(id,conversation_id,created_by,name,instructions,kind,schedule_json,timezone,enabled,next_run_at)
      VALUES('r1', ?, 1, 'Reply review', 'Review replies', 'schedule', '{"type":"cron","expression":"*/30 * * * *"}', ?, 1, '2026-11-03T12:00:00Z')`).run(BOT, timezone);
    db.prepare('INSERT INTO routine_prechecks(routine_id, config_json) VALUES(?, ?)').run('r1', JSON.stringify(config));
  }
  function wake(id: string, key = `bot-routine:r1:${id}`, eventId?: string, reason = 'Run the routine'): ConversationWakeupRow {
    db.prepare("INSERT INTO conversation_wakeups(id,conversation_id,wake_key,reason,scheduled_for) VALUES(?, ?, ?, ?, '2026-11-03T00:00:00Z')").run(id, BOT, key, reason);
    if (key.startsWith('bot-routine:')) {
      db.prepare("INSERT INTO bot_routine_deliveries(id,routine_id,event_id,wakeup_id,trigger_kind) VALUES(?, 'r1', ?, ?, 'periodic')").run(id, eventId ?? `manual:${id}`, id);
    }
    return db.prepare('SELECT * FROM conversation_wakeups WHERE id=?').get(id) as ConversationWakeupRow;
  }
  const conv = () => db.prepare('SELECT * FROM conversations WHERE id=?').get(BOT) as ConversationRow;
  async function settle(gov: ReturnType<typeof createWakeGovernor>, row: ConversationWakeupRow) {
    expect(gov.gate(row, conv())).toEqual({ action: 'wait' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    return gov.gate(row, conv());
  }

  it('wakes on the first run and on change, skips an unchanged source, and wakes again at the limit', async () => {
    addRoutine({ kind: 'http_json', urls: ['https://orderops.example/replies'], secret: { name: 'TOKEN', project: 'ervp', config: 'prd' }, maxSkipMinutes: 120 });
    let body: unknown = { replies: [], generatedAt: '1' };
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>).authorization).toBe('Bearer secret-value');
      return new Response(JSON.stringify(body), { status: 200 });
    });
    let clock = new Date('2026-11-03T12:00:00.000Z');
    const gov = createWakeGovernor({ db, readSecret: async () => 'secret-value', composioApiKey: () => null, fetchImpl: fetchImpl as typeof fetch, now: () => clock });
    expect(await settle(gov, wake('a'))).toEqual({ action: 'deliver' });
    clock = new Date('2026-11-03T12:30:00.000Z');
    body = { replies: [], generatedAt: '2' };
    expect(await settle(gov, wake('b'))).toMatchObject({ action: 'skip' });
    body = { replies: [{ sessionId: 's1' }], generatedAt: '3' };
    expect(await settle(gov, wake('c'))).toEqual({ action: 'deliver' });
    clock = new Date('2026-11-03T14:31:00.000Z');
    expect(await settle(gov, wake('d'))).toEqual({ action: 'deliver' });
    const kinds = db.prepare("SELECT kind, json_extract(detail_json, '$.reason') AS reason FROM token_governor_events ORDER BY id").all();
    expect(kinds).toEqual([
      { kind: 'precheck_wake', reason: 'first_run' },
      { kind: 'precheck_skip', reason: null },
      { kind: 'precheck_wake', reason: 'changed' },
      { kind: 'precheck_wake', reason: 'max_skip_reached' },
    ]);
  });

  it('fails open when the probe errors and always runs forced local slots', async () => {
    addRoutine({ kind: 'gmail', connectorIds: [99], query: 'in:inbox', forceSlots: { weekdays: [2], times: ['10:30'] } });
    const gov = createWakeGovernor({ db, readSecret: async () => '', composioApiKey: () => 'key' });
    expect(await settle(gov, wake('a'))).toEqual({ action: 'deliver' });
    expect(db.prepare("SELECT json_extract(detail_json,'$.error') AS e FROM token_governor_events").get()).toEqual({ e: 'Gmail connector 99 is not connected' });

    db.prepare("INSERT INTO user_connectors(id,user_id,connector_slug,label,status,config_json) VALUES(99,1,'gmail','accounting','connected','{\"sessionId\":\"s\"}')").run();
    const execute = vi.fn(async () => ({ successful: true, data: { messages: [{ messageId: 'm1' }] } }));
    let clock = new Date('2026-11-03T15:00:00.000Z');
    const gmail = createWakeGovernor({ db, readSecret: async () => '', composioApiKey: () => 'key', composioExecute: execute, now: () => clock });
    expect(await settle(gmail, wake('b'))).toEqual({ action: 'deliver' }); // signature changed from the failed run
    clock = new Date('2026-11-03T15:30:00.000Z');
    expect(await settle(gmail, wake('c', undefined, 'schedule:2026-11-03T15:30:00.000Z'))).toEqual({ action: 'deliver' }); // Tue 10:30 local
    expect(await settle(gmail, wake('d', undefined, 'schedule:2026-11-03T16:00:00.000Z'))).toMatchObject({ action: 'skip' });
    expect(execute).toHaveBeenCalledWith('key', 's', 'GMAIL_FETCH_EMAILS', expect.objectContaining({ query: 'in:inbox', ids_only: true }));
  });

  it('never prechecks event wakes, ignores bots without the switch, and leaves event routines alone', () => {
    const gov = createWakeGovernor({ db, readSecret: async () => '', composioApiKey: () => null });
    expect(gov.gate(wake('e', 'bot-decision:abc'), conv())).toEqual({ action: 'deliver' });
    expect(gov.gate(wake('h', 'huddle:h1'), conv())).toEqual({ action: 'deliver' });
    db.prepare('UPDATE token_governor_bots SET precheck = 0').run();
    expect(gov.gate(wake('f', 'follow-up'), conv())).toEqual({ action: 'deliver' });
  });

  it('spaces out a self-wake that keeps firing with nothing new, but never customer or shipping work', () => {
    const clock = new Date('2026-11-03T12:00:00.000Z');
    const gov = createWakeGovernor({ db, readSecret: async () => '', composioApiKey: () => null, now: () => clock });
    for (const [i, at] of ['11:00', '11:15', '11:50'].entries()) {
      db.prepare("INSERT INTO conversation_wakeups(id,conversation_id,wake_key,reason,scheduled_for,status,delivered_at) VALUES(?, ?, 'floor-print-watch', 'Check the PDF', ?, 'delivered', ?)")
        .run(`old${i}`, BOT, `2026-11-03T${at}:00.000Z`, `2026-11-03T${at}:00.000Z`);
      db.prepare("INSERT INTO conversation_wakeups(id,conversation_id,wake_key,reason,scheduled_for,status,delivered_at) VALUES(?, ?, 'shipment-followthrough', 'x', ?, 'delivered', ?)")
        .run(`ship${i}`, BOT, `2026-11-03T${at}:00.000Z`, `2026-11-03T${at}:00.000Z`);
    }
    const decision = gov.gate(wake('n', 'floor-print-watch', undefined, 'Check the PDF'), conv());
    expect(decision).toMatchObject({ action: 'defer', until: new Date('2026-11-03T12:20:00.000Z') });
    expect(gov.gate(wake('s', 'shipment-followthrough', undefined, 'x'), conv())).toEqual({ action: 'deliver' });
    // A human message since the last delivery wakes right away.
    db.prepare("INSERT INTO hub_inbound_messages(idempotency_key,conversation_id,message_id,created_at) VALUES('k', ?, 1, '2026-11-03 11:55:00')").run(BOT);
    db.prepare("UPDATE conversation_wakeups SET status='cancelled' WHERE id='n'").run();
    expect(gov.gate(wake('n2', 'floor-print-watch', undefined, 'Check the PDF'), conv())).toEqual({ action: 'deliver' });
  });

  it('coalesces a wake identical to one already queued, and the scheduler applies skip and defer', async () => {
    const gov = createWakeGovernor({ db, readSecret: async () => '', composioApiKey: () => null });
    db.prepare("INSERT INTO conversation_wakeups(id,conversation_id,wake_key,reason,scheduled_for,status) VALUES('q', ?, 'same', 'Same reason', '2026-11-03T00:00:00Z', 'delivered')").run(BOT);
    db.prepare("INSERT INTO queued_messages(id,conversation_id,prompt) VALUES(7, ?, 'p')").run(BOT);
    db.prepare("INSERT INTO hub_inbound_messages(idempotency_key,conversation_id,message_id,source_kind) VALUES('wakeup:q', ?, 7, 'wakeup')").run(BOT);
    expect(gov.gate(wake('dup', 'same', undefined, 'Same reason'), conv())).toMatchObject({ action: 'coalesce' });
    expect(gov.gate(wake('diff', 'same-2', undefined, 'Other reason'), conv())).toEqual({ action: 'deliver' });

    const deliverWakeup = vi.fn(() => ({ disposition: 'queued' }) as never);
    const scheduler = createConversationWakeupScheduler({ db, manager: { deliverWakeup }, log: quiet, governor: gov });
    db.prepare("DELETE FROM conversation_wakeups WHERE id='diff'").run();
    scheduler.tick();
    expect(db.prepare("SELECT status FROM conversation_wakeups WHERE id='dup'").get()).toEqual({ status: 'cancelled' });
    expect(deliverWakeup).not.toHaveBeenCalled();
  });

  it('normalizes volatile response fields and reads local slots in the routine time zone', () => {
    expect(stripVolatile({ b: 1, now: 'x', a: [{ generatedAt: 1, id: 2 }] })).toEqual({ a: [{ id: 2 }], b: 1 });
    expect(localSlot(new Date('2026-11-03T14:00:00.000Z'), 'America/Indiana/Indianapolis')).toEqual({ weekday: 2, time: '09:00' });
  });
});
