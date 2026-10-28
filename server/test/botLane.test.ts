import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import Database from 'better-sqlite3';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import type { ConversationRow, ConversationWakeupRow } from '../src/db/db.js';
import type { AppContext } from '../src/context.js';
import { createApiRouter } from '../src/routes/api.js';
import { coordinationFamily, coordinationLane, ensureCoordination } from '../src/coordination/store.js';
import {
  botLaneConversationId,
  botLaneOfConversation,
  ensureBotLane,
  hasBotLane,
  spliceSurfacedNotices,
  surfaceToHuman,
  surfacedRows,
  takeSurfacedContext,
  wakeTarget,
} from '../src/coordination/botLane.js';
import { canSendToConversation, canViewConversation } from '../src/conversations/access.js';
import { createConversationManager } from '../src/runtime/conversationManager.js';
import { createTaskService } from '../src/tasks/service.js';
import type { UserRow } from '../src/db/db.js';
import { mintAgentToken, resolveAgentTokenContext } from '../src/runtime/agentTokens.js';
import { createConversationWakeupScheduler } from '../src/scheduled/wakeups.js';
import type { ConversationEvent } from '../src/runtime/events.js';
import type { ProviderAdapter, TurnSpec } from '../src/providers/types.js';

const migrations = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/db/migrations');
let db: Database.Database;
const row = (id: string) => db.prepare('SELECT * FROM conversations WHERE id=?').get(id) as ConversationRow;
const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db, migrations);
  db.prepare(
    "INSERT INTO users(id,email,display_name,role) VALUES(1,'owner@example.com','Owner','owner'),(2,'other@example.com','Other','member')",
  ).run();
  for (const id of ['clara', 'anna'])
    db.prepare(
      "INSERT INTO conversations(id,assistant_id,user_id,title,provider,native_session_id,channel,visibility) VALUES(?,1,1,?,'claude',?,'web','team')",
    ).run(id, id, `session-${id}`);
  db.prepare("INSERT INTO bot_registrations(conversation_id,name,active,registered_by) VALUES('clara','Clara',1,1),('anna','Anna',1,1)").run();
});
afterEach(async () => {
  await tick();
  db.close();
});

const registered = (id: string, active: boolean) =>
  db.prepare('UPDATE bot_registrations SET active=? WHERE conversation_id=?').run(active ? 1 : 0, id);
function enable(id = 'clara') {
  return ensureBotLane(db, row(id));
}

