import Database from 'better-sqlite3';
import { beforeEach, afterEach, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { migrate } from '../src/db/migrate.js';
import { routinePolicyService } from '../src/bots/routinePolicies.js';
import { routineExecutionService, routineCaptureSchema } from '../src/bots/routineExecution.js';
import { communicationService } from '../src/bots/communication.js';
import { canonicalSha256 } from '../src/bots/canonical.js';
import type { Actor } from '../src/bots/service.js';
import type { UserRow } from '../src/db/db.js';
let db: Database.Database, s: ReturnType<typeof routineExecutionService>, human: Actor, bot: Actor, time: number, policyId: string, trustId: string;
const identity = { clientId: 'routine-only-client', audience: 'routine-only-audience' };
const trustInput = () => ({ policy_id: policyId, executor_id: 'tess', request_key: 'trust-once', client_id: identity.clientId, audience: identity.audience, account_id: 'registered-routine-source', principal_id: 'own-principal', source_origin: 'https://source.example.test', registration_reference: 'Fixture current owner and source custodian registration; reviewed adapter digest', adapter_digest: 'a'.repeat(64), contract: 'routine-missing-information/v1' });
function capture(key = 'prepare') {
  return routineCaptureSchema.parse({ schema_version: 'routine-missing-information/v1', trust_id: trustId, request_key: key,
    native_context_revision:s.nativeContext(identity,{trust_id:trustId,canonical_case:'case'}).revision, captured_at: new Date(time).toISOString(), adapter_digest: 'a'.repeat(64), account_id: 'registered-routine-source', principal_id: 'own-principal', source_origin: 'https://source.example.test', enrollment_revision: 'enrollment1', source_intent: 'case-request1',
    lease: { case_id: 'case', principal_id: 'own-principal', revision: 'lease1', expires_at: new Date(time + 60000).toISOString() },
    material: { case_id: 'case', ticket: 'TICKET', customer_id: 'customer', sender_account: 'help@example.test', recipient: 'customer@example.test', retained_principal_id: 'own-principal', revision: 'case1',
      context: { completeness: 'all-channels-sisters-and-outbound/v1', snapshot_revision: 'snapshot1', channels: ['email'], conversation_ids: ['case'], message_count: 3, messages_hash: 'b'.repeat(64), source_records_hash: 'c'.repeat(64), next_cursor: null, truncation: 'none' },
      human_directive: 'none', prior_effect: 'none', disposition: 'open_question', requested_fields: ['model_number'], field_evidence: [{ field: 'model_number', state: 'missing', relevance: 'needed_for_current_question', evidence_revision: 'snapshot1' }], duplicate_scope_hashes: [],
    } });
}
function prepared() {
  const proof = s.capture(identity, capture());
  const d = communicationService(db).saveDraft(bot, 'tess', 'draft1', proof.scope.payload);
  const args = { draft_id: d.id, proof_id: proof.proof_id, expected_version: d.version, request_key: 'accept1' };
  return { proof, d, args };
}
function accepted() {
  const p = prepared(); s.accept(bot, p.args);
  const claimProof = s.capture(identity, capture('claim'));
  return { ...p, claimProof, claim: { draft_id: p.d.id, proof_id: claimProof.proof_id, claim_key: 'claim1' } };
}
beforeEach(() => {
  time = Date.parse('2026-09-23T20:00:00Z'); db = new Database(':memory:'); db.pragma('foreign_keys=ON'); migrate(db, fileURLToPath(new URL('../src/db/migrations', import.meta.url)));
  db.prepare("INSERT INTO users(id,email,display_name,role) VALUES(1,'owner@example.test','Owner','owner'),(2,'foreign@example.test','Foreign','owner')").run();
  db.prepare("INSERT INTO business_teams(id,name,owner_id) VALUES('team','Fixture',1),('foreign','Foreign',2)").run();
  for (const [id, business, user] of [['tess', 'team', 1], ['other', 'team', 1], ['foreign', 'foreign', 2]] as const) {
    db.prepare("INSERT INTO conversations(id,assistant_id,user_id,title,provider,native_session_id,visibility,business_team_id) VALUES(?,1,?,?,'claude',?,'team',?)").run(id, user, id, id, business);
    db.prepare('INSERT INTO bot_registrations(conversation_id,name,active,registered_by) VALUES(?,?,1,?)').run(id, id, user);
  }
  human = { user: db.prepare('SELECT * FROM users WHERE id=1').get() as UserRow }; bot = { ...human, conversationId: 'tess' };
  policyId = routinePolicyService(db).enroll(human, { business_id: 'team', policy_key: 'routine', expected_version: 0, request_key: 'policy1', source_reference: 'Fixture current source policy', policy_text: 'Only actually missing information without remedy promises. Preserve all financial, ownership, human hold, duplicate and unknown effect gates.', executor_ids: ['tess'], categories: ['missing_information'] }).id;
  s = routineExecutionService(db, { now: () => time, identity }); trustId = s.enroll(human, trustInput()).trust_id;
});
afterEach(() => db.close());
it('accepts exact native template without inventing human approval and delivers once only with trusted readback', () => {
  const p = accepted();
  expect(s.inspect(bot, p.proof.proof_id)).toMatchObject({ ready: true, execute: false });
  expect(s.accept(bot, p.args)).toMatchObject({ execute: false, authorization_basis: 'standing_policy' });
  expect(db.prepare('SELECT authorized_by FROM bot_message_drafts').get()).toEqual({ authorized_by: null });
  expect(db.prepare('SELECT count(*) n FROM bot_decision_events').get()).toEqual({ n: 0 });
  expect(() => communicationService(db).claim(bot, p.d.id, 'legacy')).toThrow('claim_routine_message');
  expect(s.claim(bot, p.claim).execute).toBe(false);
  expect(s.dispatchClaim(identity,{...p.claim,source_intent:"case-request1",scope_hash:p.proof.scope_hash,material_hash:p.proof.material_hash,request_key:"dispatch1"}).execute).toBe(true); expect(s.claim(bot, p.claim).execute).toBe(false);
  expect(() => s.claim(bot, { ...p.claim, claim_key: 'retry' })).toThrow();
  expect(() => communicationService(db).receipt(bot, p.d.id, 'claim1', 'sent', 'invented')).toThrow('trusted');
  communicationService(db).receipt(bot, p.d.id, 'claim1', 'uncertain', 'Timeout; no retry');
  const receipt = { draft_id: p.d.id, claim_key: 'claim1', scope_hash: p.proof.scope_hash, material_hash: p.proof.material_hash, account_id: 'registered-routine-source', principal_id: 'own-principal', idempotency_key: `veneer-message:${p.d.id}`, source_intent: 'case-request1', provider_message_id: 'provider1', verified_at: new Date(time).toISOString(), state: 'SENT', sent_count: 1, payload_hash: canonicalSha256(p.proof.scope.payload) };
  for (const changed of [{ ...receipt, sent_count: 2 }, { ...receipt, payload_hash: 'f'.repeat(64) }, { ...receipt, principal_id: 'other' }, { ...receipt, idempotency_key: 'new' }]) expect(() => s.readback(identity, changed)).toThrow();
  expect(s.readback(identity, receipt)).toEqual({ state: 'sent', execute: false }); expect(s.readback(identity, receipt)).toEqual({ state: 'sent', execute: false });
  expect(s.reconcile(identity, p.d.id)).toMatchObject({ state: 'sent', execute: false, claimed: true });
  expect(() => db.prepare('DELETE FROM routine_draft_authorizations').run()).toThrow('immutable');
});
it.each(['hold','reject','defer','withdraw'] as const)('preserves %s', directive => {
  const c = capture(); c.material.human_directive = directive; expect(() => s.capture(identity, c)).toThrow('blocks');
});
it.each(['sent','pending','unknown'] as const)('denies prior %s effects', effect => {
  const c = capture(); c.material.prior_effect = effect; expect(() => s.capture(identity, c)).toThrow('blocks');
});
it.each(['resolved','acknowledgment_only','no_contact'] as const)('does not invent extra email for %s', disposition => {
  const c = capture(); c.material.disposition = disposition; expect(() => s.capture(identity, c)).toThrow();
});
it.each(['principal','owner','account','origin','adapter','lease','stale','present','irrelevant','incomplete','extra','financial'] as const)('rejects unsafe source %s', kind => {
  const c = capture();
  if (kind === 'principal') c.principal_id = 'foreign'; if (kind === 'owner') c.material.retained_principal_id = 'foreign';
  if (kind === 'account') c.account_id = 'foreign'; if (kind === 'origin') c.source_origin = 'https://foreign.example.test';
  if (kind === 'adapter') c.adapter_digest = 'f'.repeat(64); if (kind === 'lease') c.lease.expires_at = new Date(time + 29000).toISOString();
  if (kind === 'stale') c.captured_at = new Date(time - 16000).toISOString();
  if (kind === 'present') c.material.field_evidence[0]!.state = 'present'; if (kind === 'irrelevant') c.material.field_evidence[0]!.relevance = 'not_needed';
  if (kind === 'incomplete') Object.assign(c.material.context, { next_cursor: 'page2' }); if (kind === 'extra') Object.assign(c, { eligible: true });
  if (kind === 'financial') Object.assign(c.material, { requested_fields: ['refund'] });
  expect(() => s.capture(identity, c)).toThrow();
});
it('requires genuine owner, separate configured transport and exact named bot', () => {
  expect(() => s.enroll(bot, trustInput())).toThrow('human');
  expect(() => routineExecutionService(db).enroll(human, trustInput())).toThrow('configured');
  expect(() => s.enroll(human, { ...trustInput(), executor_id: 'foreign', request_key: 'foreign' })).toThrow();
  expect(() => s.capture({ ...identity, clientId: 'return-client' }, capture())).toThrow('identity');
  const p = prepared(); expect(() => s.accept({ ...human, conversationId: 'other' }, p.args)).toThrow();
  expect(() => s.inspect(human, p.proof.proof_id)).toThrow('owning');
});
it.each(['body','recipient','subject','attachments','case','version'] as const)('does not authorize changed %s', field => {
  const p = prepared(), payload = structuredClone(p.proof.scope.payload);
  if (field === 'body') payload.body = 'Refund $100'; if (field === 'recipient') payload.recipients = ['other@example.test'];
  if (field === 'subject') payload.subject = 'Replacement approved'; if (field === 'attachments') payload.attachments = [{ name: 'new', reference: 'private' }];
  if (field === 'case') payload.ticket = 'OTHER';
  if (field === 'version') db.prepare('UPDATE bot_message_drafts SET version=2').run();
  else db.prepare('UPDATE bot_message_drafts SET payload_json=?').run(JSON.stringify(payload));
  expect(() => s.accept(bot, p.args)).toThrow();
});
it.each(['policy','trust','bot','user','business'] as const)('revoked %s denies fresh claim', kind => {
  const p = accepted();
  if (kind === 'policy') routinePolicyService(db).revoke(human, policyId, 'stop');
  if (kind === 'trust') s.revoke(human, trustId, 'stop');
  if (kind === 'bot') db.prepare("UPDATE bot_registrations SET active=0 WHERE conversation_id='tess'").run();
  if (kind === 'user') db.prepare("UPDATE users SET status='disabled' WHERE id=1").run();
  if (kind === 'business') db.prepare("UPDATE business_teams SET owner_id=2 WHERE id='team'").run();
  expect(() => s.claim(bot, p.claim)).toThrow();
});
it('requires separate fresh claim capture of unchanged material and rejects duplicate intent', () => {
  const p = accepted(); expect(() => s.claim(bot, { ...p.claim, proof_id: p.proof.proof_id })).toThrow('Fresh');
  const changed = capture('changed'); changed.material.revision = 'case2';
  const newer = s.capture(identity, changed); expect(() => s.claim(bot, { ...p.claim, proof_id: newer.proof_id })).toThrow('changed material');
  const duplicate = capture('duplicate'); duplicate.material.duplicate_scope_hashes = [p.proof.scope_hash]; expect(() => s.capture(identity, duplicate)).toThrow('already');
  const d2 = communicationService(db).saveDraft(bot, 'tess', 'draft2', p.proof.scope.payload);
  expect(() => s.accept(bot, { ...p.args, draft_id: d2.id, proof_id: p.claimProof.proof_id, request_key: 'second' })).toThrow('reserved');
  time += 16000; expect(() => s.claim(bot, p.claim)).toThrow('stale');
});
it('serializes retirement against claim and never allows stale wake/send after retirement', () => {
  const p = accepted(); communicationService(db).retire(bot, p.d.id, { expected_version: 2, request_key: 'retire', reason: 'Obsolete', evidence: 'Independent reference, not delivery' });
  expect(() => s.claim(bot, p.claim)).toThrow('retired');
});
it('claim wins retirement race; unknown result stays non-reusable after trust revocation', () => {
  const p = accepted(); s.claim(bot, p.claim);
  expect(() => communicationService(db).retire(bot, p.d.id, { expected_version: 2, request_key: 'retire', reason: 'Obsolete', evidence: 'Reference' })).toThrow('unclaimed');
  s.revoke(human, trustId, 'stop');
  expect(s.reconcile(identity, p.d.id)).toMatchObject({ execute: false, claimed: true, state: 'sending' });
  expect(() => s.claim(bot, { ...p.claim, claim_key: 'retry' })).toThrow();
});
it('two independent SQLite connections serialize competing claims under a write lock', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const p = accepted(), dir = mkdtempSync(join(tmpdir(), 'routine-race-')), file = join(dir, 'fixture.db');
  await db.backup(file);
  const left = new Database(file), right = new Database(file); left.pragma('foreign_keys=ON'); right.pragma('foreign_keys=ON'); right.pragma('busy_timeout=0');
  try {
    const a = routineExecutionService(left, { now: () => time }), b = routineExecutionService(right, { now: () => time });
    left.exec('BEGIN IMMEDIATE'); expect(a.claim(bot, p.claim).execute).toBe(false);
    expect(() => b.claim(bot, { ...p.claim, claim_key: 'competing' })).toThrow(/locked/);
    left.exec('COMMIT'); expect(() => b.claim(bot, { ...p.claim, claim_key: 'competing' })).toThrow('Already claimed');
    expect(b.claim(bot, p.claim).execute).toBe(false);
    expect(right.prepare('SELECT count(*) n FROM routine_draft_claims').get()).toEqual({ n: 1 });
  } finally { if (left.inTransaction) left.exec('ROLLBACK'); left.close(); right.close(); rmSync(dir, { recursive: true }); }
});
it('native unresolved decisions cannot be concealed by a source none assertion',()=>{
 const c=capture();
 db.prepare("INSERT INTO bot_decisions(id,conversation_id,source_key,proposal_key,proposal_json,assignee_id) VALUES('hold','other','unscoped','hold','{}',1)").run();
 expect(s.nativeContext(identity,{trust_id:trustId,canonical_case:'case'})).toMatchObject({ready:false,blocking_count:1,execute:false});
 expect(()=>s.capture(identity,c)).toThrow('Native');
});
it('native hold arriving after bot reservation blocks service dispatch without consuming permission',()=>{
 const p=accepted();s.claim(bot,p.claim);
 db.prepare("INSERT INTO bot_decisions(id,conversation_id,source_key,proposal_key,proposal_json,assignee_id) VALUES('hold','other','case','hold','{}',1)").run();
 expect(()=>s.dispatchClaim(identity,{...p.claim,source_intent:'case-request1',scope_hash:p.proof.scope_hash,material_hash:p.proof.material_hash,request_key:'dispatch'})).toThrow('Native');
 expect(db.prepare('SELECT count(*) n FROM routine_dispatch_claims').get()).toEqual({n:0});
});
it('source dispatch is authenticated once; lost response never grants permission from replay/reconcile',()=>{
 const p=accepted();expect(s.claim(bot,p.claim).execute).toBe(false);
 const x={...p.claim,source_intent:'case-request1',scope_hash:p.proof.scope_hash,material_hash:p.proof.material_hash,request_key:'dispatch'};
 expect(()=>s.dispatchClaim({...identity,clientId:'foreign'},x)).toThrow('identity');
 expect(()=>s.dispatchClaim(identity,{...x,source_intent:'foreign'})).toThrow();
 expect(s.dispatchClaim(identity,x).execute).toBe(true);
 expect(s.dispatchClaim(identity,x).execute).toBe(false);
 expect(()=>s.dispatchClaim(identity,{...x,request_key:'retry'})).toThrow();
 expect(s.reconcile(identity,p.d.id)).toMatchObject({execute:false,claim:{claim_key:'claim1',proof_id:p.claimProof.proof_id},source_intent:'case-request1'});
 expect(()=>db.prepare("UPDATE routine_dispatch_claims SET request_key='retry'").run()).toThrow('immutable');
});
