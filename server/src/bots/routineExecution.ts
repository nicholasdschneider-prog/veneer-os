import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { BotError, createBotService, type Actor } from './service.js';
import { canonicalSha256 } from './canonical.js';
import type { UserRow } from '../db/db.js';
import type { Draft } from './communication.js';

const key = z.string().min(1).max(200);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const instant = z.string().datetime();
export type RoutineIdentity = { clientId: string; audience: string };
export const missingFields = ['model_number', 'product_label_photo', 'installation_photo'] as const;
export const missingQuestions = {
  model_number: 'What is the model number printed on the product label?',
  product_label_photo: 'Please reply with a clear photo of the product label.',
  installation_photo: 'Please reply with a clear photo of the installation area.',
} as const;
// No caller-authored subject/body, promises, financial language or attachments.
export function missingInformationBody(fields: readonly (typeof missingFields[number])[]) {
  return 'To help us understand your question, please provide the following information:\n\n' + fields.map(f => missingQuestions[f]).join('\n') + '\n\nThank you.';
}
export const routineTrustSchema = z.object({
  policy_id: key, executor_id: key, request_key: key, client_id: key, audience: key,
  account_id: key, principal_id: key, source_origin: z.string().url().refine(s => new URL(s).protocol === 'https:' && new URL(s).origin === s),
  registration_reference: z.string().min(1).max(2000), adapter_digest: hash,
  contract: z.literal('routine-missing-information/v1'),
}).strict();
type TrustInput = z.infer<typeof routineTrustSchema>;
type Trust = { id: string; policy_id: string; owner_id: number; snapshot_json: string; snapshot_hash: string };
type Policy = { id: string; business_id: string; policy_key: string; version: number; issuer_id: number; snapshot_hash: string; snapshot_json: string };
// Trusted adapter supplies authoritative complete capture, never a bot eligible=true.
// The adapter contract requires snapshot isolation / revision fencing and semantic
// checks across ALL channels before marking individual requested fields missing.
export const routineCaptureSchema = z.object({
  schema_version: z.literal('routine-missing-information/v1'), trust_id: key, request_key: key,
  captured_at: instant, adapter_digest: hash, account_id: key, principal_id: key,
  source_origin: z.string().url(), enrollment_revision: key, source_intent: key,
  lease: z.object({ case_id: key, principal_id: key, revision: key, expires_at: instant }).strict(),
  material: z.object({
    case_id: key, ticket: key, customer_id: key, sender_account: key, recipient: z.string().email(),
    retained_principal_id: key, revision: key,
    context: z.object({
      completeness: z.literal('all-channels-sisters-and-outbound/v1'),
      snapshot_revision: key, channels: z.array(key).min(1).max(20),
      conversation_ids: z.array(key).min(1).max(100),
      message_count: z.number().int().nonnegative().max(10000),
      messages_hash: hash, source_records_hash: hash,
      next_cursor: z.null(), truncation: z.literal('none'),
    }).strict(),
    human_directive: z.enum(['none', 'hold', 'reject', 'defer', 'withdraw']),
    prior_effect: z.enum(['none', 'sent', 'pending', 'unknown']),
    disposition: z.enum(['open_question', 'resolved', 'acknowledgment_only', 'no_contact']),
    requested_fields: z.array(z.enum(missingFields)).min(1).max(3),
    field_evidence: z.array(z.object({
      field: z.enum(missingFields), state: z.enum(['missing', 'present', 'uncertain']),
      relevance: z.enum(['needed_for_current_question', 'not_needed', 'uncertain']),
      evidence_revision: key,
    }).strict()).min(1).max(3),
    duplicate_scope_hashes: z.array(hash).max(1000),
  }).strict(),
}).strict();
type Capture = z.infer<typeof routineCaptureSchema>;
type Proof = { id: string; trust_id: string; capture_json: string; scope_json: string; scope_hash: string; material_hash: string };
type Authorization = { draft_id: string; proof_id: string; trust_id: string; actor_id: number; executor_id: string; request_key: string; expected_version: number; scope_hash: string; material_hash: string; source_intent: string };
export function routineExecutionService(db: Database.Database, options: { now?: () => number; identity?: RoutineIdentity | null } = {}) {
  const now = options.now ?? Date.now, bots = createBotService(db);
  const fail = (message: string): never => { throw new BotError(409, message); };
  function user(id: number) {
    const u = db.prepare("SELECT * FROM users WHERE id=? AND status='active'").get(id) as UserRow | undefined;
    if (!u) throw new BotError(403, 'Active native identity required');
    return u;
  }
  function policy(id: string) {
    const p = db.prepare('SELECT * FROM bot_routine_policies WHERE id=?').get(id) as Policy | undefined;
    if (!p) throw new BotError(404, 'Policy not found');
    user(p.issuer_id);
    if (!db.prepare('SELECT 1 FROM business_teams WHERE id=? AND owner_id=?').get(p.business_id, p.issuer_id) ||
      db.prepare('SELECT 1 FROM bot_routine_policy_revocations WHERE policy_id=?').get(id) ||
      db.prepare('SELECT 1 FROM bot_routine_policies WHERE business_id=? AND policy_key=? AND version>?').get(p.business_id, p.policy_key, p.version)) fail('Policy revoked, superseded or owner changed');
    return p;
  }
  function executor(p: Policy, id: string) {
    const c = bots.chat({ user: user(p.issuer_id) }, id);
    const snapshot = JSON.parse(p.snapshot_json) as { executor_ids: string[]; categories: string[] };
    if (c.archived || c.business_team_id !== p.business_id || !snapshot.executor_ids.includes(id) || !snapshot.categories.includes('missing_information') ||
      !db.prepare('SELECT 1 FROM bot_registrations WHERE conversation_id=? AND active=1').get(id)) fail('Named executor or category is no longer eligible');
    user(c.user_id);
    return c;
  }
  function owner(a: Actor, p: Policy) {
    user(a.user.id);
    if (a.conversationId || a.user.id !== p.issuer_id) throw new BotError(403, 'Current authenticated human business owner required');
  }
  function loadTrust(id: string, identity?: RoutineIdentity, current = true) {
    const r = db.prepare('SELECT * FROM routine_source_trust WHERE id=?').get(id) as Trust | undefined;
    if (!r) throw new BotError(404, 'Routine source trust not found');
    const t = routineTrustSchema.parse(JSON.parse(r.snapshot_json));
    if (identity && (identity.clientId !== t.client_id || identity.audience !== t.audience)) throw new BotError(403, 'Wrong routine service identity');
    if (current) {
      const p = policy(t.policy_id); executor(p, t.executor_id);
      if (p.issuer_id !== r.owner_id || db.prepare('SELECT 1 FROM routine_source_revocations WHERE trust_id=?').get(id)) fail('Routine source trust revoked');
    }
    return { r, t };
  }
  function own(a: Actor, t: TrustInput) {
    const c = executor(policy(t.policy_id), t.executor_id);
    user(a.user.id);
    if (a.conversationId !== t.executor_id || a.user.id !== c.user_id) throw new BotError(403, 'Only the active named owning executor may accept or claim');
    bots.chat({ ...a, user: user(a.user.id) }, c.id);
  }
  function getProof(id: string) {
    const p = db.prepare('SELECT * FROM routine_source_proofs WHERE id=?').get(id) as Proof | undefined;
    if (!p) throw new BotError(404, 'Routine source proof not found');
    return p;
  }
  function getDraft(id: string) {
    const d = db.prepare('SELECT * FROM bot_message_drafts WHERE id=?').get(id) as Draft | undefined;
    if (!d) throw new BotError(404, 'Draft not found');
    return d;
  }
  function auth(id: string) { return db.prepare('SELECT * FROM routine_draft_authorizations WHERE draft_id=?').get(id) as Authorization | undefined; }
  function validate(t: TrustInput, c: Capture) {
    const p = policy(t.policy_id), m = c.material;
    executor(p, t.executor_id);
    if (c.adapter_digest !== t.adapter_digest || c.account_id !== t.account_id || c.source_origin !== t.source_origin || c.principal_id !== t.principal_id ||
      m.retained_principal_id !== t.principal_id || c.lease.principal_id !== t.principal_id || c.lease.case_id !== m.case_id) fail('Source account, adapter, retained owner or lease binding mismatch');
    const age = now() - Date.parse(c.captured_at);
    if (age < -5000 || age > 15000 || Date.parse(c.lease.expires_at) < now() + 30000) fail('Source material or own lease is stale');
    if (m.human_directive !== 'none' || m.prior_effect !== 'none' || m.disposition !== 'open_question') fail('Human hold, prior effect or no-contact disposition blocks routine sending');
    if (!m.context.conversation_ids.includes(m.case_id) || new Set(m.context.conversation_ids).size !== m.context.conversation_ids.length || new Set(m.context.channels).size !== m.context.channels.length) fail('Complete case/channel context required');
    if (new Set(m.requested_fields).size !== m.requested_fields.length || m.field_evidence.length !== m.requested_fields.length || new Set(m.field_evidence.map(f => f.field)).size !== m.field_evidence.length ||
      m.requested_fields.some(f => !m.field_evidence.some(e => e.field === f && e.state === 'missing' && e.relevance === 'needed_for_current_question' && e.evidence_revision === m.context.snapshot_revision))) fail('Actually missing relevant information is not established');
    const fields = [...m.requested_fields].sort();
    const scope = { canonical_case: m.case_id, executor_conversation_id: t.executor_id, payload: {
      channel: 'email', account: m.sender_account, recipients: [m.recipient], subject: 'Information needed for your question',
      body: missingInformationBody(fields), attachments: [], customer: m.customer_id, ticket: m.ticket, context: '',
    } };
    const scopeHash = canonicalSha256({ policy_id: p.id, policy_hash: p.snapshot_hash, category: 'missing_information', scope });
    if (m.duplicate_scope_hashes.includes(scopeHash)) fail('This exact request was already sent or reserved');
    return { scope, scopeHash, materialHash: canonicalSha256(m), policy: p };
  }
  function proofView(p: Proof) { return { proof_id: p.id, trust_id: p.trust_id, scope: JSON.parse(p.scope_json), scope_hash: p.scope_hash, material_hash: p.material_hash, execute: false }; }
  return {
    authorization: auth,
    enroll(a: Actor, raw: unknown) {
      const t = routineTrustSchema.parse(raw);
      return db.transaction(() => {
        const p = policy(t.policy_id); owner(a, p); executor(p, t.executor_id);
        if (!options.identity || options.identity.clientId !== t.client_id || options.identity.audience !== t.audience) fail('Dedicated routine service transport must be configured before enrollment');
        const h = canonicalSha256(t), old = db.prepare('SELECT * FROM routine_source_trust WHERE owner_id=? AND request_key=?').get(a.user.id, t.request_key) as Trust | undefined;
        if (old) { if (old.snapshot_hash !== h) fail('Trust request key conflict'); return { trust_id: old.id }; }
        const id = crypto.randomUUID();
        db.prepare('INSERT INTO routine_source_trust(id,policy_id,owner_id,request_key,snapshot_json,snapshot_hash) VALUES(?,?,?,?,?,?)').run(id, p.id, a.user.id, t.request_key, JSON.stringify(t), h);
        return { trust_id: id };
      }).immediate();
    },
    revoke(a: Actor, id: string, reason: string) {
      return db.transaction(() => {
        const { r } = loadTrust(id, undefined, false);
        // Revocation remains possible even after policy supersession.
        user(a.user.id);
        if (a.conversationId || !db.prepare('SELECT 1 FROM bot_routine_policies p JOIN business_teams b ON b.id=p.business_id WHERE p.id=? AND b.owner_id=?').get(r.policy_id, a.user.id)) throw new BotError(403, 'Current human business owner required');
        reason = z.string().min(1).max(2000).parse(reason);
        const old = db.prepare('SELECT reason FROM routine_source_revocations WHERE trust_id=?').get(id) as { reason: string } | undefined;
        if (old && old.reason !== reason) fail('Revocation conflict');
        db.prepare('INSERT OR IGNORE INTO routine_source_revocations(trust_id,actor_id,reason) VALUES(?,?,?)').run(id, a.user.id, reason);
        return { revoked: true };
      }).immediate();
    },
    capture(identity: RoutineIdentity, raw: unknown) {
      const c = routineCaptureSchema.parse(raw);
      return db.transaction(() => {
        const { t } = loadTrust(c.trust_id, identity), v = validate(t, c), h = canonicalSha256(c);
        const old = db.prepare('SELECT * FROM routine_source_proofs WHERE trust_id=? AND request_key=?').get(c.trust_id, c.request_key) as (Proof & { capture_hash: string }) | undefined;
        if (old) { if (old.capture_hash !== h) fail('Capture key conflict'); return proofView(old); }
        const id = crypto.randomUUID();
        db.prepare('INSERT INTO routine_source_proofs(id,trust_id,request_key,capture_json,capture_hash,scope_json,scope_hash,material_hash) VALUES(?,?,?,?,?,?,?,?)').run(id, c.trust_id, c.request_key, JSON.stringify(c), h, JSON.stringify(v.scope), v.scopeHash, v.materialHash);
        return proofView(getProof(id));
      }).immediate();
    },
    inspect(a: Actor, id: string) {
      const p = getProof(id), { t } = loadTrust(p.trust_id); own(a, t);
      validate(t, routineCaptureSchema.parse(JSON.parse(p.capture_json)));
      return { ...proofView(p), ready: true, authorization_basis: 'standing_policy', policy_id: t.policy_id, category: 'missing_information' };
    },
    accept(a: Actor, raw: unknown) {
      const x = z.object({ proof_id: key, draft_id: key, expected_version: z.number().int().positive(), request_key: key }).strict().parse(raw);
      return db.transaction(() => {
        const p = getProof(x.proof_id), { t } = loadTrust(p.trust_id); own(a, t);
        const c = routineCaptureSchema.parse(JSON.parse(p.capture_json));
        const d = getDraft(x.draft_id), old = auth(d.id);
        if (old) {
          if (old.proof_id !== p.id || old.request_key !== x.request_key || old.expected_version !== x.expected_version || old.executor_id !== a.conversationId) fail('Authorization replay conflict');
          if (d.state !== 'queued' || d.claim_key) fail('Already claimed or retired; reconcile only');
          return { draft_id: d.id, version: d.version, execute: false, authorization_basis: 'standing_policy' };
        }
        validate(t, c);
        if (d.conversation_id !== t.executor_id || d.decision_id || d.delegation_id || d.authorized_by !== null || d.version !== x.expected_version || d.state !== 'draft' || d.claim_key !== null) fail('Only an exact own unapproved ordinary draft is eligible');
        if (canonicalSha256(JSON.parse(d.payload_json)) !== canonicalSha256(JSON.parse(p.scope_json).payload)) fail('Draft differs from the fixed verified template scope');
        if (db.prepare('SELECT 1 FROM routine_draft_authorizations WHERE (executor_id=? AND request_key=?) OR (trust_id=? AND source_intent=?) OR (trust_id=? AND scope_hash=? AND material_hash=?)').get(t.executor_id, x.request_key, p.trust_id, c.source_intent, p.trust_id, p.scope_hash, p.material_hash)) fail('Routine request or source intent already reserved');
        db.prepare('INSERT INTO routine_draft_authorizations(draft_id,proof_id,trust_id,actor_id,executor_id,request_key,expected_version,scope_hash,material_hash,source_intent) VALUES(?,?,?,?,?,?,?,?,?,?)').run(d.id, p.id, p.trust_id, a.user.id, t.executor_id, x.request_key, d.version, p.scope_hash, p.material_hash, c.source_intent);
        db.prepare("UPDATE bot_message_drafts SET state='queued',version=version+1,updated_at=datetime('now') WHERE id=?").run(d.id);
        return { draft_id: d.id, version: d.version + 1, execute: false, authorization_basis: 'standing_policy' };
      }).immediate();
    },
    claim(a: Actor, raw: unknown) {
      const x = z.object({ draft_id: key, proof_id: key, claim_key: key }).strict().parse(raw);
      return db.transaction(() => {
        const g = auth(x.draft_id); if (!g) fail('Standing-policy authorization required');
        const grant = g!, { t } = loadTrust(grant.trust_id); own(a, t);
        const d = getDraft(x.draft_id), previous = db.prepare('SELECT claim_key,proof_id FROM routine_draft_claims WHERE draft_id=?').get(d.id) as { claim_key: string; proof_id: string } | undefined;
        if (previous) {
          if (previous.claim_key !== x.claim_key || previous.proof_id !== x.proof_id) fail('Already claimed under another binding; no retry');
          return { execute: false, draft_id: d.id, state: d.state, idempotency_key: `veneer-message:${d.id}`, instruction: 'Read-only source reconciliation only. Never send again.' };
        }
        const p = getProof(x.proof_id), c = routineCaptureSchema.parse(JSON.parse(p.capture_json));
        validate(t, c);
        if (p.trust_id !== grant.trust_id || p.id === grant.proof_id || p.scope_hash !== grant.scope_hash || p.material_hash !== grant.material_hash || c.source_intent !== grant.source_intent) fail('Fresh same-material claim proof required; changed material requires new investigation');
        if (d.state !== 'queued' || d.claim_key !== null || d.version !== grant.expected_version + 1 || canonicalSha256(JSON.parse(d.payload_json)) !== canonicalSha256(JSON.parse(p.scope_json).payload)) fail('Draft changed, claimed or retired');
        db.prepare('INSERT INTO routine_draft_claims(draft_id,proof_id,claim_key,scope_hash) VALUES(?,?,?,?)').run(d.id, p.id, x.claim_key, p.scope_hash);
        db.prepare("UPDATE bot_message_drafts SET state='sending',claim_key=?,updated_at=datetime('now') WHERE id=? AND state='queued' AND claim_key IS NULL").run(x.claim_key, d.id);
        return { execute: true, draft_id: d.id, authorization_basis: 'standing_policy', scope: JSON.parse(p.scope_json), scope_hash: p.scope_hash, material_hash: p.material_hash, policy_id: t.policy_id, trust_id: p.trust_id, source_intent: c.source_intent, idempotency_key: `veneer-message:${d.id}`, instruction: 'Only the enrolled source dispatcher may send: atomically recheck current identity, policy, own lease, material, holds and duplicate/unknown effects immediately before provider dispatch. No direct legacy send fallback.' };
      }).immediate();
    },
    reconcile(identity: RoutineIdentity, id: string) {
      const g = auth(id); if (!g) throw new BotError(404, 'Routine authorization not found');
      loadTrust(g.trust_id, identity, false);
      const d = getDraft(id), receipt = db.prepare('SELECT receipt_json FROM routine_delivery_readbacks WHERE draft_id=?').get(id) as { receipt_json: string } | undefined;
      return { draft_id: id, state: d.state, execute: false, claimed: !!d.claim_key, receipt: receipt ? JSON.parse(receipt.receipt_json) : null };
    },
    readback(identity: RoutineIdentity, raw: unknown) {
      const x = z.object({ draft_id: key, claim_key: key, scope_hash: hash, material_hash: hash, account_id: key, principal_id: key,
        idempotency_key: key, source_intent: key, provider_message_id: key, verified_at: instant,
        state: z.literal('SENT'), sent_count: z.literal(1), payload_hash: hash,
      }).strict().parse(raw);
      return db.transaction(() => {
        const g = auth(x.draft_id); if (!g) fail('Routine authorization missing');
        const grant = g!, { t } = loadTrust(grant.trust_id, identity, false), d = getDraft(x.draft_id);
        const claim = db.prepare('SELECT proof_id,claim_key FROM routine_draft_claims WHERE draft_id=?').get(d.id) as { proof_id: string; claim_key: string } | undefined;
        const h = canonicalSha256(x), prior = db.prepare('SELECT receipt_hash FROM routine_delivery_readbacks WHERE draft_id=?').get(d.id) as { receipt_hash: string } | undefined;
        if (prior) { if (prior.receipt_hash !== h) fail('Delivery readback conflict'); return { state: 'sent', execute: false }; }
        const age = now() - Date.parse(x.verified_at);
        if (!claim || claim.claim_key !== x.claim_key || x.scope_hash !== grant.scope_hash || x.material_hash !== grant.material_hash || x.account_id !== t.account_id || x.principal_id !== t.principal_id || x.source_intent !== grant.source_intent || x.idempotency_key !== `veneer-message:${d.id}` || x.payload_hash !== canonicalSha256(JSON.parse(d.payload_json)) || age < -5000 || age > 30000) fail('Exact current provider readback does not match the claimed scope');
        if (!['sending', 'uncertain'].includes(d.state)) fail('Draft is not awaiting delivery reconciliation');
        if (db.prepare("SELECT 1 FROM routine_delivery_readbacks WHERE json_extract(receipt_json,'$.account_id')=? AND json_extract(receipt_json,'$.provider_message_id')=?").get(x.account_id,x.provider_message_id)) fail('Provider message already bound to another draft');
        db.prepare('INSERT INTO routine_delivery_readbacks(draft_id,receipt_json,receipt_hash) VALUES(?,?,?)').run(d.id, JSON.stringify(x), h);
        db.prepare("UPDATE bot_message_drafts SET state='sent',receipt=?,updated_at=datetime('now') WHERE id=?").run(`Verified source SENT ${x.provider_message_id}; standing policy, not a human per-case approval`, d.id);
        return { state: 'sent', execute: false };
      }).immediate();
    },
  };
}