describe('bot lane session', () => {
  it('is created once per enrolled bot, as an internal session with the bot identity and its own native session', () => {
    // Default for every active registered bot; no switch and no stored opt-in.
    expect(hasBotLane(db, 'clara')).toBe(true);
    expect(db.prepare('SELECT count(*) n FROM bot_lanes').get()).toEqual({ n: 0 });
    registered('clara', false);
    expect(() => ensureBotLane(db, row('clara'))).toThrow('registered bot');
    registered('clara', true);
    const lane = enable();
    expect(hasBotLane(db, lane.id)).toBe(false);
    expect(enable().id).toBe(lane.id);
    expect(lane.side_chat_of).toBe('clara');
    expect(lane.native_session_id).not.toBe(row('clara').native_session_id);
    for (const field of ['assistant_id', 'user_id', 'project_id', 'provider', 'model', 'business_team_id'] as const)
      expect(lane[field], field).toEqual(row('clara')[field]);
    expect(botLaneOfConversation(db, lane.id)?.owner_id).toBe('clara');
    expect(coordinationLane(db, lane.id)?.owner_id).toBe('clara');
    expect(coordinationFamily(db, 'clara')).toContain(lane.id);
    // Visible exactly where the human chat is; never an ordinary send target.
    expect(canViewConversation({ id: 2 }, lane, db)).toBe(true);
    expect(canSendToConversation({ id: 1 }, lane, db)).toBe(false);
    db.prepare("UPDATE conversations SET visibility='private' WHERE id='clara'").run();
    expect(canViewConversation({ id: 2 }, lane, db)).toBe(false);
    const context = resolveAgentTokenContext(db, mintAgentToken(db, 'owner@example.com', 'clara', lane.id));
    expect(context).toMatchObject({ conversationId: 'clara', executionConversationId: lane.id });
  });

  it('routes bot traffic to the lane for every registered bot and keeps human-started wakes in the human chat', () => {
    const wake = (id: string, key: string) => wakeTarget(db, row(id), crypto.randomUUID(), key).id;
    db.prepare("INSERT INTO conversations(id,assistant_id,user_id,title,provider,native_session_id,channel,visibility) VALUES('plain',1,1,'plain','claude','s-plain','web','team')").run();
    expect(wake('plain', 'bot-routine:r1:w1')).toBe('plain'); // not a registered bot: unchanged
    const lane = wake('clara', 'bot-routine:r1:w1');
    expect(lane).not.toBe('clara');
    expect(botLaneOfConversation(db, lane)?.owner_id).toBe('clara');
    for (const key of ['huddle:h1', 'question-recheck:2026-10-13T16', 'decision-handoff:request:h1', 'autoship-candidate:c1'])
      expect(wake('clara', key), key).toBe(lane);
    // Every registered bot, not one: Anna gets her own lane.
    const annaLane = wake('anna', 'huddle:h2');
    expect(annaLane).not.toBe('anna');
    expect(annaLane).not.toBe(lane);
    for (const key of ['bot-decision:d1', 'message-draft:m1', 'message-revise:m1', 'message-thread:t1', 'clara-follow-up', 'browser-capacity:x'])
      expect(wake('clara', key), key).toBe('clara');
    registered('clara', false);
    expect(wake('clara', 'bot-routine:r1:w2')).toBe('clara');
  });

  it('keeps a retried wake in the session its first delivery used', () => {
    const lane = enable();
    db.prepare(
      "INSERT INTO hub_inbound_messages(idempotency_key,conversation_id,message_id,source_kind) VALUES('wakeup:w-lane',?,1,'wakeup'),('wakeup:w-human','clara',2,'wakeup')",
    ).run(lane.id);
    registered('clara', false);
    expect(wakeTarget(db, row('clara'), 'w-lane', 'huddle:h').id).toBe(lane.id);
    registered('clara', true);
    expect(wakeTarget(db, row('clara'), 'w-human', 'huddle:h').id).toBe('clara');
  });

  it('delivers due wakes through the scheduler into the lane', () => {
    const lane = enable();
    const deliverWakeup = vi.fn(() => ({ messageId: 1, disposition: 'queued' as const, queue: { revision: 1, messages: [], failedTurn: null } }));
    const scheduler = createConversationWakeupScheduler({
      db,
      manager: { deliverWakeup } as never,
      bus: new EventEmitter(),
      tickMs: 60_000,
      log: { info: () => {}, warn: () => {}, error: () => {} },
    } as never);
    const insert = db.prepare("INSERT INTO conversation_wakeups(id,conversation_id,wake_key,reason,scheduled_for,actor_user_id) VALUES(?,?,?,?,datetime('now','-1 minute'),1)");
    insert.run('w1', 'clara', 'huddle:h1', 'New huddle posts');
    insert.run('w2', 'clara', 'my-follow-up', 'Finish Mackenzie’s request');
    scheduler.start();
    scheduler.stop?.();
    const targets = (deliverWakeup.mock.calls as unknown as [ConversationRow, string, string][]).map(([c, , id]) => [id, c.id]);
    expect(targets).toContainEqual(['w1', lane.id]);
    expect(targets).toContainEqual(['w2', 'clara']);
    expect((db.prepare("SELECT conversation_id FROM conversation_wakeups WHERE id='w1'").get() as { conversation_id: string }).conversation_id).toBe('clara');
  });
});

function fakeProvider() {
  const turns: Array<{ spec: TurnSpec; finish: () => void }> = [];
  const adapter: ProviderAdapter = {
    id: 'claude',
    mintSessionId: () => crypto.randomUUID(),
    readTranscript: async () => [],
    runTurn(spec) {
      let finish!: () => void;
      const done = new Promise<void>((r) => (finish = r));
      turns.push({ spec, finish });
      return { done, kill: () => finish(), respondToApproval: () => true };
    },
  };
  return { turns, adapter };
}

