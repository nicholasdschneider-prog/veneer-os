import Database from 'better-sqlite3';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { migrate } from '../src/db/migrate.js';
import { csReadiness } from '../src/bots/csReadiness.js';
import { csOutcomes, summarizeDelays } from '../src/bots/csOutcomes.js';
import { csStandingPolicy } from '../src/bots/csStandingPolicy.js';
import { callBotTool } from '../src/mcp/botTools.js';
import type { Actor } from '../src/bots/service.js';
import type { UserRow } from '../src/db/db.js';

let db: Database.Database, owner: Actor, bot: Actor;
const now = () => Date.parse('2026-09-29T12:00:00Z');
const state = (view: ReturnType<ReturnType<typeof csReadiness>['read']>, id: string) => view.capabilities.find(c => c.id === id)!;
function draft(id: string, fields: { state: string; authorized?: boolean; receipt?: string; claim?: string; at?: string }) {
  const at = fields.at ?? '2026-09-27 12:00:00';
  db.prepare(`INSERT INTO bot_message_drafts(id,conversation_id,request_key,payload_json,state,authorized_by,receipt,claim_key,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run(id, 'bot', id, '{}', fields.state, fields.authorized ? 1 : null, fields.receipt ?? null, fields.claim ?? null, at, at);
}
beforeEach(() => {
  db = new Database(':memory:'); db.pragma('foreign_keys=ON');
  migrate(db, fileURLToPath(new URL('../src/db/migrations', import.meta.url)));
  db.prepare("INSERT INTO users(id,email,display_name,role) VALUES(1,'owner@fixture.test','Owner','owner'),(2,'member@fixture.test','Member','member')").run();
  db.prepare("INSERT INTO business_teams(id,name,owner_id) VALUES('team','Fixture',1),('other','Other',2)").run();
  db.prepare("INSERT INTO conversations(id,assistant_id,user_id,title,provider,model,native_session_id,visibility,business_team_id) VALUES('bot',1,1,'Fixture','claude','fixture-model','fixture','team','team'),('outside',1,2,'Outside','claude','fixture-model','outside','team','other')").run();
  db.prepare("INSERT INTO bot_registrations(conversation_id,name,registered_by) VALUES('bot','Fixture',1),('outside','Outside',2)").run();
  db.prepare("INSERT INTO business_bot_members(conversation_id,team_id,role,subteam) VALUES('bot','team','bot','Customer Service')").run();
  owner = { user: db.prepare('SELECT * FROM users WHERE id=1').get() as UserRow };
  bot = { ...owner, conversationId: 'bot' };
});
afterEach(() => db.close());

it('shows the owner authorization as the single remaining step before enrollment', () => {
  const view = csReadiness(db, now).read(owner, { business_id: 'team' });
  const photo = state(view, 'routine-product-label-photo');
  expect(photo).toMatchObject({ state: 'awaiting_owner', state_label: 'Waiting for owner authorization', execute: false });
  expect(photo.blockers).toEqual([{ owner: 'Business owner', dependency: expect.stringContaining('/#/routine-reply-setup') }]);
  expect(photo.evidence[0]).toContain('not an enrollment');
  expect(view.autonomous).toEqual([]);
});
it('stays tested after enrollment, becomes a pilot only with a receipt, blocks on an unknown outcome and pauses on revocation', () => {
  const policies = csStandingPolicy(db, now), service = csReadiness(db, now);
  const review = policies.status(owner, 'team');
  const enrolled = policies.enroll(owner, { business_id: 'team', expected_version: 0, request_key: 'enroll', executor_ids: ['bot'], daily_cap: 20, review_hash: review.review_hash, confirm: true });
  expect(state(service.read(owner, { business_id: 'team' }), 'routine-product-label-photo')).toMatchObject({ state: 'tested', blockers: [] });
  const standing = (id: string, ticket: string, fields: Parameters<typeof draft>[1]) => {
    draft(id, fields);
    db.prepare("INSERT INTO cs_standing_authorizations(draft_id,policy_id,policy_version,business_id,template_key,executor_id,ticket,draft_version,payload_hash) VALUES(?,?,1,'team',?,'bot',?,1,'hash')").run(id, enrolled.policy!.id, policies.template.key, ticket);
  };
  standing('photo-sent', 'T1', { state: 'sent', receipt: 'provider-1', claim: 'k1' });
  let view = service.read(owner, { business_id: 'team' });
  expect(state(view, 'routine-product-label-photo').state).toBe('live_for_pilot');
  expect(view.autonomous).toEqual(['routine-product-label-photo']);
  standing('photo-claimed', 'T2', { state: 'sending', claim: 'k2' });
  expect(state(service.read(owner, { business_id: 'team' }), 'routine-product-label-photo')).toMatchObject({ state: 'blocked_on_integration', blockers: [{ owner: 'Fixture' }] });
  policies.revoke(owner, { policy_id: enrolled.policy!.id, reason: 'Stop' });
  view = service.read(owner, { business_id: 'team' });
  expect(state(view, 'routine-product-label-photo').state).toBe('paused');
  expect(view.autonomous).toEqual([]);
});
it('never reports the approved reply live while a send outcome is unknown or an authorized message is overdue', () => {
  const service = csReadiness(db, now);
  expect(state(service.read(owner, { business_id: 'team' }), 'approved-customer-reply').state).toBe('tested');
  draft('sent', { state: 'sent', authorized: true, receipt: 'provider-1', claim: 'k1' });
  expect(state(service.read(owner, { business_id: 'team' }), 'approved-customer-reply').state).toBe('live');
  draft('claimed', { state: 'sending', authorized: true, claim: 'k2' });
  draft('overdue', { state: 'queued', authorized: true });
  draft('fresh', { state: 'queued', authorized: true, at: '2026-09-29 11:00:00' });
  draft('unreviewed', { state: 'draft' });
  const reply = state(service.read(owner, { business_id: 'team' }), 'approved-customer-reply');
  expect(reply.state).toBe('blocked_on_integration');
  expect(reply.blockers).toHaveLength(2);
  expect(reply.blockers[0]!.dependency).toContain('must not send again');
  expect(reply.blockers.every(b => b.owner === 'Fixture')).toBe(true);
  expect(reply.evidence[0]).toContain('1 sent with receipt, 1 with unknown outcome, 1 authorized and overdue, 1 drafts never authorized');
});
it('does not count a sent state without a receipt as delivered', () => {
  draft('claimed-sent', { state: 'sent', authorized: true, claim: 'k' });
  const reply = state(csReadiness(db, now).read(owner, { business_id: 'team' }), 'approved-customer-reply');
  expect(reply.state).toBe('blocked_on_integration');
});
it('lists unbuilt case types as draft with a named dependency and changes no record', () => {
  const before = db.prepare('SELECT revision FROM compose_context_clock').get();
  const view = csReadiness(db, now).read(bot, { business_id: 'team' });
  expect(view.capabilities.filter(c => c.state === 'draft').map(c => c.id)).toContain('routine-factual-tracking');
  expect(view.capabilities.every(c => c.execute === false && (c.state === 'live' || c.state === 'tested' || c.blockers.length > 0))).toBe(true);
  expect(db.prepare('SELECT revision FROM compose_context_clock').get()).toEqual(before);
});
it('refuses another business, a non-owner, an inactive bot and an unknown business', () => {
  const service = csReadiness(db, now);
  const member: Actor = { user: db.prepare('SELECT * FROM users WHERE id=2').get() as UserRow };
  expect(() => service.read(member, { business_id: 'team' })).toThrow('business owner');
  expect(() => service.read({ ...member, conversationId: 'outside' }, { business_id: 'team' })).toThrow('exact business');
  expect(() => service.read(owner, { business_id: 'missing' })).toThrow('not found');
  expect(() => service.read(owner, { business_id: 'team', extra: true })).toThrow();
  db.prepare('UPDATE bot_registrations SET active=0 WHERE conversation_id=?').run('bot');
  expect(() => service.read(bot, { business_id: 'team' })).toThrow('exact business');
});
it('routes the bot tool to the read-only endpoint', async () => {
  const callApi = vi.fn(async (_path: string, _init?: RequestInit): Promise<Record<string, unknown>> => ({}));
  await callBotTool({ name: 'read_cs_readiness', args: { business_id: 'team' }, callApi });
  expect(callApi.mock.calls[0]?.[0]).toBe('/api/bot-communication/cs-readiness');
  expect(JSON.parse((callApi.mock.calls[0]?.[1] as RequestInit).body as string)).toEqual({ business_id: 'team' });
});

it('summarizes delays by nearest rank without inventing values', () => {
  expect(summarizeDelays([])).toEqual({ count: 0, median_minutes: null, p95_minutes: null });
  expect(summarizeDelays([5, 1, 100, -3, Number.NaN])).toEqual({ count: 3, median_minutes: 5, p95_minutes: 100 });
});
it('measures approval follow-through and drafts by model group inside the window only', () => {
  const decision = (id: string, decisionState: string, answer: string | null, at: string) =>
    db.prepare("INSERT INTO bot_decisions(id,conversation_id,source_key,proposal_key,state,proposal_json,assignee_id,answer_json,created_at) VALUES(?,'bot',?,?,?,'{}',1,?,?)")
      .run(id, id, id, decisionState, answer ? JSON.stringify({ action: answer }) : null, at);
  const event = (decisionId: string, kind: string, payload: object, at: string, byBot = false) =>
    db.prepare('INSERT INTO bot_decision_events(id,decision_id,version,kind,actor_id,actor_conversation_id,payload_json,request_key,created_at) VALUES(?,?,1,?,1,?,?,?,?)')
      .run(`${decisionId}-${kind}-${at}`, decisionId, kind, byBot ? 'bot' : null, JSON.stringify(payload), `${kind}-${at}`, at);
  decision('done', 'verified_completed', 'approve', '2026-09-23 10:00:00');
  event('done', 'answered', { action: 'approve' }, '2026-09-23 10:10:00');
  event('done', 'result', { state: 'running' }, '2026-09-23 10:20:00', true);
  event('done', 'result', { state: 'verified_completed' }, '2026-09-23 11:10:00', true);
  decision('stuck', 'blocked', 'approve', '2026-09-24 10:00:00');
  event('stuck', 'answered', { action: 'approve' }, '2026-09-24 10:00:00');
  event('stuck', 'message', { text: 'Send it.' }, '2026-09-24 12:00:00');
  event('stuck', 'result', { state: 'blocked' }, '2026-09-24 13:00:00', true);
  decision('waiting', 'needs_input', null, '2026-09-25 10:00:00');
  decision('earlier', 'verified_completed', 'approve', '2026-09-01 10:00:00');
  draft('sent', { state: 'sent', authorized: true, receipt: 'provider-1', claim: 'k1', at: '2026-09-23 10:00:00' });
  draft('idle', { state: 'draft', at: '2026-09-23 10:00:00' });
  db.prepare("INSERT INTO turn_origins(conversation_id,turn_id,prompt_text,event_at,origin_json) VALUES('bot','t1','fixture','2026-09-23T10:00:00.000Z','{}'),('bot','t0','fixture','2026-09-01T10:00:00.000Z','{}')").run();

  const report = csOutcomes(db).report({ business_id: 'team', since: '2026-09-22T00:00:00Z', until: '2026-09-29T00:00:00Z' });
  expect(report.total).toMatchObject({
    turns: 1, decisions_raised: 3, approved: 2, approved_verified_completed: 1, approved_blocked: 1, approved_open: 0,
    human_answers: 2, human_discussion_messages: 1,
    answers: { approve: 2, unanswered: 1 }, drafts: { sent_with_receipt: 1, unauthorized_draft: 1 },
  });
  expect(report.approval_to_first_result).toEqual({ count: 2, median_minutes: 10, p95_minutes: 180 });
  expect(report.approval_to_verified_completion).toEqual({ count: 1, median_minutes: 60, p95_minutes: 60 });
  expect(report.model_groups['claude/fixture-model']).toMatchObject({ bots: ['Fixture'], approved: 2 });
  expect(() => csOutcomes(db).report({ business_id: 'team', since: '2026-09-29T00:00:00Z', until: '2026-09-22T00:00:00Z' })).toThrow('end after');
});
