import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { migrate } from '../src/db/migrate.js';
import { createBotService, proposalSchema, type Actor } from '../src/bots/service.js';
import { canonicalSha256 } from '../src/bots/canonical.js';
import { contactVerification, type ContactIO } from '../src/bots/contactVerification.js';
import { contactVerificationRoutes, contactVerificationVerifierRoutes, loadContactRegistry } from '../src/bots/contactVerificationRoutes.js';
import type { AppContext } from '../src/context.js';
import { registrationSchema, manifestSchema, authoritySchema, associationResponse, reconcileResponse, exportResponse, receiptResponse, contactHash, evidenceMaterial, intentMaterial, intentDigest, CONTACT_CONTRACT_HASH, type Registration, type Manifest, type Evidence, type Authority, type Generation, type IntentEvidence } from '../src/bots/contactVerificationContract.js';
const uid = () => crypto.randomUUID(), H = 'a'.repeat(64), origin = 'https://source.example.test';
describe('paired contact verification', () => {
    let db: Database.Database, io: ContactIO, s: ReturnType<typeof contactVerification>, bots: ReturnType<typeof createBotService>, human: Actor, owner: Actor, now: number, reads: number;
    let regs: Map<string, Registration>, evidence: Map<string, Evidence>, intents: Map<string, IntentEvidence>, decisions: Map<string, string>, r: Registration, r2: Registration;
    const signEvidence = (e: Evidence) => { e.observedAt = new Date(now).toISOString(); e.expiresAt = new Date(now + 15000).toISOString(); e.evidenceHash = contactHash('contact-verification/evidence/v1', evidenceMaterial(e)); return e; };
    const signIntent = (e: IntentEvidence) => { e.observedAt = new Date(now).toISOString(); e.expiresAt = new Date(now + 15000).toISOString(); e.evidenceHash = contactHash('contact-verification/dispatch-evidence/v1', intentMaterial(e)); return e; };
    function makeReg(businessId: string, conversationId: string): Registration { return registrationSchema.parse({ schemaVersion: 'contact-verification-registration/v1', id: uid(), revision: 1, active: true, businessId, ownerUserId: 1, accountId: 'fixture-source', sourceOrigin: origin, runtime: { projectId: uid(), environmentId: uid(), serviceId: uid() }, target: { caseId: uid(), orderId: uid(), caseCustomerId: uid(), orderCustomerId: uid() }, executor: { conversationId, userId: 1, principalId: 'fixture:nora', enrollmentId: uid(), enrollmentRevision: 1, identityEvidenceHash: H }, ownerConversationId: conversationId, servicePrincipalId: 'fixture:contact-service', audience: 'contact-only', cfClientId: 'contact-only-client', bearerHash: crypto.createHash('sha256').update('fixture-dedicated-bearer-'.repeat(2)).digest('hex'), readerCredential: { project: 'fixture', config: 'test', name: 'CONTACT_VERIFICATION_READER' }, custodyReceiptHash: H, sourceAcceptanceHash: H, rendererAcceptanceHash: H, redemptionAcceptanceHash: H, contractHash: CONTACT_CONTRACT_HASH, expiresAt: new Date(now + 86400000).toISOString(), credentialExpiresAt: new Date(now + 86400000).toISOString(), channels: [{ channel: 'email', accountId: 'email-fixture', from: 'support@example.test', recipient: 'one@example.test', origin, path: '/verify' }, { channel: 'sms', accountId: 'sms-fixture', from: '+15550000001', recipient: '+15550000002', origin, path: '/verify' }] }); }
    function makeEvidence(r: Registration): Evidence {
        const channels = r.channels.map(c => { const base = { channel: c.channel, accountId: c.accountId, from: c.from, recipient: c.recipient, subject: c.channel === 'email' ? 'Verify this exact order' : '', segments: [] as unknown[], slot: { slotId: uid(), kind: 'source_generated_single_use_link', channel: c.channel, entropyBits: 256, encoding: 'base64url', origin: c.origin, path: c.path, placement: 'fragment', fragmentEncoding: 'generation-channel-secret/v1', generationBinding: 'authority_generation_channel_intent' }, attachments: [], renderingVersion: 'contact-template-utf8/v1' }; base.segments = [{ kind: 'literal', text: 'Please verify whether you purchased this exact order: ' }, { kind: 'slot', slotId: base.slot.slotId }]; return { ...base, templateHash: contactHash('contact-verification/template/v1', base) }; });
        const base = { schemaVersion: 'paired-contact-manifest/v1', manifestId: uid(), manifestRevision:1, registrationId: r.id, registrationRevision: 1, businessId: r.businessId, accountId: r.accountId, sourceOrigin: origin, runtime: r.runtime, target: { ...r.target, caseRevision: '2026-09-30 00:00:00.123456', orderRevision: 'order-v1', caseCustomerRevision: 'customer-a-v1', orderCustomerRevision: 'customer-b-v1', contactRevision: canonicalSha256(r.target.caseCustomerId), materialRevision: canonicalSha256(r.target) }, executor: r.executor, statement: 'I am the purchaser of this exact order.', statementHash: contactHash('contact-verification/statement/v1', 'I am the purchaser of this exact order.'), channels };
        const manifest = manifestSchema.parse({ ...base, manifestHash: contactHash('contact-verification/manifest/v1', base) });
        return signEvidence({ schemaVersion: 'paired-contact-evidence/v1', registrationId: r.id, registrationHash: canonicalSha256(r), servicePrincipalId: r.servicePrincipalId, manifest, sourceRevision: canonicalSha256(r.id), coverage: { complete: true, omissions: [] }, blockers: [], observedAt: '', expiresAt: '', evidenceHash: '' });
    }
    function approve(reg: Registration) { const d = bots.raise(owner, { source_key: reg.target.caseId, proposal_key: uid(), proposal: proposalSchema.parse({ question: 'Send this exact verification pair?', recommendation: 'Only the two fixed public templates with independent source secret slots.', consequence: 'Contact control is not financial or identity clearance.', assignee_id: 1, blocked_action: 'Two exact approved contacts only.', contact_verification: evidence.get(reg.id)!.manifest }) }); bots.answer(human, d.id, 1, uid(), { action: 'approve', text: 'Approve these two exact templates and their fixed source-only slots.', scope: 'this_case' }); decisions.set(reg.id, d.id); return d.id; }
    const input = (reg = r) => ({ registrationId: reg.id, decisionId: decisions.get(reg.id)!, expectedVersion: 1 });
    async function enroll(reg = r) { const p = await s.prepareEnrollment(human, reg.id); return s.enroll(human, reg.id, p.enrollmentHash); }
    async function issue(reg = r) { await enroll(reg); if (!decisions.has(reg.id))
        approve(reg); const v = await s.inspect(owner, input(reg)); return authoritySchema.parse((await s.issue(owner, { ...input(reg), inspectionHash: v.inspectionHash, requestKey: uid(), expiresAt: new Date(now + 600000).toISOString() })).authority); }
    function prepare(a: Authority) {
        const g = { schemaVersion: 'paired-contact-generation/v1', generationId: uid(), authorityId: a.authorityId, authorityHash: a.authorityHash, registrationId: a.registrationId, registrationHash: a.registrationHash, businessId: a.manifest.businessId, manifestHash: a.manifestHash, sourceRevision: a.sourceRevision, materialRevision: a.manifest.target.materialRevision, executorPrincipalId: a.manifest.executor.principalId, preparedEventId: uid(), preparedAt: new Date(now).toISOString(), expiresAt: a.expiresAt, intents: a.manifest.channels.map(c => ({ intentId: uid(), channel: c.channel, requestKey: uid(), templateHash: c.templateHash, slotCommitment: canonicalSha256(uid()), wirePayloadHash: canonicalSha256(uid()), providerIdempotencyKey: uid(), intentHash: '' })), generationHash: '' } as Generation;
        g.intents.forEach(i => i.intentHash = intentDigest(g, i));
        const { generationHash, ...tuple } = g;
        g.generationHash = contactHash('contact-verification/generation/v1', tuple);
        for (const i of g.intents)
            intents.set(i.intentId, signIntent({ schemaVersion: 'contact-dispatch-evidence/v1', registrationId: a.registrationId, registrationHash: a.registrationHash, servicePrincipalId: regs.get(a.registrationId)!.servicePrincipalId, generation: structuredClone(g), intentId: i.intentId, state: 'REDEEMING', redeemingEventId: uid(), redeemingAt: new Date(now).toISOString(), sendingEventId: null, sendingAt: null, pairBlock:null, associationId: null, outcome: null, observedAt: '', expiresAt: '', evidenceHash: '' }));
        return g.intents.map(i => ({ schemaVersion: 'contact-dispatch-association/v1' as const, authorityId: a.authorityId, authorityHash: a.authorityHash, registrationId: a.registrationId, registrationRevision: a.registrationRevision, generationId: g.generationId, ...i, sourceRevision: g.sourceRevision, materialRevision: g.materialRevision }));
    }
    function outcome(id: string, associationId: string | null, state: 'SENT_ACCEPTED' | 'UNKNOWN' | 'ROLLED_BACK_TERMINAL') { const e = intents.get(id)!, i = e.generation.intents.find(x => x.intentId === id)!; e.state = state; e.associationId = associationId; if(state!=='SENT_ACCEPTED'&&!e.pairBlock)e.pairBlock={eventId:uid(),at:new Date(now).toISOString(),reason:state,intentId:id}; for(const sibling of intents.values())if(sibling.generation.generationId===e.generation.generationId){sibling.pairBlock=structuredClone(e.pairBlock);signIntent(sibling);} if (state === 'SENT_ACCEPTED') {
        e.sendingEventId = uid();
        e.sendingAt = new Date(now).toISOString();
    } const o = { schemaVersion: 'contact-dispatch-outcome/v1' as const, state, associationId, providerId: state === 'SENT_ACCEPTED' ? 'fixture-provider-accepted' : null, providerAccountId: e.generation.intents[0].intentId === id ? 'email-fixture' : 'sms-fixture', providerIdempotencyKey: i.providerIdempotencyKey, wirePayloadHash: i.wirePayloadHash, auditEventId: uid(), recordedAt: new Date(now).toISOString(), noRetry: true as const }; e.outcome = { ...o, outcomeHash: contactHash('contact-verification/outcome/v1', o) }; signIntent(e); }
    beforeEach(() => { now = Date.now(); reads = 0; db = new Database(':memory:'); db.pragma('foreign_keys=ON'); migrate(db, fileURLToPath(new URL('../src/db/migrations', import.meta.url))); const business = uid(), nora = uid(); db.prepare("INSERT INTO users(id,email,display_name,role,status) VALUES(1,'owner@fixture.test','Owner','owner','active'),(2,'other@fixture.test','Other','owner','active')").run(); db.prepare("INSERT INTO business_teams(id,name,owner_id) VALUES(?,'Fixture',1)").run(business); db.prepare("INSERT INTO conversations(id,assistant_id,user_id,title,provider,native_session_id,visibility,business_team_id) VALUES(?,1,1,'Nora','claude',?,'team',?)").run(nora, nora, business); db.prepare('INSERT INTO bot_registrations(conversation_id,name,active,registered_by) VALUES(?,?,1,1)').run(nora, 'Nora'); human = { user: db.prepare('SELECT * FROM users WHERE id=1').get() as Actor['user'] }; owner = { ...human, conversationId: nora }; bots = createBotService(db); r = makeReg(business, nora); r2 = makeReg(business, nora); r2.runtime = structuredClone(r.runtime); regs = new Map([[r.id, r], [r2.id, r2]]); evidence = new Map([[r.id, makeEvidence(r)], [r2.id, makeEvidence(r2)]]); intents = new Map(); decisions = new Map(); io = { registration: id => structuredClone(regs.get(id)!), now: () => now, evidence: async (reg) => { reads++; return structuredClone(evidence.get(reg.id)); }, intent: async (_reg, id) => { reads++; return structuredClone(intents.get(id)); } }; s = contactVerification(db, io); });
    afterEach(() => db.close());
    it('requires actual human setup and exact approval; never imports an ordinary draft', async () => { await expect(s.prepareEnrollment(owner, r.id)).rejects.toThrow('human'); await expect(s.inspect(owner, { registrationId: r.id, decisionId: uid(), expectedVersion: 1 })).rejects.toThrow('UNAVAILABLE'); await enroll(); const d = bots.raise(owner, { source_key: 'unstructured', proposal_key: 'x', proposal: proposalSchema.parse({ question: 'Verify contact?', recommendation: 'Email and SMS', consequence: 'No finance', assignee_id: 1, blocked_action: 'wait' }) }); bots.answer(human, d.id, 1, uid(), { action: 'approve', text: 'Yes', scope: 'this_case' }); await expect(s.inspect(owner, { registrationId: r.id, decisionId: d.id, expectedVersion: 1 })).rejects.toThrow('PAIRED_PUBLIC_TEMPLATE'); });
    it('issues exact immutable public pair with no actual token, draft mutation or execution', async () => { const a = await issue(); expect(a.manifest.channels.map(c => c.channel)).toEqual(['email', 'sms']); expect(a.manifest.target).toEqual(evidence.get(r.id)!.manifest.target); expect((await s.verify(r.id, a.authorityId)).dispatchEntitlement).toBe(false); expect(exportResponse.parse(await s.verify(r.id, a.authorityId)).execute).toBe(false); expect(db.prepare('SELECT count(*) n FROM bot_message_drafts').get()).toEqual({ n: 0 }); expect(() => db.prepare('DELETE FROM contact_verification_authorities').run()).toThrow('Immutable'); const { authorityHash, ...tuple } = a; expect(authorityHash).toBe(contactHash('contact-verification/authority/v1', tuple)); });
    it('associates each exact channel once and requires first authenticated receipt before sibling', async () => { const a = await issue(), p = prepare(a); const first = associationResponse.parse(await s.associate(r.id, p[0])); expect(first.dispatchEntitlement).toBe(true); expect(first.execute).toBe(false); await expect(s.associate(r.id, p[1])).rejects.toThrow('SIBLING_UNRESOLVED'); expect(reconcileResponse.parse(await s.associate(r.id, p[0])).dispatchEntitlement).toBe(false); outcome(p[0]!.intentId, first.association.id, 'SENT_ACCEPTED'); expect(receiptResponse.parse(await s.receipt(r.id, first.association.id)).outcome.state).toBe('SENT_ACCEPTED'); expect((await s.associate(r.id, p[1])).dispatchEntitlement).toBe(true); expect(db.prepare('SELECT count(*) n FROM contact_verification_associations').get()).toEqual({ n: 2 }); });
    it('serializes identical competing associations and competing channels', async () => { const a = await issue(), p = prepare(a); const results = await Promise.all([s.associate(r.id, p[0]), s.associate(r.id, p[0])]); expect(results.filter(x => x.dispatchEntitlement)).toHaveLength(1); await expect(s.associate(r.id, p[1])).rejects.toThrow('SIBLING_UNRESOLVED'); expect(db.prepare('SELECT count(*) n FROM contact_verification_associations').get()).toEqual({ n: 1 }); });
    it('reconciles lost response UNKNOWN with null IDs; no replacement generation, key or sibling', async () => { const a = await issue(), p = prepare(a), first = await s.associate(r.id, p[0]); outcome(p[0]!.intentId, null, 'UNKNOWN'); expect((await s.receipt(r.id, first.association.id)).outcome.associationId).toBeNull(); expect(s.reconcile(r.id, first.association.id).dispatchEntitlement).toBe(false); await expect(s.associate(r.id, { ...p[0], requestKey: uid() })).rejects.toThrow('CHANNEL_ALREADY_RESERVED'); await expect(s.associate(r.id, p[1])).rejects.toThrow('PAIR_PERMANENTLY_BLOCKED'); const other = prepare(a); await expect(s.associate(r.id, other[1])).rejects.toThrow('PERMANENT_PAIR_BLOCK_CHANGED'); });
    it('terminal rollback remains permanent; receipt-only reconciliation never sends or frees sibling', async () => { const a = await issue(), p = prepare(a), first = await s.associate(r.id, p[0]); outcome(p[0]!.intentId, first.association.id, 'ROLLED_BACK_TERMINAL'); await s.receipt(r.id, first.association.id); await expect(s.associate(r.id, p[1])).rejects.toThrow('PAIR_PERMANENTLY_BLOCKED'); expect((await s.associate(r.id, p[0])).dispatchEntitlement).toBe(false); outcome(p[0]!.intentId, first.association.id, 'SENT_ACCEPTED'); await expect(s.receipt(r.id, first.association.id)).rejects.toThrow('TERMINAL_OUTCOME_CONFLICT'); });
    it('serializes revoke before association and retains association before revoke', async () => { const a = await issue(), p = prepare(a); s.revoke(owner, a.authorityId, 'stop'); await expect(s.associate(r.id, p[0])).rejects.toThrow('REVOKED'); const b = await issue(r2), q = prepare(b), first = await s.associate(r2.id, q[0]); s.revoke(owner, b.authorityId, 'stop sibling'); expect(s.reconcile(r2.id, first.association.id).dispatchEntitlement).toBe(false); await expect(s.associate(r2.id, q[1])).rejects.toThrow('REVOKED'); outcome(q[0]!.intentId, first.association.id, 'SENT_ACCEPTED'); expect((await s.receipt(r2.id, first.association.id)).outcome.state).toBe('SENT_ACCEPTED'); });
    it.each(['registrationId', 'authorityId', 'authorityHash', 'generationId', 'intentId', 'channel', 'templateHash', 'slotCommitment', 'wirePayloadHash', 'sourceRevision', 'materialRevision', 'providerIdempotencyKey', 'requestKey'] as const)('rejects %s substitution between TWO registered targets under the same executor', async (field) => { const a = await issue(), b = await issue(r2), p = prepare(a), q = prepare(b); const other = field === 'channel' ? q[1]! : q[0]!; await expect(s.associate(r.id, { ...p[0], [field]: other[field] })).rejects.toThrow(); expect(db.prepare('SELECT count(*) n FROM contact_verification_associations').get()).toEqual({ n: 0 }); });
    it('rejects cross-target source envelope/receipt swaps even with same service and executor', async () => { const a = await issue(), b = await issue(r2), p = prepare(a), q = prepare(b); const first = await s.associate(r.id, p[0]), second = await s.associate(r2.id, q[0]); outcome(p[0]!.intentId, first.association.id, 'SENT_ACCEPTED'); outcome(q[0]!.intentId, second.association.id, 'SENT_ACCEPTED'); const foreign = structuredClone(intents.get(q[0]!.intentId)!); intents.set(p[0]!.intentId, foreign); await expect(s.receipt(r.id, first.association.id)).rejects.toThrow(); expect(() => s.reconcile(r2.id, first.association.id)).toThrow('not found'); });
    it.each(['recipient', 'accountId', 'from', 'statement', 'executor', 'material'] as const)('rejects approved/source %s drift', async (field) => { const a = await issue(); const e = evidence.get(r.id)!; if (field === 'statement')
        e.manifest.statement += ' changed';
    else if (field === 'executor')
        e.manifest.executor.principalId = 'foreign';
    else if (field === 'material')
        e.manifest.target.materialRevision = 'b'.repeat(64);
    else
        e.manifest.channels[0][field] += 'changed'; signEvidence(e); await expect(s.verify(r.id, a.authorityId)).rejects.toThrow(); });
    it.each(['author', 'owner', 'executor', 'registration', 'credentialExpiry', 'authorityExpiry', 'decisionVersion', 'proposal', 'context'] as const)('denies %s revocation or drift', async (field) => { const a = await issue(); if (field === 'author' || field === 'owner')
        db.prepare("UPDATE users SET status='disabled' WHERE id=1").run(); if (field === 'executor')
        db.prepare('UPDATE bot_registrations SET active=0').run(); if (field === 'registration')
        r.active = false; if (field === 'credentialExpiry')
        r.credentialExpiresAt = new Date(now).toISOString(); if (field === 'authorityExpiry')
        now += 600000; if (field === 'decisionVersion')
        db.prepare('UPDATE bot_decisions SET version=2').run(); if (field === 'proposal')
        db.prepare("UPDATE bot_decisions SET proposal_json='{}'").run(); if (field === 'context')
        db.prepare('UPDATE bot_decisions SET handling_revision=handling_revision+1').run(); await expect(s.verify(r.id, a.authorityId)).rejects.toThrow(); });
    it('fails closed for unknown target fields and incomplete source coverage', async () => { const e = evidence.get(r.id)!; (e.manifest.target as unknown as {
        orderCustomerId: null;
    }).orderCustomerId = null; await expect(enroll()).rejects.toThrow('CONTRACT_INVALID'); evidence.set(r.id, makeEvidence(r)); await enroll(); approve(r); evidence.get(r.id)!.coverage.complete = false; signEvidence(evidence.get(r.id)!); await expect(s.inspect(owner, input())).rejects.toThrow('INCOMPLETE'); });
    it('requires both intent hashes and independent secret commitments, durable prepare ordering and original expiry', async () => { const a = await issue(), p = prepare(a), e = intents.get(p[0]!.intentId)!; e.generation.intents[1].slotCommitment = e.generation.intents[0].slotCommitment; e.generation.intents.forEach(i => i.intentHash = intentDigest(e.generation, i)); const { generationHash, ...g } = e.generation; e.generation.generationHash = contactHash('contact-verification/generation/v1', g); signIntent(e); await expect(s.associate(r.id, { ...p[0], intentHash: e.generation.intents[0].intentHash })).rejects.toThrow('CONTRACT_INVALID'); });
    it('rechecks approval after evidence fetch and before commit', async () => { await enroll(); approve(r); const original = io.evidence; io.evidence = async (reg) => { const e = await original(reg); db.prepare('UPDATE bot_decisions SET handling_revision=handling_revision+1').run(); return e; }; await expect(s.inspect(owner, input())).rejects.toThrow('DRIFT'); });
    it('same-key concurrent issuance reconciles once; new decision or registration cannot escape target fence', async () => { await enroll(); approve(r); const x = await s.inspect(owner, input()), p = { ...input(), inspectionHash: x.inspectionHash, requestKey: uid(), expiresAt: new Date(now + 600000).toISOString() }; const out = await Promise.all([s.issue(owner, p), s.issue(owner, p)]); expect(out[0].authority.authorityId).toBe(out[1].authority.authorityId); await expect(s.issue(owner, { ...p, requestKey: uid() })).rejects.toThrow('TARGET_ALREADY_RESERVED'); });
    it('rejects an unbound bot-written wire hash even if request shape is valid', async () => { const a = await issue(), p = prepare(a); await expect(s.associate(r.id, { ...p[0], wirePayloadHash: 'b'.repeat(64) })).rejects.toThrow('EXACT_PREPARED'); });
    it('denies expired first evidence after slow intent fetch without reserving', async () => { const a = await issue(), p = prepare(a), old = io.intent; io.intent = async (reg, id) => { now += 15001; signIntent(intents.get(id)!); return old(reg, id); }; await expect(s.associate(r.id, p[0])).rejects.toThrow('EXPIRED'); expect(db.prepare('SELECT count(*) n FROM contact_verification_associations').get()).toEqual({ n: 0 }); });
    it('blocks real source material drift even when all source hashes are recomputed', async () => { const a = await issue(), e = evidence.get(r.id)!; e.manifest.target.materialRevision = 'b'.repeat(64); const { manifestHash, ...body } = e.manifest; e.manifest.manifestHash = contactHash('contact-verification/manifest/v1', body); signEvidence(e); await expect(s.verify(r.id, a.authorityId)).rejects.toThrow('SOURCE_MATERIAL_CHANGED'); });
    it('requires persisted SENDING before acceptance and preserves its evidence on reconciliation', async () => { const a = await issue(), p = prepare(a), first = await s.associate(r.id, p[0]); outcome(p[0]!.intentId, first.association.id, 'SENT_ACCEPTED'); const e = intents.get(p[0]!.intentId)!; e.sendingEventId = null; e.sendingAt = null; signIntent(e); await expect(s.receipt(r.id, first.association.id)).rejects.toThrow('CONTRACT_INVALID'); e.sendingEventId = uid(); e.sendingAt = new Date(now).toISOString(); signIntent(e); await s.receipt(r.id, first.association.id); e.sendingEventId = uid(); signIntent(e); await expect(s.receipt(r.id, first.association.id)).rejects.toThrow('SENDING_FENCE_CHANGED'); });
    it('UNKNOWN can reconcile to one accepted receipt, but never renews entitlement', async () => { const a = await issue(), p = prepare(a), first = await s.associate(r.id, p[0]); outcome(p[0]!.intentId, null, 'UNKNOWN'); await s.receipt(r.id, first.association.id); outcome(p[0]!.intentId, first.association.id, 'SENT_ACCEPTED'); await s.receipt(r.id, first.association.id); await s.receipt(r.id, first.association.id); expect(db.prepare('SELECT count(*) n FROM contact_verification_receipts').get()).toEqual({ n: 2 }); expect((await s.associate(r.id, p[0])).dispatchEntitlement).toBe(false); await expect(s.associate(r.id, p[1])).rejects.toThrow('PAIR_PERMANENTLY_BLOCKED'); });
    it('permanent provider/intent keys cannot be copied into another registered target', async () => { const a = await issue(), b = await issue(r2), p = prepare(a), q = prepare(b); await s.associate(r.id, p[0]); const e = intents.get(q[0]!.intentId)!, g = e.generation; g.intents[0].providerIdempotencyKey = p[0]!.providerIdempotencyKey; g.intents[0].intentHash = intentDigest(g, g.intents[0]); const { generationHash, ...body } = g; g.generationHash = contactHash('contact-verification/generation/v1', body); signIntent(e); await expect(s.associate(r2.id, { ...q[0], providerIdempotencyKey: g.intents[0].providerIdempotencyKey, intentHash: g.intents[0].intentHash })).rejects.toThrow('PERMANENT_INTENT_KEY_CONFLICT'); });
    it('replacement registration and new decision preserve the original target fence', async () => { await issue(); const next = structuredClone(r); next.id = uid(); regs.set(next.id, next); evidence.set(next.id, makeEvidence(next)); await expect(issue(next)).rejects.toThrow('TARGET_ALREADY_RESERVED'); });
    it('source preparation is original-owner-only, complete, nonauthorizing and secret-free', async () => { await enroll(); const before = reads; await expect(s.prepare({ ...owner, conversationId: uid() }, r.id)).rejects.toThrow('Original'); expect(reads).toBe(before); const p = await s.prepare(owner, r.id); expect(p.ready).toBe(false); expect(p.execute).toBe(false); expect(p.manifest).toEqual(evidence.get(r.id)!.manifest); expect(db.prepare('SELECT count(*) n FROM contact_verification_authorities').get()).toEqual({ n: 0 }); });
    it('rejects source expiry extension, foreign service and non-REDEEMING preparation', async () => { const a = await issue(), p = prepare(a), e = intents.get(p[0]!.intentId)!; e.servicePrincipalId = 'foreign'; signIntent(e); await expect(s.associate(r.id, p[0])).rejects.toThrow('IDENTITY'); e.servicePrincipalId = r.servicePrincipalId; e.state = 'SENDING'; e.sendingEventId = uid(); e.sendingAt = new Date(now).toISOString(); signIntent(e); await expect(s.associate(r.id, p[0])).rejects.toThrow('CONTRACT_INVALID'); });
    it('exposes supported proposal/tool schema without a bot association or enrollment tool', async () => { const { BOT_TOOL_DEFINITIONS, callBotTool } = await import('../src/mcp/botTools.js'); const raise = BOT_TOOL_DEFINITIONS.find(x => x.name === 'raise_decision')!; expect(JSON.stringify(raise.inputSchema)).toContain('paired-contact-manifest/v1'); expect(BOT_TOOL_DEFINITIONS.some(x => x.name === 'associate_contact_verification')).toBe(false); const calls: unknown[] = []; await callBotTool({ name: 'prepare_contact_verification', args: { registrationId: r.id }, callApi: async (...args: unknown[]) => { calls.push(args); return { execute: false }; } } as Parameters<typeof callBotTool>[0]); expect(JSON.stringify(calls)).toContain('/api/bots/contact-verification/prepare'); });
    it('blocks post-approval human decision discussion before issuance without interpreting its words', async () => {
        await enroll(); approve(r);
        bots.reply(human, decisions.get(r.id)!, uid(), 'Hold this outreach.', 1);
        await expect(s.inspect(owner, input())).rejects.toThrow('POST_APPROVAL_HUMAN_CONTEXT');
        expect(db.prepare('SELECT count(*) n FROM contact_verification_authorities').get()).toEqual({n:0});
    });
    it('denies SMS-first even when neither channel has a native association', async () => {
        const a=await issue(),p=prepare(a); await expect(s.associate(r.id,p[1])).rejects.toThrow('EMAIL_FIRST');
        expect(db.prepare('SELECT count(*) n FROM contact_verification_generations').get()).toEqual({n:0});
    });
    it('recovers a lost association ID only by the full original immutable request; absence never grants retry', async () => {
        const a=await issue(),b=await issue(r2),p=prepare(a),before=reads;
        expect(s.lookup(r.id,p[0])).toEqual({execute:false,dispatchEntitlement:false,retryAllowed:false,association:null});expect(reads).toBe(before);
        const first=await s.associate(r.id,p[0]);expect(s.lookup(r.id,p[0]).association.id).toBe(first.association.id);
        expect(()=>s.lookup(r.id,{...p[0],requestKey:uid()})).toThrow('EXACT_ORIGINAL');
        expect(()=>s.lookup(r2.id,p[0])).toThrow('EXACT_ORIGINAL'); const q=prepare(b);expect(()=>s.lookup(r2.id,{...q[0],providerIdempotencyKey:p[0]!.providerIdempotencyKey})).toThrow('LOOKUP_CONFLICT');
        now=Date.parse(a.expiresAt);expect(s.lookup(r.id,p[0]).dispatchEntitlement).toBe(false);
    });
    it('retains source pair block even if native first observes an already reconciled acceptance', async () => {
        const a=await issue(),p=prepare(a),first=await s.associate(r.id,p[0]);
        outcome(p[0]!.intentId,null,'UNKNOWN');outcome(p[0]!.intentId,first.association.id,'SENT_ACCEPTED');
        await s.receipt(r.id,first.association.id);await expect(s.associate(r.id,p[1])).rejects.toThrow('PAIR_PERMANENTLY_BLOCKED');
    });
    it('rejects removal of an authenticated immutable pair block during receipt reconciliation', async () => {
        const a=await issue(),p=prepare(a),first=await s.associate(r.id,p[0]);outcome(p[0]!.intentId,null,'UNKNOWN');await s.receipt(r.id,first.association.id);
        outcome(p[0]!.intentId,first.association.id,'SENT_ACCEPTED');const e=intents.get(p[0]!.intentId)!;e.pairBlock=null;signIntent(e);
        await expect(s.receipt(r.id,first.association.id)).rejects.toThrow('PERMANENT_PAIR_BLOCK_CHANGED');
    });
    it('persists a pair block observed before any native reservation and never releases the authority', async()=>{
        const a=await issue(),p=prepare(a);outcome(p[0]!.intentId,null,'UNKNOWN');
        await expect(s.associate(r.id,p[1])).rejects.toThrow('PAIR_PERMANENTLY_BLOCKED');
        expect(db.prepare('SELECT count(*) n FROM contact_verification_pair_blocks').get()).toEqual({n:1});
        expect(db.prepare('SELECT count(*) n FROM contact_verification_associations').get()).toEqual({n:0});
        const q=prepare(a);await expect(s.associate(r.id,q[0])).rejects.toThrow('PERMANENT_PAIR_BLOCK_CHANGED');
        expect(()=>db.prepare('DELETE FROM contact_verification_pair_blocks').run()).toThrow('Immutable');
    });
    it('serializes first association across two actual SQLite connections', async () => {
        const a = await issue(), p = prepare(a), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paired-concurrency-')), file = path.join(dir, 'db.sqlite');
        await db.backup(file);
        const left = new Database(file), right = new Database(file);
        try {
            const l = contactVerification(left, io), rService = contactVerification(right, io);
            const values = await Promise.all([l.associate(r.id, p[0]), rService.associate(r.id, p[0])]);
            expect(values.filter(v => v.dispatchEntitlement)).toHaveLength(1);
            expect(left.prepare('SELECT count(*) n FROM contact_verification_associations').get()).toEqual({n:1});
        } finally { left.close(); right.close(); fs.rmSync(dir, {recursive:true,force:true}); }
    });
    it('protects registry file and rejects malformed secret-bearing DTOs', () => { expect(() => loadContactRegistry(undefined)).toThrow('UNAVAILABLE'); const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'contact-reg-')); try {
        const file = path.join(dir, 'r.json');
        fs.writeFileSync(file, JSON.stringify({ schemaVersion: 'contact-verification-registry/v1', registrations: [r] }), { mode: 0o600 });
        expect(loadContactRegistry(file).registrations[0]!.id).toBe(r.id);
        fs.chmodSync(file, 0o644);
        expect(() => loadContactRegistry(file)).toThrow();
        fs.chmodSync(file, 0o600);
        fs.symlinkSync(file, path.join(dir, 'link'));
        expect(() => loadContactRegistry(path.join(dir, 'link'))).toThrow();
    }
    finally {
        fs.rmSync(dir, { recursive: true, force: true });
    } expect(() => manifestSchema.parse({ ...evidence.get(r.id)!.manifest, secret: 'forbidden' })).toThrow(); });
    it('serves strict authenticated export/association/lost-ID lookup and rejects bot-supplied receipts over HTTP', async()=>{
        const a=await issue(),p=prepare(a),app=express();app.use('/service',contactVerificationVerifierRoutes({db,config:{cfAud:'human'}} as AppContext,{io,cf:async()=>true}));
        const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));
        const base=`http://127.0.0.1:${(server.address() as {port:number}).port}/service`,headers={'content-type':'application/json','x-contact-registration-id':r.id,authorization:'Bearer fixture-dedicated-bearer-fixture-dedicated-bearer-'};
        try{
            expect(exportResponse.parse(await (await fetch(base+'/authorities/'+a.authorityId,{headers})).json()).dispatchEntitlement).toBe(false);
            const first=associationResponse.parse(await (await fetch(base+'/dispatch-associations',{method:'POST',headers,body:JSON.stringify(p[0])})).json());expect(first.dispatchEntitlement).toBe(true);
            const found=await fetch(base+'/dispatch-associations/lookup',{method:'POST',headers,body:JSON.stringify(p[0])});expect(await found.json()).toEqual({execute:false,dispatchEntitlement:false,retryAllowed:false,association:first.association});
            const bad=await fetch(base+'/dispatch-associations/lookup',{method:'POST',headers,body:JSON.stringify({...p[0],requestKey:uid()})});expect(bad.status).toBe(409);
            expect((await fetch(base+'/receipts/'+first.association.id,{method:'POST',headers,body:JSON.stringify({providerId:'bot-asserted'})})).status).toBe(400);
        }finally{await new Promise<void>(r=>server.close(()=>r()));}
    });
    it('HTTP service never accepts a bot/human bearer and absent setup never fetches evidence', async () => { const app = express(); app.use('/service', contactVerificationVerifierRoutes({ db, config: { cfAud: 'human' } } as AppContext, { io, cf: async () => false })); app.use((q, _res, n) => { q.user = human.user; q.agentConversationId = owner.conversationId; n(); }); app.use(contactVerificationRoutes({ db } as AppContext, io)); const server = app.listen(0, '127.0.0.1'); await new Promise<void>(r => server.once('listening', r)); try {
        const url = `http://127.0.0.1:${(server.address() as {
            port: number;
        }).port}`;
        const response = await fetch(url + '/contact-verification/inspect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ registrationId: r.id, decisionId: uid(), expectedVersion: 1 }) });
        expect(response.status).toBe(503);
        expect(reads).toBe(0);
        await enroll();
        const v = await fetch(url + '/service/authorities/' + uid(), { headers: { 'x-contact-registration-id': r.id, authorization: 'Bearer fixture-dedicated-bearer-fixture-dedicated-bearer-' } });
        expect(v.status).toBe(401);
    }
    finally {
        await new Promise<void>(r => server.close(() => r()));
    } });
});