describe('human priority and lane parity', () => {
  function managerWith(adapter: ProviderAdapter, materialize = vi.fn((..._args: unknown[]) => ({ mcpConfigPath: null, settingsPath: null, developerInstructions: 'fixed', instructionHash: null }))) {
    const manager = createConversationManager({
      db,
      adapters: { claude: adapter },
      resolveWorkspace: () => ({ workspaceDir: '/tmp', assistantSlug: 'assistant', elevated: false }),
      materialize: materialize as never,
      log: { warn: () => {}, error: () => {} },
    });
    return { manager, materialize };
  }

  it('starts a human turn immediately while the lane works, and the lane waits behind human work', async () => {
    const { turns, adapter } = fakeProvider();
    const { manager, materialize } = managerWith(adapter);
    const lane = enable();
    // Started by another user's routine: the lane still gets the bot owner's connectors.
    expect(manager.deliverWakeup(lane, 'Run your routine', 'w-1', 2).disposition).toBe('running');
    await tick();
    expect(turns).toHaveLength(1);
    expect(turns[0]!.spec.nativeSessionId).toBe(lane.native_session_id);
    // Same identity, skills, memory and connectors: materialized as the bot,
    // in a separate execution session with its own spawn files.
    expect(materialize.mock.calls[0]![2]).toBe('clara');
    expect(materialize.mock.calls[0]![5]).toBe(lane.id);
    expect(materialize.mock.calls[0]![3]).toBe(2);
    expect(materialize.mock.calls[0]![6]).toBe(1);
    expect(turns[0]!.spec.developerInstructions).toContain('bot lane');
    expect(turns[0]!.spec.developerInstructions).toContain('surface_to_human');

    const human = manager.postMessage(row('clara'), 'Mackenzie: please enter this bill');
    expect(human.disposition).toBe('running');
    await tick();
    expect(turns).toHaveLength(2);
    expect(turns[1]!.spec.nativeSessionId).toBe('session-clara');
    expect(materialize.mock.calls[1]![5]).toBeUndefined();
    expect(materialize.mock.calls[1]![6]).toBe(1); // the human chat keeps its turn actor

    // Lane work arriving while the human turn runs waits for it.
    const queued = manager.deliverWakeup(lane, 'Next routine', 'w-2', 1);
    expect(queued.disposition).toBe('queued');
    turns[0]!.finish();
    await tick();
    expect(turns).toHaveLength(2);
    turns[1]!.finish();
    await tick();
    expect(turns).toHaveLength(3);
    expect(turns[2]!.spec.nativeSessionId).toBe(lane.native_session_id);
    turns[2]!.finish();
    await tick();
  });

  it('runs a human note on a task at once, while the bot is busy elsewhere; automated task work still waits', async () => {
    const { turns, adapter } = fakeProvider();
    const { manager } = managerWith(adapter);
    const lane = enable();
    const user = db.prepare('SELECT * FROM users WHERE id=1').get() as UserRow;
    const made = createTaskService(db).intake({ user, conversationId: 'clara' }, { items: [1, 2, 3, 4].map((n) => ({ title: `Case ${n}`, case_key: `C${n}` })), source: 'human_dump' }).created;
    const chat = (n: number) => row(made[n]!.task_conversation_id!);
    const noteWake = (n: number) => {
      const id = crypto.randomUUID();
      db.prepare("INSERT INTO conversation_wakeups(id,conversation_id,actor_user_id,wake_key,reason,scheduled_for) VALUES(?,?,1,?,'note',datetime('now'))").run(id, 'clara', `bot-task:${made[n]!.id}:discuss:${id}`);
      return id;
    };
    // The bot is busy: its bot lane runs a huddle wake and its main chat runs a human turn.
    manager.deliverWakeup(lane, 'Huddle post', 'w-huddle', 1);
    await tick();
    manager.postMessage(row('clara'), 'Human in the main chat');
    await tick();
    expect(turns).toHaveLength(2);
    // Automated task work waits behind the busy main chat.
    expect(manager.deliverWakeup(chat(0), 'Start this task', 'w-start', 1).disposition).toBe('queued');
    await tick();
    expect(turns).toHaveLength(2);
    // Human notes on two tasks start right away.
    manager.deliverWakeup(chat(1), 'Nick wrote on task', noteWake(1), 1);
    manager.deliverWakeup(chat(2), 'Nick wrote on task', noteWake(2), 1);
    await tick();
    expect(turns.map((t) => t.spec.nativeSessionId).slice(2)).toEqual([chat(1).native_session_id, chat(2).native_session_id]);
    expect(manager.queueSnapshot(chat(0).id).messages).toHaveLength(1);
    // A third note waits for one of the two notes to finish, not for the main chat.
    manager.deliverWakeup(chat(3), 'Nick wrote on task', noteWake(3), 1);
    await tick();
    expect(turns).toHaveLength(4);
    turns[2]!.finish();
    await tick();
    expect(turns).toHaveLength(5);
    expect(turns[4]!.spec.nativeSessionId).toBe(chat(3).native_session_id);
    for (const t of turns) t.finish();
    await tick();
  });

  it('keeps a bot message’s urgent class through the durable queue', () => {
    const { adapter } = fakeProvider();
    const { manager } = managerWith(adapter);
    const { lane } = ensureCoordination(db, row('anna'), row('clara'));
    manager.postMessage(row('clara'), 'Human busy');
    manager.queueMessage(row(lane.conversation_id), 'Urgent', 1, { kind: 'agent', from: 'Anna', to: 'Clara', sourceConversationId: 'anna', priority: 'urgent' }, 'u');
    const stored = db.prepare('SELECT origin_json FROM queued_messages WHERE conversation_id=?').get(lane.conversation_id) as { origin_json: string };
    expect(JSON.parse(stored.origin_json)).toMatchObject({ priority: 'urgent' });
    expect(manager.queueSnapshot(lane.conversation_id).messages[0]!.origin).toMatchObject({ priority: 'urgent' });
  });

  it('keeps the old one-at-a-time order for a chat that is not a registered bot', async () => {
    const { turns, adapter } = fakeProvider();
    const { manager } = managerWith(adapter);
    registered('clara', false);
    const { lane } = ensureCoordination(db, row('anna'), row('clara'));
    manager.queueMessage(row(lane.conversation_id), 'Anna lookup', 1, { kind: 'agent', from: 'Anna', to: 'Clara', sourceConversationId: 'anna' }, 'k1');
    await tick();
    expect(turns).toHaveLength(1);
    expect(manager.postMessage(row('clara'), 'Human').disposition).toBe('queued');
    turns[0]!.finish();
    await tick();
    expect(turns).toHaveLength(2);
    turns[1]!.finish();
    await tick();
  });

  it('gives the human chat surfaced lines as reference context once, and shows them in its history', async () => {
    const { turns, adapter } = fakeProvider();
    const { manager } = managerWith(adapter);
    const lane = enable();
    const thread = botLaneOfConversation(db, lane.id)!.thread_id;
    surfaceToHuman(db, { ownerId: 'clara', laneConversationId: lane.id, threadId: thread, kind: 'urgent', sourceLabel: 'Anna', summary: 'QuickBooks login expired; bills cannot post', requestKey: 'k1' });
    manager.postMessage(row('clara'), 'What needs me?');
    await tick();
    expect(turns[0]!.spec.prompt).toContain('Urgent from Anna: QuickBooks login expired');
    expect(turns[0]!.spec.displayPrompt).not.toContain('QuickBooks');
    turns[0]!.finish();
    await tick();
    manager.postMessage(row('clara'), 'Thanks');
    await tick();
    expect(turns[1]!.spec.prompt).not.toContain('QuickBooks');
    turns[1]!.finish();
    await tick();
    const history = await manager.snapshot(row('clara'));
    expect(history).toContainEqual(expect.objectContaining({ type: 'notice', message: 'Urgent from Anna: QuickBooks login expired; bills cannot post', coordinationThreadId: thread }));
    expect(await manager.snapshot(lane)).not.toContainEqual(expect.objectContaining({ type: 'notice' }));
  });
});

