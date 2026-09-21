import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { migrate } from '../src/db/migrate.js';
import {
  createBotService,
  proposalSchema,
  type Actor,
} from '../src/bots/service.js';
import { createConversationWakeupScheduler } from '../src/scheduled/wakeups.js';
import { createConversationManager } from '../src/runtime/conversationManager.js';
import type { ConversationRow, UserRow } from '../src/db/db.js';
import type { SteerDelivery, ProviderAdapter } from '../src/providers/types.js';
import { autoArchiveInactiveConversations } from '../src/routes/chatAutoArchive.js';
import { createBotsRouter } from '../src/bots/routes.js';
import express from 'express';
import type { AppContext } from '../src/context.js';
import type { Server } from 'node:http';
const flush = () => new Promise((resolve) => setImmediate(resolve));
describe('VeneerBots', () => {
  let db: Database.Database;
  let s: ReturnType<typeof createBotService>;
  let human: Actor;
  let bot: Actor;
  let manager: ReturnType<typeof createConversationManager>;
  let scheduler: ReturnType<typeof createConversationWakeupScheduler>;
  let adapter: ProviderAdapter;
  let steer: ((text: string) => Promise<boolean | SteerDelivery>) | undefined;
  const runs: { prompt: string; finish: () => void }[] = [];
  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys=ON');
    migrate(
      db,
      fileURLToPath(new URL('../src/db/migrations', import.meta.url)),
    );
    for (let i = 1; i <= 3; i++)
      db.prepare(
        'INSERT INTO users(id,email,display_name,role) VALUES(?,?,?,?)',
      ).run(
        i,
        `fixture${i}@example.test`,
        `Person ${i}`,
        i === 1 ? 'owner' : 'member',
      );
    for (const id of ['fixture-a', 'fixture-b'])
      db.prepare(
        "INSERT INTO conversations(id,assistant_id,user_id,title,provider,native_session_id,visibility) VALUES(?,1,1,?,'claude',?,'team')",
      ).run(id, id, `native-${id}`);
    s = createBotService(db);
    human = {
      user: db.prepare('SELECT * FROM users WHERE id=1').get() as UserRow,
    };
    bot = { ...human, conversationId: 'fixture-a' };
    s.register(human, 'fixture-a', 'Fixture Atlas', true);
    s.register(human, 'fixture-b', 'Fixture Robin', true);
    runs.length = 0;
    steer = undefined;
    adapter = {
      id: 'claude',
      mintSessionId: () => '',
      readTranscript: async () => [],
      runTurn(spec, onEvent) {
        let finish!: () => void;
        const done = new Promise<void>((r) => {
          finish = () => {
            onEvent({ type: 'turn_done', turnId: spec.turnId });
            r();
          };
        });
        runs.push({ prompt: spec.prompt, finish });
        return { done, kill: finish, respondToApproval: () => true, ...(steer ? { steer } : {}) };
      },
    };
    manager = createConversationManager({
      db,
      steerAckWaitMs: 5,
      adapters: { claude: adapter },
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
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
  });
  afterEach(async () => {
    scheduler.stop();
    manager.shutdown();
    await flush();
    db.close();
  });
  const proposal = (extra = {}) =>
    proposalSchema.parse({
      question: 'Choose the internal draft?',
      recommendation: 'Use draft A.',
      consequence: 'Internal fixture only; no customer or financial action.',
      assignee_id: 1,
      blocked_action: 'Publish internal fixture',
      ...extra,
    });
  const raise = (key = 'case', actor = bot) =>
    s.raise(actor, {
      source_key: key,
      proposal_key: 'draft',
      proposal: proposal(),
    });
  function instruction(id: string, text = 'Approve this exact proposal.', actor = human, version: number | undefined = 1) {
    const key = crypto.randomUUID();
    s.reply(actor, id, key, text, version);
    return (db.prepare('SELECT id FROM bot_decision_events WHERE decision_id=? AND request_key=?').get(id, key) as { id: string }).id;
  }
  it('records a version-bound direction as its human author and emits one receipt and answer wakeup', () => {
    const d = raise();
    const message = instruction(d.id);
    expect(s.read(human, d.id).state).toBe('needs_input');
    const answer = s.recordDiscussionDecision(bot, d.id, message, 1, 'approve');
    expect(answer).toMatchObject({ state: 'decided', answer: { actor_id: 1, action: 'approve', text: 'Approve this exact proposal.', scope: 'this_case' } });
    s.recordDiscussionDecision(bot, d.id, message, 1, 'approve');
    expect(s.thread(human, d.id).events.filter(e => e.kind === 'answered')).toHaveLength(1);
    expect(s.thread(human, d.id).events.filter(e => e.kind === 'discussion_decision')).toHaveLength(1);
    expect(JSON.stringify(s.thread(human, d.id).messages)).toContain('Not completed');
    expect(() => s.recordDiscussionDecision(bot, d.id, message, 1, 'reject')).toThrow();
  });
  it.each(['reject', 'defer', 'withdraw'] as const)('records %s without granting execution or claiming completion', action => {
    const d = raise();
    const message = instruction(d.id, action === 'defer' ? 'Investigate the missing package first.' : `Please ${action} this proposal.`);
    expect(s.recordDiscussionDecision(bot, d.id, message, 1, action)).toMatchObject({ state: 'decided', answer: { action } });
    expect(() => s.result(bot, d.id, 1, 'run', { state: 'running', evidence: 'checked', material_evidence_unchanged: true })).toThrow();
  });
  it('never grants decision authority to legacy, bot-authored, foreign-card or unversioned messages', () => {
    const d = raise();
    s.reply(human, d.id, 'old', 'Approve');
    const old = (db.prepare("SELECT id FROM bot_decision_events WHERE request_key='old'").get() as { id: string }).id;
    expect(() => s.recordDiscussionDecision(bot, d.id, old, 1, 'approve')).toThrow();
    const own = instruction(d.id, 'Approve', bot);
    expect(() => s.recordDiscussionDecision(bot, d.id, own, 1, 'approve')).toThrow();
    const valid = instruction(d.id);
    expect(() => s.recordDiscussionDecision({ ...human, conversationId: 'fixture-b' }, d.id, valid, 1, 'approve')).toThrow();
    expect(() => s.recordDiscussionDecision(human, d.id, valid, 1, 'approve')).toThrow();
    expect(() => s.recordDiscussionDecision(bot, raise('another').id, valid, 1, 'approve')).toThrow();
  });
  it('rejects superseded directions and changed proposal versions', () => {
    const d = raise();
    const old = instruction(d.id);
    instruction(d.id, 'Wait, do not approve yet.');
    expect(() => s.recordDiscussionDecision(bot, d.id, old, 1, 'approve')).toThrow('newer human message');
    const latest = instruction(d.id);
    s.revise(bot, d.id, 1, 'revise', proposal({ consequence: 'Changed cost' }));
    expect(() => s.recordDiscussionDecision(bot, d.id, latest, 1, 'approve')).toThrow('Proposal changed');
    expect(() => instruction(d.id, 'Approve', human, 1)).toThrow('Proposal changed');
  });
  it('does not keyword-approve questions, quotations, conditions or negations on posting', () => {
    const d = raise();
    for (const text of ['Should I approve?', 'Customer said "approve the refund".', 'Approve only if the package arrives.', 'Do not approve this.']) instruction(d.id, text);
    expect(s.read(human, d.id).state).toBe('needs_input');
    expect(s.thread(human, d.id).events.filter(e => e.kind === 'answered')).toHaveLength(0);
  });
  it('atomically claims an available shared card, but rejects changes of handler or revoked author access', () => {
    db.prepare("INSERT INTO shared_bot_queues VALUES('fixture-a')").run();
    const d = raise();
    const first = instruction(d.id);
    expect(s.recordDiscussionDecision(bot, d.id, first, 1, 'approve')).toMatchObject({ handler_id: 1, state: 'decided' });
    const second = raise('second');
    const msg = instruction(second.id);
    s.handle(human, second.id, 1, 'claim-other', 'claim', 0);
    expect(() => s.recordDiscussionDecision(bot, second.id, msg, 1, 'approve')).toThrow('Handling changed');
    const third = raise('third');
    const revoked = instruction(third.id);
    db.prepare("UPDATE users SET status='disabled' WHERE id=1").run();
    expect(() => s.recordDiscussionDecision(bot, third.id, revoked, 1, 'approve')).toThrow();
  });
  it('steers a human discussion once to the active owner, retiring only the acknowledged row', async () => {
    let ack!: (ok: boolean) => void;
    const seen: string[] = [];
    steer = async text => { seen.push(text); return { acknowledged: new Promise<boolean>(resolve => { ack = resolve; }) }; };
    const conv = db.prepare('SELECT * FROM conversations WHERE id=?').get('fixture-a') as ConversationRow;
    manager.postMessage(conv, 'Unrelated authorized work');
    await flush();
    const d = raise();
    s.reply(human, d.id, 'thread-1', 'Please clarify in this decision.');
    scheduler.tick();
    await new Promise(resolve => setTimeout(resolve, 15));
    scheduler.tick();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain(d.id);
    expect(seen[0]).toContain('Please clarify in this decision.');
    expect(db.prepare('SELECT count(*) AS n FROM queued_messages').get()).toEqual({ n: 1 });
    expect(s.thread(human, d.id).events.some(e => e.payload_json.includes('written_awaiting_ack'))).toBe(true);
    ack(true);
    await flush();
    expect(db.prepare('SELECT count(*) AS n FROM queued_messages').get()).toEqual({ n: 0 });
    expect(s.thread(human, d.id).events.some(e => e.payload_json.includes('provider_consumed'))).toBe(true);
    const w = db.prepare('SELECT id FROM conversation_wakeups').get() as { id: string };
    expect(manager.deliverWakeup(conv, seen[0]!, w.id).disposition).toBe('duplicate');
    expect(seen).toHaveLength(1);
    runs[0]!.finish(); await flush();
    expect(runs).toHaveLength(1);
    expect(s.read(human, d.id).state).toBe('needs_input');
  });
  it.each(['unsupported', 'other_actor', 'write_failed'])('keeps the same durable discussion fallback for %s', async reason => {
    const seen = vi.fn(async () => false);
    if (reason !== 'unsupported') steer = seen;
    const conv = db.prepare('SELECT * FROM conversations WHERE id=?').get('fixture-a') as ConversationRow;
    manager.postMessage(conv, 'Existing turn', reason === 'other_actor' ? 2 : 1);
    await flush();
    const d = raise();
    s.reply(human, d.id, 'thread', 'Discussion fallback'); scheduler.tick(); await flush();
    expect(db.prepare('SELECT count(*) AS n FROM queued_messages').get()).toEqual({ n: 1 });
    expect(seen).toHaveBeenCalledTimes(reason === 'write_failed' ? 1 : 0);
    runs[0]!.finish(); await flush();
    expect(runs).toHaveLength(2);
    expect(runs[1]!.prompt).toContain('Discussion fallback');
  });
  it.each(['version', 'access'])('rechecks %s before a queued discussion starts', async change => {
    const conv = db.prepare('SELECT * FROM conversations WHERE id=?').get('fixture-a') as ConversationRow;
    manager.postMessage(conv, 'Existing turn'); await flush();
    const d = raise(); s.reply(human, d.id, 'thread', 'Stale proposal question'); scheduler.tick(); await flush();
    if (change === 'version') s.revise(bot, d.id, 1, 'revise', proposal({ recommendation: 'New material evidence' }));
    else s.register(human, 'fixture-a', 'Fixture Atlas', false);
    runs[0]!.finish(); await flush();
    expect(runs).toHaveLength(1);
    expect(db.prepare("SELECT count(*) AS n FROM bot_decision_events WHERE decision_id=? AND kind='discussion_delivery' AND json_extract(payload_json,'$.stage')='cancelled'").get(d.id)).toEqual({ n: 1 });
  });
  it('retries a crash-after-enqueue discussion receipt without a second steer or message', async () => {
    steer = vi.fn(async () => true);
    const conv = db.prepare('SELECT * FROM conversations WHERE id=?').get('fixture-a') as ConversationRow;
    manager.postMessage(conv, 'Existing turn'); await flush();
    const d = raise(); s.reply(human, d.id, 'thread', 'Exactly once discussion');
    const crashing = createConversationWakeupScheduler({ db, manager: {
      deliverWakeup(...args) { manager.deliverWakeup(...args); throw new Error('Simulated scheduler crash'); },
    }, log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } });
    crashing.tick(); await flush();
    expect(db.prepare('SELECT status FROM conversation_wakeups').get()).toEqual({ status: 'pending' });
    scheduler.tick(); await flush();
    expect(steer).toHaveBeenCalledTimes(1);
    expect(db.prepare('SELECT count(*) AS n FROM hub_inbound_messages').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT count(*) AS n FROM queued_messages').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT status FROM conversation_wakeups').get()).toEqual({ status: 'delivered' });
  });
  it('recovers a queued discussion after runtime restart without creating another message', async () => {
    const conv = db.prepare('SELECT * FROM conversations WHERE id=?').get('fixture-a') as ConversationRow;
    manager.postMessage(conv, 'Long original turn'); await flush();
    const d = raise(); s.reply(human, d.id, 'thread', 'Durable discussion after restart'); scheduler.tick(); await flush();
    const w = db.prepare('SELECT id,reason FROM conversation_wakeups').get() as { id: string; reason: string };
    // Simulated process death: the old adapter never finishes or drains its queue.
    manager = createConversationManager({ db, adapters: { claude: adapter },
      resolveWorkspace: () => ({ workspaceDir: '/tmp', assistantSlug: 'assistant', elevated: false, fullAccess: false }),
      log: { warn: vi.fn(), error: vi.fn() },
    });
    manager.resumeInterruptedTurns(); await flush();
    expect(manager.deliverWakeup(conv, w.reason, w.id).disposition).toBe('duplicate');
    runs.at(-1)!.finish(); await flush();
    expect(runs.filter(r => r.prompt.includes('Durable discussion after restart'))).toHaveLength(1);
    expect(db.prepare('SELECT count(*) AS n FROM hub_inbound_messages').get()).toEqual({ n: 1 });
  });
  it('never live-steers approvals or ordinary wakeups', async () => {
    steer = vi.fn(async () => true);
    const conv = db.prepare('SELECT * FROM conversations WHERE id=?').get('fixture-a') as ConversationRow;
    manager.postMessage(conv, 'Existing turn'); await flush();
    const d = raise(); s.answer(human, d.id, 1, 'approve', { action: 'approve', text: 'Internal fixture only', scope: 'this_case' });
    scheduler.tick(); manager.deliverWakeup(conv, 'Ordinary reminder', 'ordinary-fixture'); await flush();
    expect(steer).not.toHaveBeenCalled();
    expect(db.prepare('SELECT count(*) AS n FROM queued_messages').get()).toEqual({ n: 2 });
  });
  it('keeps six questions across two permanent bots for five hours; reversible registration and auto-archive exemption', () => {
    for (const a of [bot, { ...bot, conversationId: 'fixture-b' }])
      for (let i = 0; i < 3; i++) raise(`case${i}`, a);
    db.prepare(
      "UPDATE bot_decisions SET created_at=datetime('now','-5 hours')",
    ).run();
    expect(s.list(human)).toHaveLength(6);
    for (const d of s.list(human)) s.thread(human, d.id);
    expect(s.list(human).every((d) => d.state === 'needs_input')).toBe(true);
    db.prepare(
      "UPDATE conversations SET last_user_activity_at=datetime('now','-90 days'),last_active_at=datetime('now','-90 days')",
    ).run();
    expect(
      autoArchiveInactiveConversations(db, 1, {
        enabled: true,
        inactivityDays: 7,
      }),
    ).toEqual([]);
    s.register(human, 'fixture-a', 'Fixture Atlas', false);
    expect(
      db
        .prepare(
          "SELECT native_session_id FROM conversations WHERE id='fixture-a'",
        )
        .get(),
    ).toEqual({ native_session_id: 'native-fixture-a' });
    expect(s.list(human)).toHaveLength(6);
  });
  it('deduplicates raises, rejects stale/conflicting answers, preserves audit and requires execution verification', async () => {
    const d = raise();
    expect(raise().id).toBe(d.id);
    expect(() =>
      s.answer(bot, d.id, 1, 'fake', {
        action: 'approve',
        text: 'No',
        scope: 'this_case',
      }),
    ).toThrow('human');
    const other = {
      user: db.prepare('SELECT * FROM users WHERE id=2').get() as UserRow,
    };
    expect(s.list(other)).toHaveLength(1);
    expect(() =>
      s.answer(other, d.id, 1, 'other', {
        action: 'approve',
        text: 'No',
        scope: 'this_case',
      }),
    ).toThrow('assigned');
    s.answer(human, d.id, 1, 'answer', {
      action: 'approve',
      text: 'Use draft A only',
      scope: 'this_case',
    });
    expect(s.read(human, d.id).state).toBe('decided');
    expect(() =>
      s.answer(human, d.id, 1, 'second', {
        action: 'reject',
        text: 'Conflict',
        scope: 'this_case',
      }),
    ).toThrow('already');
    s.answer(human, d.id, 1, 'answer', {
      action: 'approve',
      text: 'Use draft A only',
      scope: 'this_case',
    });
    expect(
      db.prepare('SELECT count(*) n FROM conversation_wakeups').get(),
    ).toEqual({ n: 1 });
    expect(() =>
      s.result(bot, d.id, 1, 'early', {
        state: 'verified_completed',
        evidence: 'Not done',
      }),
    ).toThrow('transition');
    scheduler.tick();
    await flush();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.prompt).toContain('Use draft A only');
    expect(s.read(human, d.id).state).toBe('action_pending');
    expect(() =>
      s.result(bot, d.id, 1, 'notchecked', {
        state: 'running',
        evidence: 'No check',
      }),
    ).toThrow('transition');
    s.result(bot, d.id, 1, 'start', {
      state: 'running',
      evidence: 'Checked unchanged internal draft',
      material_evidence_unchanged: true,
    });
    s.result(bot, d.id, 1, 'done', {
      state: 'verified_completed',
      evidence: 'Internal artifact inspected successfully',
    });
    expect(s.read(human, d.id).state).toBe('verified_completed');
    expect(() =>
      db.prepare('UPDATE bot_decision_events SET kind=?').run('tampered'),
    ).toThrow('immutable');
  });
  it('keeps unrelated work running, queues discussion and answer once, replies in dedicated thread', async () => {
    const c = db
      .prepare("SELECT * FROM conversations WHERE id='fixture-a'")
      .get() as ConversationRow;
    manager.postMessage(c, 'Unrelated authorized work');
    await flush();
    const d = raise();
    s.park(bot, d.id, 1, 'park', {
      released_leases: ['internal-lease-receipt'],
      evidence: 'Fixture lease released; only this task parked',
    });
    expect(manager.statusOf(c.id)).toBe('working');
    s.reply(human, d.id, 'question', 'Can you clarify the internal draft?');
    scheduler.tick();
    await flush();
    expect(runs).toHaveLength(1);
    runs[0]!.finish();
    await flush();
    await flush();
    expect(runs).toHaveLength(2);
    s.reply(bot, d.id, 'reply', 'Draft A contains the reviewed wording.');
    expect(s.thread(human, d.id).messages).toHaveLength(2);
    runs[1]!.finish();
    await flush();
    s.answer(human, d.id, 1, 'answer', {
      action: 'approve',
      text: 'Proceed with A',
      scope: 'this_case',
    });
    scheduler.tick();
    scheduler.tick();
    await flush();
    expect(runs).toHaveLength(3);
    expect(
      runs.filter((r) => r.prompt.includes('VeneerBots answer')),
    ).toHaveLength(1);
  });
  it('replays a pending event after simulated crash without duplicating the durable owner message', async () => {
    const d = raise();
    s.answer(human, d.id, 1, 'answer', {
      action: 'approve',
      text: 'Proceed',
      scope: 'this_case',
    });
    const crashing = createConversationWakeupScheduler({
      db,
      manager: {
        deliverWakeup(...args) {
          manager.deliverWakeup(...args);
          throw new Error('Crash after durable enqueue');
        },
      },
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    crashing.tick();
    await flush();
    expect(runs).toHaveLength(1);
    expect(db.prepare('SELECT status FROM conversation_wakeups').get()).toEqual(
      { status: 'pending' },
    );
    scheduler.tick();
    await flush();
    expect(runs).toHaveLength(1);
    expect(s.read(human, d.id).state).toBe('action_pending');
  });
  it('supersedes changed evidence, cancels stale resume, and keeps failed execution visible after dismissal', async () => {
    const d = raise();
    s.answer(human, d.id, 1, 'a', {
      action: 'approve',
      text: 'First proposal',
      scope: 'this_case',
    });
    s.revise(
      bot,
      d.id,
      1,
      'revise',
      proposal({ recommendation: 'Use revised draft B' }),
    );
    expect(() =>
      s.answer(human, d.id, 1, 'stale', {
        action: 'approve',
        text: 'Old answer',
        scope: 'this_case',
      }),
    ).toThrow('changed');
    scheduler.tick();
    await flush();
    expect(runs).toHaveLength(0);
    s.answer(human, d.id, 2, 'b', {
      action: 'approve',
      text: 'Revised draft B only',
      scope: 'this_case',
    });
    scheduler.tick();
    await flush();
    s.result(bot, d.id, 2, 'fail', {
      state: 'failed',
      evidence: 'Internal destination unavailable',
    });
    s.dismiss(human, d.id, 2);
    expect(s.list(human)[0]).toMatchObject({
      state: 'failed',
      dismissed: true,
    });
  });
  it('enforces current evidence and chat ACL and cancels delivery after access is revoked', async () => {
    const d = raise();
    s.answer(human, d.id, 1, 'a', {
      action: 'approve',
      text: 'Proceed',
      scope: 'this_case',
    });
    db.prepare(
      "UPDATE conversations SET visibility='private' WHERE id='fixture-a'",
    ).run();
    const other = {
      user: db.prepare('SELECT * FROM users WHERE id=2').get() as UserRow,
    };
    expect(s.list(other)).toHaveLength(0);
    expect(() => s.thread(other, d.id)).toThrow('not found');
    db.prepare("UPDATE users SET status='disabled' WHERE id=1").run();
    scheduler.tick();
    await flush();
    expect(runs).toHaveLength(0);
  });
  it('reports pending discussion delivery until the bot replies to that decision', () => {
    const d = raise();
    expect(s.view(human, s.read(human, d.id)).reply_status).toBeNull();
    s.reply(human, d.id, 'ask-order', 'Which order is this?');
    expect(s.view(human, s.read(human, d.id)).reply_status).toBe('queued');
    db.prepare("UPDATE conversation_wakeups SET status='delivered' WHERE conversation_id=?").run(d.conversation_id);
    expect(s.view(human, s.read(human, d.id)).reply_status).toBe('awaiting_reply');
    s.reply(bot, d.id, 'order-reply', 'Shopify order #100121631, Shopify order ID 6123856527512.');
    const replied = s.view(human, s.read(human, d.id));
    expect(replied.reply_status).toBeNull();
    expect(replied.order_reference).toMatchObject({ number: '100121631' });
    s.reply(human, d.id, 'follow-up', 'Please check it.');
    db.prepare("UPDATE conversation_wakeups SET status='cancelled' WHERE status='pending'").run();
    expect(s.view(human, s.read(human, d.id)).reply_status).toBe('not_delivered');
  });
  it('orders bots by activity with personal pins and preserves personal unread state', async () => {
    let requestActor = human;
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = requestActor.user;
      req.agentConversationId = requestActor.conversationId;
      next();
    });
    app.use('/api/bots', createBotsRouter({ db, manager: { statusOf: async () => 'idle' } } as unknown as AppContext));
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/bots`;
    const list = async () => (await (await fetch(base)).json()).bots as { conversation_id: string; pinned: boolean; unread: boolean }[];
    const patch = (id: string, body: object) => fetch(`${base}/preferences/${id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    try {
      db.prepare("UPDATE conversations SET last_active_at='2026-09-20 10:00:00' WHERE id='fixture-a'").run();
      db.prepare("UPDATE conversations SET last_active_at='2026-09-21 10:00:00' WHERE id='fixture-b'").run();
      expect((await list()).map(b => b.conversation_id)).toEqual(['fixture-b', 'fixture-a']);
      expect((await patch('fixture-a', { pinned: true, unread: true })).status).toBe(200);
      expect((await list())[0]).toMatchObject({ conversation_id: 'fixture-a', pinned: true, unread: true });
      await patch('fixture-a', { unread: false });
      expect((await list())[0]).toMatchObject({ pinned: true, unread: false });
      requestActor = { user: db.prepare('SELECT * FROM users WHERE id=2').get() as UserRow };
      expect((await list())[0]).toMatchObject({ conversation_id: 'fixture-b', pinned: false, unread: false });
      requestActor = human;
      await patch('fixture-a', { pinned: false, unread: true });
      expect((await list())[1]).toMatchObject({ pinned: false, unread: true });
      db.prepare("UPDATE conversations SET last_active_at='2026-09-22 10:00:00' WHERE id='fixture-a'").run();
      expect((await list())[0].conversation_id).toBe('fixture-a');
      expect((await patch('fixture-a', { pinned: 'yes' })).status).toBe(400);
      requestActor = bot;
      expect((await patch('fixture-a', { pinned: true })).status).toBe(403);
      db.prepare("UPDATE conversations SET visibility='private' WHERE id='fixture-a'").run();
      requestActor = { user: db.prepare('SELECT * FROM users WHERE id=2').get() as UserRow };
      expect((await patch('fixture-a', { unread: false })).status).toBe(404);
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
  it('rejects bot spoofing and HTTP stale answers; human visibility alone is insufficient', async () => {
    let requestActor = human;
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = requestActor.user;
      req.agentConversationId = requestActor.conversationId;
      next();
    });
    app.use(
      '/api/bots',
      createBotsRouter({
        db,
        manager: { statusOf: async () => 'idle' },
      } as unknown as AppContext),
    );
    let server: Server;
    await new Promise<void>((r) => {
      server = app.listen(0, '127.0.0.1', r);
    });
    const base = `http://127.0.0.1:${(server!.address() as { port: number }).port}/api/bots`;
    try {
      const d = raise();
      requestActor = { ...human, conversationId: 'fixture-b' };
      expect(
        (
          await fetch(`${base}/decisions/${d.id}/result`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              expected_version: 1,
              request_key: 'fake',
              state: 'failed',
              evidence: 'No',
            }),
          })
        ).status,
      ).toBe(403);
      requestActor = {
        user: db.prepare('SELECT * FROM users WHERE id=2').get() as UserRow,
      };
      const body = {
        expected_version: 1,
        request_key: 'answer',
        action: 'approve',
        text: 'Proceed',
        scope: 'this_case',
      };
      const post = () =>
        fetch(`${base}/decisions/${d.id}/answer`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
      expect((await post()).status).toBe(403);
      requestActor = human;
      expect((await post()).status).toBe(200);
      body.request_key = 'conflict';
      expect((await post()).status).toBe(409);
    } finally {
      await new Promise<void>((r) => server!.close(() => r()));
    }
  });
  it('checks current evidence ACL on every read and execution, including approval revoked after dispatch', async () => {
    db.prepare(
      "INSERT INTO conversations(id,assistant_id,user_id,title,provider,native_session_id,visibility) VALUES('evidence',1,1,'Fixture evidence','claude','fixture-evidence','private')",
    ).run();
    const d = s.raise(bot, {
      source_key: 'evidence',
      proposal_key: 'draft',
      proposal: proposal({
        evidence: [{ label: 'Internal notes', conversation_id: 'evidence' }],
      }),
    });
    const viewer = {
      user: db.prepare('SELECT * FROM users WHERE id=2').get() as UserRow,
    };
    expect(s.list(viewer)).toHaveLength(0);
    expect(() => s.thread(viewer, d.id)).toThrow('not found');
    s.revise(bot, d.id, 1, 'share', proposal({ assignee_id: 2 }));
    expect(s.list(viewer, 'me')).toHaveLength(1);
    expect(s.thread(viewer, d.id).events[0]!.payload_json).not.toContain(
      'Internal notes',
    );
    s.answer(viewer, d.id, 2, 'approve', {
      action: 'approve',
      text: 'Proceed with internal draft',
      scope: 'standing_rule',
    });
    scheduler.tick();
    await flush();
    expect(s.read(human, d.id).state).toBe('action_pending');
    db.prepare(
      "UPDATE conversations SET visibility='private' WHERE id='fixture-a'",
    ).run();
    expect(() =>
      s.result(bot, d.id, 2, 'start', {
        state: 'running',
        evidence: 'Same draft',
        material_evidence_unchanged: true,
      }),
    ).toThrow('access');
  });
  it('does not execute rejection, deferral or withdrawal and rejects altered retries', async () => {
    for (const action of ['reject', 'defer', 'withdraw']) {
      const d = raise(action);
      s.answer(human, d.id, 1, 'answer', {
        action,
        text: 'This case only',
        scope: 'this_case',
      });
      expect(() =>
        s.answer(human, d.id, 1, 'answer', {
          action: 'approve',
          text: 'Changed retry',
          scope: 'this_case',
        }),
      ).toThrow('different action');
      scheduler.tick();
      await flush();
      expect(s.read(human, d.id).state).toBe('decided');
      expect(() =>
        s.result(bot, d.id, 1, 'run', {
          state: 'running',
          evidence: 'Checked',
          material_evidence_unchanged: true,
        }),
      ).toThrow('transition');
    }
  });
  it('filters by assigned human and existing team visibility and preserves blocked delivery', async () => {
    const shared = raise('shared');
    db.prepare(
      "UPDATE conversations SET visibility='private' WHERE id='fixture-b'",
    ).run();
    raise('private', { ...bot, conversationId: 'fixture-b' });
    expect(s.list(human, 'all')).toHaveLength(2);
    expect(s.list(human, 'team')).toHaveLength(1);
    const viewer = {
      user: db.prepare('SELECT * FROM users WHERE id=2').get() as UserRow,
    };
    expect(s.list(viewer, 'me')).toHaveLength(0);
    expect(s.list(viewer, 'all')).toHaveLength(1);
    s.answer(human, shared.id, 1, 'answer', {
      action: 'approve',
      text: 'Internal only',
      scope: 'this_case',
    });
    s.register(human, 'fixture-a', 'Fixture Atlas', false);
    scheduler.tick();
    await flush();
    expect(s.read(human, shared.id).state).toBe('blocked');
    expect(runs).toHaveLength(0);
    s.register(human, 'fixture-a', 'Fixture Atlas', true);
    expect(() =>
      s.result(bot, shared.id, 1, 'start', {
        state: 'running',
        evidence: 'Checked',
        material_evidence_unchanged: true,
      }),
    ).toThrow('delivery');
  });
});

