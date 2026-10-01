import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { migrate } from '../src/db/migrate.js';
import { createBotService, proposalSchema, type Actor } from '../src/bots/service.js';
import { acceptEvent } from '../src/botWorkflows/routines.js';
import { BOT_TOOL_DEFINITIONS } from '../src/mcp/botTools.js';
import type { UserRow } from '../src/db/db.js';

const choices = [{ id: 'a', label: 'Ship the tank and kit as two boxes', description: 'Use the measured tank box and the usual kit box', action: 'approve', recommended: true }, { id: 'b', label: 'Ship everything in one box', description: 'One label for the combined package', action: 'approve' }];
const HOUR = 60 * 60 * 1000;

describe('questions settled elsewhere', () => {
  let db: Database.Database, bot: Actor, otherBot: Actor, human: Actor;
  let s: ReturnType<typeof createBotService>;
  beforeEach(() => {
    db = new Database(':memory:'); db.pragma('foreign_keys=ON');
    migrate(db, fileURLToPath(new URL('../src/db/migrations', import.meta.url)));
    db.prepare("INSERT INTO users(id,email,display_name,role) VALUES(1,'owner@test.invalid','Owner','owner')").run();
    for (const team of ['team', 'other']) {
      db.prepare('INSERT INTO business_teams(id,name,owner_id) VALUES(?,?,1)').run(team, team);
      const id = `bot-${team}`;
      db.prepare("INSERT INTO conversations(id,assistant_id,user_id,title,provider,native_session_id,visibility,business_team_id) VALUES(?,1,1,?,'claude',?,'team',?)").run(id, id, id, team);
      db.prepare('INSERT INTO bot_registrations(conversation_id,name,registered_by) VALUES(?,?,1)').run(id, id);
      db.prepare("INSERT INTO business_bot_members(conversation_id,team_id,role) VALUES(?,?,'bot')").run(id, team);
    }
    db.prepare("INSERT INTO bot_event_sources(id,team_id,created_by,name) VALUES('orderops','team',1,'OrderOps')").run();
    human = { user: db.prepare('SELECT * FROM users WHERE id=1').get() as UserRow };
    bot = { ...human, conversationId: 'bot-team' }; otherBot = { ...human, conversationId: 'bot-other' };
    s = createBotService(db);
  });
  afterEach(() => db.close());
  const proposal = (extra: Record<string, unknown> = {}) => proposalSchema.parse({ question: 'What are the packed dimensions of the tank?', recommendation: 'Confirm separate packages.', consequence: 'The order stays unfulfilled until the package is verified.', blocked_action: 'Create the label only after the package is verified.', assignee_id: 1, choices, ...extra });
  const asOf = (orders: string[], extra: Record<string, unknown> = {}) => ({ captured_at: '2026-10-01T14:00:00Z', last_inbound: [], orders: orders.map((order_number) => ({ order_number })), ...extra });
  const fulfilled = (id: string, order_number: string, type = 'order.fulfilled') => acceptEvent(db, 'orderops', { id, type, order_number, occurred_at: '2026-10-01T15:00:00Z' });
  const state = (id: string) => s.view(human, s.read(human, id));
  const wakes = (like: string) => (db.prepare('SELECT count(*) n FROM conversation_wakeups WHERE reason LIKE ?').get(like) as { n: number }).n;

  it('retires open questions for an order the source reports fulfilled, once per event, within the source business only', () => {
    const declared = s.raise(bot, { source_key: 'o1', proposal_key: 'dims', proposal: proposal({ as_of: asOf(['#100122051']) }) });
    const byReference = s.raise(bot, { source_key: 'o1', proposal_key: 'kit', proposal: proposal({ shopify_order: { number: '100122051', url: 'https://admin.shopify.com/store/ervp/orders/5551' } }) });
    const unrelated = s.raise(bot, { source_key: 'o2', proposal_key: 'dims', proposal: proposal({ as_of: asOf(['100122052']) }) });
    const foreign = s.raise(otherBot, { source_key: 'o1', proposal_key: 'dims', proposal: proposal({ as_of: asOf(['100122051']) }) });
    const answered = s.raise(bot, { source_key: 'o1', proposal_key: 'answered', proposal: proposal({ as_of: asOf(['100122051']) }) });
    s.choose(human, answered.id, 1, 'click', 'a', '', 'this_case');

    expect(fulfilled('f1', '100122051')).toBe(2);
    for (const d of [declared, byReference]) expect(state(d.id)).toMatchObject({ state: 'needs_input', stale: { reason: 'order_fulfilled', resolved: true } });
    expect(state(unrelated.id).stale).toBeNull();
    expect(state(foreign.id).stale).toBeNull();
    // Approved work is never touched.
    expect(state(answered.id)).toMatchObject({ state: 'decided', answer: { action: 'approve' }, stale: null });
    expect(wakes('VeneerBots question settled elsewhere%')).toBe(2);
    // No human answer can be recorded against a settled question.
    expect(() => s.choose(human, declared.id, 1, 'late', 'a', '', 'this_case')).toThrow('stale');

    expect(fulfilled('f1', '100122051')).toBe(0);
    expect(db.prepare("SELECT count(*) n FROM bot_decision_events WHERE decision_id=? AND kind='stale'").get(declared.id)).toEqual({ n: 1 });
    expect(wakes('VeneerBots question settled elsewhere%')).toBe(2);
  });

  it('withdraws a settled question after the short window with an audit note, and keeps ordinary stale questions on the long one', () => {
    const settled = s.raise(bot, { source_key: 'o1', proposal_key: 'dims', proposal: proposal({ as_of: asOf(['100122051']) }) });
    const moved = s.raise(bot, { source_key: 'T9', proposal_key: 'dims', proposal: proposal({ as_of: { captured_at: '2026-10-01T14:00:00Z', ticket_id: 'T9', last_inbound: [] } }) });
    fulfilled('c1', '100122051', 'order.cancelled');
    acceptEvent(db, 'orderops', { id: 'r1', type: 'customer.replied', ticket_id: 'T9', occurred_at: new Date().toISOString(), assigned_bot: '11111111-1111-4111-8111-111111111111' });
    const now = Date.now();
    expect(s.withdrawStaleQuestions(72 * HOUR, now + 5 * 60 * 1000, 15 * 60 * 1000)).toEqual([]);
    expect(s.withdrawStaleQuestions(72 * HOUR, now + 20 * 60 * 1000, 15 * 60 * 1000)).toEqual([settled.id]);
    expect(state(settled.id)).toMatchObject({ state: 'decided', answer: { action: 'withdraw', automatic: true, text: expect.stringContaining('order #100122051 was cancelled') } });
    expect(state(moved.id)).toMatchObject({ state: 'needs_input', stale: { reason: 'customer_replied' } });
    expect(state(moved.id).stale).not.toHaveProperty('resolved');
    expect(s.withdrawStaleQuestions(72 * HOUR, now + 20 * 60 * 1000, 15 * 60 * 1000)).toEqual([]);
  });

  it('honors moot_when, treats a closed ticket as settled, and lets the bot revive a question that is still needed', () => {
    const onlyCancel = s.raise(bot, { source_key: 'o1', proposal_key: 'dims', proposal: proposal({ as_of: asOf(['100122051'], { moot_when: ['order_cancelled'] }) }) });
    const ticket = s.raise(bot, { source_key: 'T1', proposal_key: 'dims', proposal: proposal({ as_of: { captured_at: '2026-10-01T14:00:00Z', ticket_id: 'T1', last_inbound: [] } }) });
    expect(fulfilled('f1', '100122051')).toBe(0);
    expect(state(onlyCancel.id).stale).toBeNull();
    expect(fulfilled('c1', '100122051', 'order.cancelled')).toBe(1);
    expect(acceptEvent(db, 'orderops', { id: 't1', type: 'ticket.closed', ticket_id: 'T1', occurred_at: '2026-10-01T15:00:00Z' })).toBe(1);
    expect(state(ticket.id).stale).toMatchObject({ reason: 'ticket_closed', resolved: true });
    const revived = s.revise(bot, onlyCancel.id, 1, 'rev', proposal({ as_of: asOf(['100122051']) }));
    expect(revived).toMatchObject({ state: 'needs_input', version: 2, stale: null });
    expect(s.withdrawStaleQuestions(72 * HOUR, Date.now() + HOUR, 15 * 60 * 1000)).toEqual([ticket.id]);
  });

  it('rejects malformed settled events and unknown sources without retiring anything', () => {
    const d = s.raise(bot, { source_key: 'o1', proposal_key: 'dims', proposal: proposal({ as_of: asOf(['100122051']) }) });
    expect(() => acceptEvent(db, 'orderops', { id: 'f1', type: 'order.fulfilled', occurred_at: '2026-10-01T15:00:00Z' })).toThrow();
    expect(() => acceptEvent(db, 'orderops', { id: 'f1', type: 'order.fulfilled', order_number: '100122051', occurred_at: '2026-10-01T15:00:00Z', ticket_id: 'T1' })).toThrow();
    expect(() => acceptEvent(db, 'unknown', { id: 'f1', type: 'order.fulfilled', order_number: '100122051', occurred_at: '2026-10-01T15:00:00Z' })).toThrow('Event source unavailable');
    expect(state(d.id)).toMatchObject({ state: 'needs_input', stale: null });
  });

  it('lets only the owning bot withdraw its own waiting question, idempotently, without authorizing anything', () => {
    const d = s.raise(bot, { source_key: 'o1', proposal_key: 'dims', proposal: proposal({ as_of: asOf(['100122051']) }) });
    const payload = { reason: 'Order #100122051 shipped outside AutoShip.', evidence: 'Shopify fulfillment #100122051-F1, UPS tracking recorded.' };
    expect(() => s.withdraw(otherBot, d.id, 1, 'w', payload)).toThrow();
    expect(() => s.withdraw(human, d.id, 1, 'w', payload)).toThrow();
    const withdrawn = s.withdraw(bot, d.id, 1, 'w', payload);
    expect(withdrawn).toMatchObject({ state: 'decided', answer: { action: 'withdraw', by_bot: true, text: expect.stringContaining('shipped outside AutoShip') } });
    expect(s.withdraw(bot, d.id, 1, 'w', payload).state).toBe('decided');
    expect(db.prepare("SELECT count(*) n FROM bot_decision_events WHERE decision_id=? AND kind='answered'").get(d.id)).toEqual({ n: 1 });
    expect(() => s.withdraw(bot, d.id, 1, 'w2', payload)).toThrow('Only a question still waiting');
    expect(() => s.result(bot, d.id, 1, 'run', { state: 'running', evidence: 'x', material_evidence_unchanged: true })).toThrow();
    expect(BOT_TOOL_DEFINITIONS.some((t) => t.name === 'withdraw_decision')).toBe(true);
  });

  it('asks each bot once per interval to re-check its order-bound questions, and only those old enough', () => {
    const old = s.raise(bot, { source_key: 'o1', proposal_key: 'dims', proposal: proposal({ as_of: asOf(['#100122051']) }) });
    s.raise(bot, { source_key: 'T1', proposal_key: 'dims', proposal: proposal({ as_of: { captured_at: '2026-10-01T14:00:00Z', ticket_id: 'T1', last_inbound: [] } }) });
    const now = Date.now();
    expect(s.queueQuestionRechecks(HOUR, now)).toEqual([]);
    const later = now + HOUR + 1000;
    expect(s.queueQuestionRechecks(HOUR, later)).toEqual(['bot-team']);
    const reason = (db.prepare("SELECT reason FROM conversation_wakeups WHERE wake_key LIKE 'question-recheck:%'").get() as { reason: string }).reason;
    expect(reason).toContain(old.id);
    expect(reason).toContain('#100122051');
    expect(reason).toContain('1 open question(s)');
    // Same interval, or a still-pending earlier wake: no second wake.
    expect(s.queueQuestionRechecks(HOUR, later + 1000)).toEqual([]);
    expect(s.queueQuestionRechecks(HOUR, later + 2 * HOUR)).toEqual([]);
    db.prepare("UPDATE conversation_wakeups SET status='delivered' WHERE wake_key LIKE 'question-recheck:%'").run();
    expect(s.queueQuestionRechecks(HOUR, later + 2 * HOUR)).toEqual(['bot-team']);
    // Withdrawn questions are no longer re-checked.
    db.prepare("UPDATE conversation_wakeups SET status='delivered' WHERE wake_key LIKE 'question-recheck:%'").run();
    s.withdraw(bot, old.id, 1, 'w', { reason: 'Shipped.', evidence: 'Fulfillment recorded.' });
    expect(s.queueQuestionRechecks(HOUR, later + 4 * HOUR)).toEqual([]);
  });
});