describe('surfaced lines', () => {
  it('are one short line, idempotent per key, and sorted among human turns', () => {
    const lane = enable();
    const first = surfaceToHuman(db, { ownerId: 'clara', laneConversationId: lane.id, threadId: null, kind: 'result', sourceLabel: 'bot lane', summary: `Posted 12 bills\n\n${'x'.repeat(400)}`, requestKey: 'k' });
    expect(first.row.summary.length).toBeLessThanOrEqual(240);
    expect(first.row.summary).not.toContain('\n');
    expect(surfaceToHuman(db, { ownerId: 'clara', laneConversationId: lane.id, threadId: null, kind: 'result', sourceLabel: 'bot lane', summary: `Posted 12 bills\n\n${'x'.repeat(400)}`, requestKey: 'k' }).duplicate).toBe(true);
    expect(() => surfaceToHuman(db, { ownerId: 'clara', laneConversationId: lane.id, threadId: null, kind: 'result', sourceLabel: 'bot lane', summary: 'Other', requestKey: 'k' })).toThrow('different');
    const events: ConversationEvent[] = [
      { type: 'turn_started', turnId: 'a', role: 'user', text: 'before', at: '2000-01-01T00:00:00.000Z' } as ConversationEvent,
      { type: 'turn_started', turnId: 'b', role: 'user', text: 'after', at: '2999-01-01T00:00:00.000Z' } as ConversationEvent,
    ];
    const spliced = spliceSurfacedNotices(events, surfacedRows(db, 'clara'));
    expect(spliced.map((e) => e.type)).toEqual(['turn_started', 'notice', 'turn_started']);
    expect(takeSurfacedContext(db, 'clara')).toContain('Result from bot lane: Posted 12 bills');
    expect(takeSurfacedContext(db, 'clara')).toBeNull();
  });
});