describe('AutoShip answer bridge readback (v1, fixtures only)', () => {
  let db: Database.Database;
  let s: ReturnType<typeof createBotService>;
  let human: Actor;
  let bot: Actor;
  let manager: ReturnType<typeof createConversationManager>;
  let scheduler: ReturnType<typeof createConversationWakeupScheduler>;
  const runs: { prompt: string; finish: () => void }[] = [];
  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys=ON');
    migrate(db, fileURLToPath(new URL('../src/db/migrations', import.meta.url)));
    db.prepare('INSERT INTO users(id,email,display_name,role) VALUES(?,?,?,?)').run(1, 'fixture1@example.test', 'Person 1', 'owner');
    db.prepare(
      "INSERT INTO conversations(id,assistant_id,user_id,title,provider,native_session_id,visibility) VALUES(?,1,1,?,'claude',?,'team')",
    ).run('fixture-a', 'fixture-a', 'native-fixture-a');
    s = createBotService(db);
    human = { user: db.prepare('SELECT * FROM users WHERE id=1').get() as UserRow };
    bot = { ...human, conversationId: 'fixture-a' };
    s.register(human, 'fixture-a', 'Fixture Atlas', true);
    runs.length = 0;
    const adapter: ProviderAdapter = {
      id: 'claude',
      mintSessionId: () => '',
      readTranscript: async () => [],
      runTurn(spec, onEvent) {
        let finish!: () => void;
        const done = new Promise<void>((r) => {
          finish = () => {
            onEvent({ type: 'turn_done', turnId: spec.turnId });
            r();
          };
        });
        runs.push({ prompt: spec.prompt, finish });
        return { done, kill: finish, respondToApproval: () => true };
      },
    };
    manager = createConversationManager({
      db,
      steerAckWaitMs: 5,
      adapters: { claude: adapter },
      resolveWorkspace: () => ({ workspaceDir: '/tmp', assistantSlug: 'assistant', elevated: false, fullAccess: false }),
      log: { warn: vi.fn(), error: vi.fn() },
    });
    scheduler = createConversationWakeupScheduler({ db, manager, log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } });
  });
  afterEach(async () => {
    scheduler.stop();
    manager.shutdown();
    await flush();
    db.close();
  });
  const proposal = (extra = {}) =>
    proposalSchema.parse({
      question: 'Package for order 100121927 line 1?',
      recommendation: 'Use one box 12x10x8 in, 4 lb.',
      consequence: 'Fixture only; no customer, provider or shipping action.',
      assignee_id: 1,
      blocked_action: 'Set package version (fixture)',
      ...extra,
    });
  const raise = () => s.raise(bot, { source_key: 'order-100121927', proposal_key: 'package', proposal: proposal() });
  const bridge = (id: string) => s.view(bot, s.read(bot, id)).answer_bridge;

  it('reports no answer and no delivered version before the human answers', () => {
    const d = raise();
    expect(bridge(d.id)).toEqual({
      contract: 'autoship-answer-bridge/v1',
      current_version: 1,
      delivered_version: null,
      answer: null,
    });
    expect(() => s.read(bot, 'unknown-decision')).toThrow();
  });

  it('exposes the raw answer with actor attribution and request key, and delivered_version only after native delivery', async () => {
    const d = raise();
    s.answer(human, d.id, 1, 'req-1', { action: 'approve', text: '12 x 10 x 8 inches, 4 lb, one parcel', scope: 'this_case' });
    let b = bridge(d.id);
    expect(b.current_version).toBe(1);
    expect(b.delivered_version).toBeNull();
    expect(b.answer).toMatchObject({
      raw: { action: 'approve', text: '12 x 10 x 8 inches, 4 lb, one parcel', scope: 'this_case' },
      actor_id: 1,
      actor_conversation_id: null,
      request_key: 'req-1',
    });
    expect(typeof b.answer!.answered_at).toBe('string');
    // Replaying the same request key returns the same event, never a second answer.
    s.answer(human, d.id, 1, 'req-1', { action: 'approve', text: '12 x 10 x 8 inches, 4 lb, one parcel', scope: 'this_case' });
    expect(db.prepare("SELECT count(*) n FROM bot_decision_events WHERE kind='answered'").get()).toEqual({ n: 1 });
    // A stale answer against the current version is rejected as today.
    expect(() => s.answer(human, d.id, 1, 'req-2', { action: 'reject', text: 'No', scope: 'this_case' })).toThrow('already');

    scheduler.tick();
    await flush();
    expect(runs).toHaveLength(1);
    b = bridge(d.id);
    expect(b.delivered_version).toBe(1);
    expect(s.read(bot, d.id).state).toBe('action_pending');

    s.result(bot, d.id, 1, 'start', { state: 'running', evidence: 'Fixture material unchanged', material_evidence_unchanged: true });
    expect(s.read(bot, d.id).state).toBe('running');
    expect(bridge(d.id)).toMatchObject({ current_version: 1, delivered_version: 1 });
    // No double handoff: a second running record for the same version is a replay of the same key or rejected.
    expect(() =>
      s.result(bot, d.id, 1, 'start-again', { state: 'running', evidence: 'Fixture material unchanged', material_evidence_unchanged: true }),
    ).toThrow();
    runs[0]!.finish();
  });

  it('drops the answer and keeps delivered_version behind current_version after a revision', async () => {
    const d = raise();
    s.answer(human, d.id, 1, 'req-1', { action: 'approve', text: '12x10x8 in, 4 lb', scope: 'this_case' });
    scheduler.tick();
    await flush();
    expect(bridge(d.id).delivered_version).toBe(1);
    s.revise(bot, d.id, 1, 'revise-1', proposal({ recommendation: 'Two boxes: 12x10x8 in 4 lb and 6x6x6 in 1 lb.' }));
    const b = bridge(d.id);
    expect(b.current_version).toBe(2);
    expect(b.delivered_version).toBe(1);
    expect(b.answer).toBeNull();
    expect(s.read(bot, d.id).state).toBe('needs_input');
    runs[0]?.finish();
  });
});
