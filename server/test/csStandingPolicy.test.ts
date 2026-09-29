import Database from 'better-sqlite3';
import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { migrate } from '../src/db/migrate.js';
import { communicationService, draftPayload } from '../src/bots/communication.js';
import { csStandingPolicy, labelPhotoTemplate } from '../src/bots/csStandingPolicy.js';
import { createBotService, proposalSchema, type Actor } from '../src/bots/service.js';
import type { UserRow } from '../src/db/db.js';

// Synthetic data only. `provider` stands for the one real send an executor may make.
describe('standing authority for the product-label photo request', () => {
  let db: Database.Database, owner: Actor, member: Actor, named: Actor, unnamed: Actor, provider: string[];
  const messages = () => communicationService(db);
  const policies = () => csStandingPolicy(db);
  const request = (ticket = 'T-1001', changes: object = {}) => draftPayload.parse({
    channel: 'email', account: 'Fixture Parts support', recipients: ['customer@fixture-mail.test'],
    body: labelPhotoTemplate.body, customer: 'Fixture Customer', ticket, ...changes,
  });
  function enroll(executors = ['named'], cap = 20, key = 'enroll-1') {
    const review = policies().status(owner, 'team');
    return policies().enroll(owner, { business_id: 'team', expected_version: review.expected_version, request_key: key, executor_ids: executors, daily_cap: cap, review_hash: review.review_hash, confirm: true });
  }
  function send(actor: Actor, id: string, key: string) {
    const claim = messages().claim(actor, id, key);
    if (claim.execute) provider.push(claim.idempotency_key);
    return claim;
  }
  beforeEach(() => {
    db = new Database(':memory:'); db.pragma('foreign_keys=ON');
    migrate(db, fileURLToPath(new URL('../src/db/migrations', import.meta.url)));
    db.prepare("INSERT INTO users(id,email,display_name,role) VALUES(1,'owner@fixture.test','Owner','owner'),(2,'member@fixture.test','Member','member')").run();
    db.prepare("INSERT INTO business_teams(id,name,owner_id) VALUES('team','Fixture',1),('other','Other',2)").run();
    for (const [id, user, team] of [['named', 1, 'team'], ['unnamed', 1, 'team'], ['outside', 2, 'other']] as const) {
      db.prepare("INSERT INTO conversations(id,assistant_id,user_id,title,provider,native_session_id,visibility,business_team_id) VALUES(?,1,?,?,'claude',?,'team',?)").run(id, user, id, `native-${id}`, team);
      db.prepare('INSERT INTO bot_registrations(conversation_id,name,registered_by) VALUES(?,?,?)').run(id, id, user);
      db.prepare("INSERT INTO business_bot_members(conversation_id,team_id,role,subteam) VALUES(?,?,'bot','Customer Service')").run(id, team);
    }
    owner = { user: db.prepare('SELECT * FROM users WHERE id=1').get() as UserRow };
    member = { user: db.prepare('SELECT * FROM users WHERE id=2').get() as UserRow };
    named = { ...owner, conversationId: 'named' };
    unnamed = { ...owner, conversationId: 'unnamed' };
    provider = [];
  });
  afterEach(() => db.close());

  it('lets only the signed-in owner enroll, and replays a lost response without a second policy', () => {
    const review = policies().status(owner, 'team');
    expect(review).toMatchObject({ status: 'not_enrolled', expected_version: 0, default_daily_cap: 20 });
    expect(review.template.body).toBe('To help us understand your question, please provide the following information:\n\nPlease reply with a clear photo of the product label.\n\nThank you.');
    expect(review.candidates.map(c => c.conversation_id)).toEqual(['named', 'unnamed']);
    const input = { business_id: 'team', expected_version: 0, request_key: 'enroll-1', executor_ids: ['named'], daily_cap: 20, review_hash: review.review_hash, confirm: true };
    expect(() => policies().enroll(named, input)).toThrow('a bot cannot enroll');
    expect(() => policies().enroll(member, input)).toThrow('business owner');
    expect(() => policies().status(member, 'team')).toThrow('business owner');
    expect(() => policies().enroll(owner, { ...input, confirm: false })).toThrow();
    expect(() => policies().enroll(owner, { ...input, review_hash: 'a'.repeat(64) })).toThrow('changed');
    expect(() => policies().enroll(owner, { ...input, executor_ids: ['outside'] })).toThrow('exact business');
    expect(db.prepare('SELECT count(*) n FROM cs_standing_policies').get()).toEqual({ n: 0 });
    const enrolled = policies().enroll(owner, input);
    expect(enrolled).toMatchObject({ status: 'enrolled', policy: { version: 1, daily_cap: 20, executors: [{ conversation_id: 'named', name: 'named' }] } });
    expect(policies().enroll(owner, input).policy!.id).toBe(enrolled.policy!.id);
    expect(() => policies().enroll(owner, { ...input, daily_cap: 50 })).toThrow('conflict');
    expect(() => enroll(['named'], 20, 'enroll-2')).toThrow('already active');
    expect(db.prepare('SELECT count(*) n FROM cs_standing_policies').get()).toEqual({ n: 1 });
    expect(() => db.prepare('UPDATE cs_standing_policies SET daily_cap=200').run()).toThrow('immutable');
  });
  it('queues the exact request for a named bot and sends it once with no fabricated approver', () => {
    const policy = enroll().policy!;
    const draft = messages().saveDraft(named, 'named', 'draft-1', request());
    expect(draft).toMatchObject({ state: 'queued', authorized_by: null, authorization_basis: 'standing_policy', standing_policy: { applied: true, policy_id: policy.id, policy_version: 1 } });
    const claim = send(named, draft.id, 'claim-1');
    expect(claim).toMatchObject({ execute: true, idempotency_key: `veneer-message:${draft.id}`, authorized_name: 'Standing policy enrolled by Owner' });
    expect(claim.approval_source).toContain(`standing policy ${policy.id} v1`);
    expect(claim.payload.body).toBe(labelPhotoTemplate.body);
    expect(send(named, draft.id, 'claim-1').execute).toBe(false);
    messages().receipt(named, draft.id, 'claim-1', 'uncertain', 'Timed out after submission.');
    expect(() => send(named, draft.id, 'claim-2')).toThrow('do not resend');
    expect(messages().receipt(named, draft.id, 'claim-1', 'sent', 'Provider receipt fixture-1').state).toBe('sent');
    expect(provider).toEqual([`veneer-message:${draft.id}`]);
    expect(policies().status(owner, 'team')).toMatchObject({ sent_with_receipt: 1, used_today: 1 });
  });
  it.each([
    ['one changed character', { body: labelPhotoTemplate.body.replace('Thank you.', 'Thank you!') }],
    ['an added promise', { body: `${labelPhotoTemplate.body}\n\nWe will refund you.` }],
    ['SMS', { channel: 'sms', recipients: ['+15555550123'] }],
    ['a subject line', { subject: 'Refund approved' }],
    ['an attachment', { attachments: [{ name: 'label.pdf', reference: 'fixture' }] }],
    ['two recipients', { recipients: ['customer@fixture-mail.test', 'other@fixture-mail.test'] }],
    ['a recipient that is not an email', { recipients: ['Fixture Customer'] }],
  ])('leaves %s as an ordinary draft that needs a person', (_name, changes) => {
    enroll();
    const draft = messages().saveDraft(named, 'named', 'draft-1', request('T-1001', changes));
    expect(draft).toMatchObject({ state: 'draft', authorized_by: null, authorization_basis: 'human_draft', standing_policy: { applied: false } });
    expect(draft.standing_policy.reasons.length).toBeGreaterThan(0);
    expect(() => send(named, draft.id, 'claim')).toThrow();
    expect(db.prepare('SELECT count(*) n FROM cs_standing_authorizations').get()).toEqual({ n: 0 });
    expect(provider).toEqual([]);
  });
  it('does nothing before enrollment and nothing for a bot that is not named', () => {
    const before = messages().saveDraft(named, 'named', 'draft-0', request('T-0'));
    expect(before).toMatchObject({ state: 'draft', standing_policy: { applied: false, policy_id: null } });
    enroll();
    const draft = messages().saveDraft(unnamed, 'unnamed', 'draft-1', request());
    expect(draft).toMatchObject({ state: 'draft', standing_policy: { applied: false, reasons: ['This bot is not named in the standing policy.'] } });
    expect(() => send(unnamed, draft.id, 'claim')).toThrow();
    // Enrollment does not reach back to a draft saved before it.
    expect(messages().readDraft(owner, before.id).state).toBe('draft');
  });
  it.each(['reject', 'defer', 'withdraw'])('sends nothing when a person recorded %s on the ticket', action => {
    enroll();
    const proposal = proposalSchema.parse({ question: 'Approve replacement?', recommendation: 'Review.', consequence: 'None.', assignee_id: 1, blocked_action: 'Replacement only.' });
    const bots = createBotService(db);
    const decision = bots.raise(named, { source_key: 'case', proposal_key: 'remedy', proposal });
    db.prepare("UPDATE bot_decisions SET answer_json=?,state='decided' WHERE id=?").run(JSON.stringify({ action }), decision.id);
    const bound = messages().saveDraft(named, 'named', 'draft-1', request('T-1001'), decision.id, decision.version);
    expect(bound).toMatchObject({ state: 'draft', standing_policy: { applied: false } });
    expect(bound.standing_policy.reasons.join(' ')).toContain(action);
    // The direction follows the ticket, not only the draft it was recorded against.
    const later = messages().saveDraft(named, 'named', 'draft-2', request('t-1001'));
    expect(later).toMatchObject({ state: 'draft', standing_policy: { applied: false } });
    expect(messages().saveDraft(named, 'named', 'draft-3', request('T-2002')).state).toBe('queued');
  });
  it('allows one request per ticket, enforced by the database', () => {
    enroll(['named', 'unnamed']);
    expect(messages().saveDraft(named, 'named', 'draft-1', request('T-1001')).state).toBe('queued');
    const second = messages().saveDraft(unnamed, 'unnamed', 'draft-2', request('t-1001'));
    expect(second).toMatchObject({ state: 'draft', standing_policy: { applied: false } });
    expect(second.standing_policy.reasons[0]).toContain('already queued');
    expect(() => db.prepare("INSERT INTO cs_standing_authorizations(draft_id,policy_id,policy_version,business_id,template_key,executor_id,ticket,draft_version,payload_hash) SELECT ?,policy_id,1,'team',template_key,'unnamed','T-1001',1,'hash' FROM cs_standing_authorizations").run(second.id)).toThrow('UNIQUE');
    // Retiring the request does not free the ticket for another automatic one.
    const first = messages().list(named, 'named').drafts[0]!;
    messages().retire(named, first.id, { expected_version: first.version, request_key: 'retire', reason: 'Customer sent the photo.', evidence: 'Fixture evidence' });
    expect(messages().saveDraft(named, 'named', 'draft-3', request('T-1001')).state).toBe('draft');
  });
  it('stops at the daily limit and resumes the next day', () => {
    let time = Date.parse('2026-09-29T15:00:00Z');
    const clock = csStandingPolicy(db, () => time);
    const review = clock.status(owner, 'team');
    clock.enroll(owner, { business_id: 'team', expected_version: 0, request_key: 'enroll', executor_ids: ['named'], daily_cap: 2, review_hash: review.review_hash, confirm: true });
    const save = (n: number) => {
      const payload = request(`T-${n}`);
      db.prepare("INSERT INTO bot_message_drafts(id,conversation_id,request_key,payload_json) VALUES(?,'named',?,?)").run(`d${n}`, `d${n}`, JSON.stringify(payload));
      return clock.apply(named, db.prepare('SELECT * FROM bot_message_drafts WHERE id=?').get(`d${n}`) as never);
    };
    expect(save(1).applied).toBe(true);
    expect(save(2).applied).toBe(true);
    const third = save(3);
    expect(third.applied).toBe(false);
    expect(third.reasons[0]).toContain('daily limit of 2');
    expect((db.prepare("SELECT state FROM bot_message_drafts WHERE id='d3'").get() as { state: string }).state).toBe('draft');
    time = Date.parse('2026-09-30T00:05:00Z');
    expect(save(4).applied).toBe(true);
    expect(() => clock.enroll(owner, { business_id: 'team', expected_version: 1, request_key: 'too-many', executor_ids: ['named'], daily_cap: 201, review_hash: review.review_hash, confirm: true })).toThrow();
  });
  it('revocation stops every unclaimed request at once and leaves a claimed one to reconcile', () => {
    const policy = enroll().policy!;
    const claimed = messages().saveDraft(named, 'named', 'draft-1', request('T-1'));
    const waiting = messages().saveDraft(named, 'named', 'draft-2', request('T-2'));
    expect(send(named, claimed.id, 'claim-1').execute).toBe(true);
    expect(() => policies().revoke(named, { policy_id: policy.id, reason: 'Stop' })).toThrow('a bot cannot');
    expect(() => policies().revoke(member, { policy_id: policy.id, reason: 'Stop' })).toThrow('business owner');
    expect(policies().revoke(owner, { policy_id: policy.id, reason: 'Stop' })).toMatchObject({ status: 'revoked', policy: { revoked: { reason: 'Stop' } } });
    expect(policies().revoke(owner, { policy_id: policy.id, reason: 'Stop' }).status).toBe('revoked');
    expect(() => policies().revoke(owner, { policy_id: policy.id, reason: 'Other' })).toThrow('already recorded');
    expect(() => send(named, waiting.id, 'claim-2')).toThrow('revoked or replaced');
    expect(messages().saveDraft(named, 'named', 'draft-3', request('T-3'))).toMatchObject({ state: 'draft', standing_policy: { applied: false } });
    // The claimed send is past recall: its receipt is still recorded, and it is never sent again.
    expect(send(named, claimed.id, 'claim-1').execute).toBe(false);
    expect(messages().receipt(named, claimed.id, 'claim-1', 'sent', 'Provider receipt fixture-1').state).toBe('sent');
    expect(provider).toHaveLength(1);
    // A new version needs a fresh owner enrollment and does not revive the stopped draft.
    expect(enroll(['named'], 20, 'enroll-2')).toMatchObject({ status: 'enrolled', policy: { version: 2 } });
    expect(() => send(named, waiting.id, 'claim-3')).toThrow('revoked or replaced');
  });
  it('stops when the issuer no longer owns the business or the bot is removed', () => {
    enroll();
    const first = messages().saveDraft(named, 'named', 'draft-1', request('T-1'));
    db.prepare('UPDATE bot_registrations SET active=0 WHERE conversation_id=?').run('named');
    expect(() => send(named, first.id, 'claim-1')).toThrow();
    db.prepare('UPDATE bot_registrations SET active=1 WHERE conversation_id=?').run('named');
    db.prepare("UPDATE business_teams SET owner_id=2 WHERE id='team'").run();
    expect(() => send(named, first.id, 'claim-1')).toThrow();
    expect(provider).toEqual([]);
  });
});