describe('bot lane API', () => {
  async function api(identity: () => Record<string, unknown>) {
    const bus = new EventEmitter();
    const shown: Array<[string, ConversationEvent]> = [];
    bus.on('event', (id: string, event: ConversationEvent) => shown.push([id, event]));
    let n = 0;
    const queueMessage = vi.fn(async (conversationId: string, text: string, actor: number, origin: unknown, key: string) => {
      const prior = db.prepare('SELECT message_id FROM coordination_deliveries WHERE conversation_id=? AND request_key=?').get(conversationId, key) as { message_id: number } | undefined;
      if (prior) return { messageId: prior.message_id, disposition: 'duplicate', queue: { revision: 1, messages: [], failedTurn: null } };
      const id = ++n;
      db.prepare('INSERT INTO coordination_deliveries(conversation_id,request_key,payload_hash,message_id) VALUES(?,?,?,?)').run(conversationId, key, JSON.stringify([text, actor, origin]), id);
      return { messageId: id, disposition: 'queued', queue: { revision: 1, messages: [], failedTurn: null } };
    });
    const ctx = {
      db,
      manager: { bus, queueMessage, statusOf: async () => 'idle', snapshot: async () => [] },
      resolveIdentity: async () => identity(),
    } as unknown as AppContext;
    const app = express();
    app.use('/api', createApiRouter(ctx));
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const call = (method: string, url: string, body?: unknown) =>
      fetch(`${base}${url}`, { method, headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
        .then(async (res) => ({ status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> }));
    return { call, shown, queueMessage, close: () => new Promise<void>((r) => server.close(() => r())) };
  }

  it('keeps informational bot messages in the thread and shows urgent ones once, only for a registered bot', async () => {
    const t = await api(() => ({ email: 'owner@example.com', agentConversationId: 'anna' }));
    try {
      // Not a registered bot: urgent is recorded on the message but nothing surfaces.
      registered('clara', false);
      const before = await t.call('POST', '/api/conversations/clara/steer', { text: 'URGENT test while unregistered', priority: 'urgent', request_key: 'u0' });
      expect(before.body.surfacedToHuman).toBe(false);
      registered('clara', true);
      const info = await t.call('POST', '/api/conversations/clara/steer', { text: '[TEST] informational: inbox count is 12', request_key: 'i1' });
      expect(info.status).toBe(200);
      expect(info.body.coordinationThreadId).toBeTruthy();
      expect(info.body.surfacedToHuman).toBeUndefined();
      const urgent = await t.call('POST', '/api/conversations/clara/steer', { text: '[TEST] urgent: vendor payment due today', priority: 'urgent', request_key: 'u1' });
      expect(urgent.body.surfacedToHuman).toBe(true);
      const retry = await t.call('POST', '/api/conversations/clara/steer', { text: '[TEST] urgent: vendor payment due today', priority: 'urgent', request_key: 'u1' });
      // A reused queue row id must not collide with an earlier urgent line.
      db.prepare('DELETE FROM coordination_deliveries').run();
      const reused = await t.call('POST', '/api/conversations/clara/steer', { text: '[TEST] second urgent item', priority: 'urgent', request_key: 'u1b' });
      expect(reused.status).toBe(200);
      db.prepare("DELETE FROM bot_lane_surfaced WHERE summary='[TEST] second urgent item'").run();
      t.shown.pop();
      expect(retry.body.disposition).toBe('duplicate');
      expect(retry.body.coordinationThreadId).toBe(urgent.body.coordinationThreadId);
      expect(surfacedRows(db, 'clara').map((r) => r.summary)).toEqual(['[TEST] urgent: vendor payment due today']);
      expect(t.shown).toEqual([['clara', expect.objectContaining({ type: 'notice', message: 'Urgent from Anna: [TEST] urgent: vendor payment due today', coordinationThreadId: urgent.body.coordinationThreadId })]]);
      expect(t.shown).toHaveLength(1);
      // The urgent class rides on the message itself and is part of its key.
      expect(t.queueMessage.mock.calls[2]![3]).toMatchObject({ priority: 'urgent' });
      expect(t.queueMessage.mock.calls[1]![3]).not.toHaveProperty('priority');
      // An unregistered sender is named by its agent, never its long chat title.
      db.prepare("UPDATE bot_registrations SET active=0 WHERE conversation_id='anna'").run();
      db.prepare("UPDATE conversations SET title='Queue this long request and ship it' WHERE id='anna'").run();
      await t.call('POST', '/api/conversations/clara/steer', { text: '[TEST] urgent from an unregistered chat', priority: 'urgent', request_key: 'u2' });
      expect(t.shown.at(-1)![1]).toMatchObject({ message: expect.stringMatching(/^Urgent from Assistant: /) });
      expect((await t.call('POST', '/api/conversations/clara/steer', { text: 'x', priority: 'loud' })).status).toBe(400);
    } finally {
      await t.close();
    }
  });

  it('lets only a registered bot’s lane surface a line, with no per-bot switch', async () => {
    let identity: Record<string, unknown> = { email: 'owner@example.com', agentConversationId: 'clara' };
    const t = await api(() => identity);
    try {
      // The opt-in route is gone.
      expect((await t.call('PUT', '/api/conversations/clara/bot-lane', { enabled: false, authority_note: 'x' })).status).toBe(404);
      const lane = ensureBotLane(db, row('clara'));
      expect((await t.call('GET', '/api/conversations/clara/bot-lane')).body).toMatchObject({ enabled: true, laneConversationId: lane.id });

      expect((await t.call('POST', '/api/bot-lane/surface', { summary: 'From the human chat', kind: 'result', request_key: 'h' })).status).toBe(400);
      identity = { email: 'owner@example.com', agentConversationId: 'clara', agentExecutionConversationId: lane.id };
      const shown = await t.call('POST', '/api/bot-lane/surface', { summary: 'Inbox pass done: 9 archived, 2 need you', kind: 'result', request_key: 'pass-1' });
      expect(shown.status).toBe(200);
      expect(shown.body.shown).toBe('Result from bot lane: Inbox pass done: 9 archived, 2 need you');
      expect((await t.call('POST', '/api/bot-lane/surface', { summary: 'Inbox pass done: 9 archived, 2 need you', kind: 'result', request_key: 'pass-1' })).body.duplicate).toBe(true);
      expect(t.shown).toHaveLength(1);
      expect((await t.call('POST', '/api/bot-lane/surface', { summary: '', kind: 'result', request_key: 'e' })).status).toBe(400);

      // The lane shows as a bot lane beside the coordination threads.
      identity = { email: 'owner@example.com' };
      const threads = await t.call('GET', '/api/conversations/clara/coordination');
      expect(threads.body.threads).toContainEqual(expect.objectContaining({ label: expect.stringContaining('bot lane') }));
      identity = { email: 'owner@example.com', agentConversationId: 'clara', agentExecutionConversationId: lane.id };
      registered('clara', false);
      expect((await t.call('POST', '/api/bot-lane/surface', { summary: 'Later', kind: 'urgent', request_key: 'later' })).status).toBe(409);
      expect(botLaneConversationId(db, 'clara')).toBe(lane.id); // history kept
    } finally {
      await t.close();
    }
  });
});
