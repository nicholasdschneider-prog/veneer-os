import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { BotError, createBotService, type Actor } from './service.js';
import { canonicalSha256 } from './canonical.js';
import { authoritySchema, claimInput, custodyHash, evidenceMaterial, evidenceSchema, inspectionInput, issueInput, registrationSchema, sourceIntentSchema, sourceRequestDigest, validateSourceIntent, CUSTODY_CONTRACT_HASH, type Authority, type Evidence, type Registration } from './caseCustodyContract.js';
export interface CustodyIO {
    registration: (id: string) => Registration;
    evidence: (r: Registration, caseId: string) => Promise<unknown>;
    intent: (r: Registration, id: string) => Promise<unknown>;
    now: () => number;
}
function deny(s: string): never { throw new BotError(409, s); }
const unavailable = (): never => { throw new BotError(503, 'CUSTODY_BOUNDARY_UNAVAILABLE: dedicated owner enrollment and accepted source integration required'); };
type Stored = {
    id: string;
    registration_id: string;
    request_hash: string;
    authority_json: string;
    inspection_json: string;
    review_json: string;
};
type Claim = {
    id: string;
    authority_id: string;
    registration_id: string;
    source_request_id: string;
    request_hash: string;
    request_json: string;
    source_intent_json: string;
    created_at: string;
};
type Message = {
    id: string;
    actor_id: number;
    actor_conversation_id?: string | null;
    text: string;
    created_at: string;
    kind: 'direct_message' | 'result_reply';
};
export function caseCustody(db: Database.Database, io: CustodyIO) {
    const bots = createBotService(db), iso = () => new Date(io.now()).toISOString();
    function registration(id: string, enrolled = true) {
        const r = registrationSchema.parse(io.registration(id));
        if (r.contractHash !== CUSTODY_CONTRACT_HASH || r.id !== id || !r.active || Math.min(Date.parse(r.expiresAt), Date.parse(r.credentialExpiresAt)) <= io.now())
            return unavailable();
        const team = db.prepare('SELECT owner_id FROM business_teams WHERE id=?').get(r.businessId) as {
            owner_id: number;
        } | undefined;
        if (team?.owner_id !== r.ownerUserId || !db.prepare("SELECT 1 FROM users WHERE id=? AND status='active'").get(r.ownerUserId))
            return unavailable();
        for (const id of [r.reviewerConversationId, r.executorConversationId]) {
            const c = db.prepare('SELECT user_id,business_team_id,archived FROM conversations WHERE id=?').get(id) as {
                user_id: number;
                business_team_id: string;
                archived: number;
            } | undefined;
            if (!c || c.archived || c.user_id !== r.ownerUserId || c.business_team_id !== r.businessId || !db.prepare('SELECT 1 FROM bot_registrations WHERE conversation_id=? AND active=1').get(id))
                return unavailable();
        }
        if (enrolled && !db.prepare('SELECT 1 FROM case_custody_enrollments WHERE registration_id=? AND registration_hash=? AND owner_id=?').get(r.id, canonicalSha256(r), r.ownerUserId))
            return unavailable();
        return r;
    }
    function owner(a: Actor, r: Registration) { if (a.conversationId || a.user.id !== r.ownerUserId)
        throw new BotError(403, 'Actual human business owner required'); }
    function reviewer(a: Actor, r: Registration) { if (a.conversationId !== r.reviewerConversationId || a.user.id !== r.ownerUserId)
        throw new BotError(403, 'Original enrolled reviewer required'); bots.chat(a, r.reviewerConversationId); }
    function identity(e: {
        registrationId: string;
        servicePrincipalId: string;
        businessId: string;
        accountId: string;
        sourceOrigin: string;
        runtime: unknown;
    }, r: Registration) { if (e.registrationId !== r.id || e.servicePrincipalId !== r.servicePrincipalId || e.businessId !== r.businessId || e.accountId !== r.accountId || e.sourceOrigin !== r.sourceOrigin || canonicalSha256(e.runtime) !== canonicalSha256(r.runtime))
        deny('SOURCE_IDENTITY_MISMATCH'); }
    function fresh(e: {
        observedAt: string;
        expiresAt: string;
    }) { if (Date.parse(e.observedAt) > io.now() || Date.parse(e.expiresAt) <= io.now() || Date.parse(e.expiresAt) > Date.parse(e.observedAt) + 15000 || io.now() - Date.parse(e.observedAt) > 15000)
        deny('SOURCE_OBSERVATION_EXPIRED'); }
    function validateEvidence(r: Registration, caseId: string, raw: unknown) {
        const e = evidenceSchema.parse(raw);
        identity(e, r);
        fresh(e);
        if (e.registrationRevision !== r.revision || e.caseId !== caseId || e.completion.caseVersion !== e.caseVersion || e.completion.eventCaseId !== e.caseId || e.completion.chronology === 'unavailable' || e.transition.caseId !== e.caseId || e.transition.destinationPrincipalId !== r.executorPrincipalId || e.transitionHash !== custodyHash('case-custody/transition/v1', e.transition) || e.snapshotHash !== custodyHash('case-custody/evidence/v1', evidenceMaterial(e)))
            deny('SOURCE_EVIDENCE_MISMATCH');
        if (e.from.mode !== 'historical_only' || e.from.revoked || e.from.principalId !== e.completion.principalId || e.to.mode !== 'active_destination' || e.to.retired || e.to.revoked || e.to.principalId !== r.executorPrincipalId || e.from.principalId === e.to.principalId)
            deny('SOURCE_ENROLLMENT_UNVERIFIED');
        const enrollment = db.prepare('SELECT evidence_json FROM case_custody_enrollments WHERE registration_id=?').get(r.id) as {
            evidence_json: string;
        } | undefined;
        if (enrollment) {
            const saved = JSON.parse(enrollment.evidence_json).evidence;
            if (canonicalSha256({ from: e.from, to: e.to }) !== canonicalSha256({ from: saved.from, to: saved.to }))
                deny('ENROLLED_SOURCE_IDENTITY_CHANGED');
        }
        for (const [record, pin] of [[e.from, r.historicalEnrollment], [e.to, r.destinationEnrollment]] as const)
            if (canonicalSha256({ id: record.id, revision: record.revision, principalId: record.principalId, identityEvidenceHash: record.identityEvidenceHash }) !== canonicalSha256(pin))
                deny('REGISTRATION_ENROLLMENT_MISMATCH');
        return e;
    }
    async function source(r: Registration, caseId: string) { const e = validateEvidence(r, caseId, await io.evidence(r, caseId)); if (canonicalSha256(registration(r.id, false)) !== canonicalSha256(r))
        deny('CUSTODY_CHANGED'); return e; }
    function eligible(e: Evidence) { if (!e.coverage.complete || e.coverage.omissions.length || e.blockers.length || e.priorEffects.some(x => x.disposition === 'unknown'))
        deny('SOURCE_SCOPE_OR_PRIOR_EFFECT_UNRESOLVED'); }
    function native(a: Actor, r: Registration, input: unknown) {
        reviewer(a, r);
        const p = inspectionInput.parse(input);
        const direct = (db.prepare('SELECT id,actor_id,text,proposals_json,created_at FROM bot_human_messages WHERE conversation_id=? ORDER BY rowid LIMIT 501').all(r.reviewerConversationId) as Message[]).map(x => ({ ...x, kind: 'direct_message' as const }));
        const replies = (db.prepare('SELECT r.id,r.actor_id,r.actor_conversation_id,r.text,r.created_at,t.source_text,t.anchor,t.id thread_id FROM bot_message_replies r JOIN bot_message_threads t ON t.id=r.thread_id WHERE t.conversation_id=? ORDER BY r.rowid LIMIT 501').all(r.reviewerConversationId) as Message[]).map(x => ({ ...x, kind: 'result_reply' as const }));
        const decisions = db.prepare('SELECT id,version,handling_revision,state,proposal_json,answer_json FROM bot_decisions WHERE conversation_id=? ORDER BY id LIMIT 501').all(r.reviewerConversationId);
        const discussions = db.prepare('SELECT t.* FROM bot_decision_threads t JOIN bot_decisions d ON d.id=t.decision_id WHERE d.conversation_id=? ORDER BY t.rowid LIMIT 501').all(r.reviewerConversationId);
        const context = { direct, replies, decisions, discussions };
        if ([direct, replies, decisions, discussions].some(x => x.length > 500) || Buffer.byteLength(JSON.stringify(context)) > 120000)
            deny('COMPLETE_CONTEXT_EXCEEDS_BOUND');
        // Decision discussion is not a supported instruction source; do not silently omit it from semantics.
        if (discussions.length)
            deny('DECISION_DISCUSSION_REQUIRES_SUPPORTED_COMPLETE_REVIEW');
        const human = [...direct, ...replies.filter(x => !x.actor_conversation_id)], instruction = human.find(x => x.id === p.instructionId && x.kind === p.instructionKind);
        if (!instruction || instruction.actor_id !== r.ownerUserId)
            deny('AUTHENTIC_HUMAN_OWNER_INSTRUCTION_REQUIRED');
        // Every source/anchor is retained. Accountable review handles quotes/conditions; no text classifier.
        const contextHash = custodyHash('case-custody/context/v1', { context, ownerUserId: r.ownerUserId, reviewer: r.reviewerConversationId, executor: r.executorConversationId, registrationHash: canonicalSha256(r) });
        return { input: p, context, human, instruction, contextHash, instructionHash: custodyHash('case-custody/instruction/v1', instruction) };
    }
    function semantic(n: ReturnType<typeof native>, e: Evidence, raw: unknown) {
        const v = issueInput.shape.review.parse(raw);
        if (v.interpretation !== 'unconditional_prospective_custody' || canonicalSha256(v.instruction) !== canonicalSha256({ kind: n.instruction.kind, id: n.instruction.id, text: n.instruction.text }))
            deny('EXPLICIT_PROSPECTIVE_CUSTODY_INSTRUCTION_REQUIRED');
        const keys = new Set<string>();
        for (const x of v.context) {
            const key = x.citation.kind + ':' + x.citation.id;
            if (keys.has(key) || !n.human.some(m => m.id === x.citation.id && m.kind === x.citation.kind && m.text === x.citation.text) || ['supersedes', 'ambiguous'].includes(x.classification))
                deny('COMPLETE_CONTEXT_REVIEW_UNRESOLVED');
            keys.add(key);
        }
        if (keys.size !== n.human.length)
            deny('COMPLETE_CONTEXT_REVIEW_REQUIRED');
        const effects = new Set<string>();
        for (const x of v.effects) {
            if (effects.has(x.id) || !e.priorEffects.some(p => p.id === x.id && p.revision === x.revision))
                deny('PRIOR_EFFECT_REVIEW_MISMATCH');
            effects.add(x.id);
        }
        if (effects.size !== e.priorEffects.length)
            deny('PRIOR_EFFECT_REVIEW_REQUIRED');
        return v;
    }
    async function inspect(a: Actor, raw: unknown) {
        const p = inspectionInput.parse(raw), r = registration(p.registrationId), before = native(a, r, p), e = await source(r, p.caseId), n = native(a, registration(r.id), p);
        if (n.contextHash !== before.contextHash)
            deny('NATIVE_CONTEXT_CHANGED');
        const binding = { registrationHash: canonicalSha256(r), contextHash: n.contextHash, instructionHash: n.instructionHash, sourceEvidenceHash: e.snapshotHash, input: p };
        return { execute: false as const, authority: false as const, inspectionHash: custodyHash('case-custody/inspection/v1', binding), binding, native: n, evidence: e };
    }
    function stored(id: string) { const row = db.prepare('SELECT * FROM case_custody_authorities WHERE id=?').get(id) as Stored | undefined; if (!row)
        throw new BotError(404, 'Custody authority not found'); return row; }
    function current(id: string, regId: string) {
        const row = stored(id), a = authoritySchema.parse(JSON.parse(row.authority_json)), r = registration(regId);
        if (a.registrationId !== r.id || a.registrationHash !== canonicalSha256(r))
            deny('AUTHORITY_REGISTRATION_MISMATCH');
        if (Date.parse(a.expiresAt) <= io.now() || db.prepare('SELECT 1 FROM case_custody_revocations WHERE authority_id=?').get(id))
            deny('AUTHORITY_REVOKED_OR_EXPIRED');
        const user = db.prepare('SELECT * FROM users WHERE id=?').get(r.ownerUserId) as Actor['user'], old = JSON.parse(row.inspection_json), n = native({ user, conversationId: r.reviewerConversationId }, r, old.native.input);
        if (n.contextHash !== a.contextHash || n.instructionHash !== a.instructionHash)
            deny('NATIVE_CONTEXT_CHANGED');
        semantic(n, old.evidence, JSON.parse(row.review_json));
        return { row, a, r };
    }
    function parseIntent(raw:unknown){try{return validateSourceIntent(sourceIntentSchema.parse(raw));}catch{ return deny('SOURCE_INTENT_CONTRACT_INVALID');}}
    const noEffect = { execute: false as const, custodyEntitlement: false as const };
    function claimRead(regId: string, id: string) { registration(regId); const row = stored(id); if (row.registration_id !== regId)
        throw new BotError(403, 'Wrong custody service'); const claim = db.prepare('SELECT * FROM case_custody_claims WHERE authority_id=?').get(id) as Claim | undefined; return { ...noEffect, claim: claim ? { id: claim.id, authorityId: id, sourceRequestId: claim.source_request_id, createdAt: claim.created_at, authorityHash: JSON.parse(claim.request_json).authorityHash, sourceRequestHash: JSON.parse(claim.request_json).sourceRequestHash, requestKey: JSON.parse(claim.request_json).requestKey } : null }; }
    return { inspect, registration,
        async prepareEnrollment(a: Actor, registrationId: string, caseId: string) { const r = registration(registrationId, false); owner(a, r); const evidence = await source(r, caseId); return { ...noEffect, registration: r, evidence, enrollmentHash: custodyHash('case-custody/enrollment/v1', { registration: r, from: evidence.from, to: evidence.to }) }; },
        async enroll(a: Actor, registrationId: string, caseId: string, expectedHash: string) { const s = await this.prepareEnrollment(a, registrationId, caseId); if (s.enrollmentHash !== expectedHash)
            deny('ENROLLMENT_EVIDENCE_CHANGED'); return db.transaction(() => { const r = registration(registrationId, false); owner(a, r); if (canonicalSha256(r) !== canonicalSha256(s.registration))
            deny('CUSTODY_CHANGED'); const existing = db.prepare('SELECT registration_hash FROM case_custody_enrollments WHERE registration_id=?').get(r.id) as {
            registration_hash: string;
        } | undefined; if (existing && existing.registration_hash !== canonicalSha256(r))
            deny('IMMUTABLE_ENROLLMENT_CONFLICT'); if (!existing)
            db.prepare('INSERT INTO case_custody_enrollments VALUES(?,?,?,?,?)').run(r.id, canonicalSha256(r), a.user.id, JSON.stringify(s), iso()); return { ...noEffect, enrolled: true }; }).immediate(); },
        async issue(a: Actor, raw: unknown) {
            const p = issueInput.parse(raw), requestHash = canonicalSha256(p);
            const prior = db.prepare('SELECT * FROM case_custody_authorities WHERE registration_id=? AND request_key=?').get(p.registrationId, p.requestKey) as Stored | undefined;
            if (prior) {
                reviewer(a, registration(p.registrationId));
                if (prior.request_hash !== requestHash)
                    deny('IDEMPOTENCY_CONFLICT');
                return { ...noEffect, authority: JSON.parse(prior.authority_json), replayed: true };
            }
            const s = await inspect(a, { registrationId: p.registrationId, caseId: p.caseId, instructionKind: p.instructionKind, instructionId: p.instructionId });
            if (s.inspectionHash !== p.inspectionHash)
                deny('INSPECTION_CHANGED');
            eligible(s.evidence);
            const review = semantic(s.native, s.evidence, p.review);
            return db.transaction(() => {
                const r = registration(p.registrationId), n = native(a, r, s.native.input);
                if (n.contextHash !== s.native.contextHash || canonicalSha256(r) !== s.binding.registrationHash)
                    deny('NATIVE_CONTEXT_CHANGED');
                const concurrent=db.prepare('SELECT * FROM case_custody_authorities WHERE registration_id=? AND request_key=?').get(p.registrationId,p.requestKey) as Stored|undefined;
                if(concurrent){if(concurrent.request_hash!==requestHash)deny('IDEMPOTENCY_CONFLICT');return {...noEffect,authority:JSON.parse(concurrent.authority_json),replayed:true};}
                fresh(s.evidence);
                semantic(n, s.evidence, review);
                if (Date.parse(p.expiresAt) <= io.now() || Date.parse(p.expiresAt) > Math.min(io.now() + 15 * 60 * 1000, Date.parse(r.expiresAt), Date.parse(r.credentialExpiresAt)))
                    deny('AUTHORITY_EXPIRY_INVALID');
                if (db.prepare('SELECT 1 FROM case_custody_authorities WHERE case_id=? AND completion_event_id=?').get(p.caseId, s.evidence.completion.eventId))
                    deny('ORIGINAL_CUSTODY_ACTION_ALREADY_RESERVED');
                const e = s.evidence, tuple = { schemaVersion: 'prospective-case-custody/v1' as const, id: crypto.randomUUID(), revision: 1 as const, registrationId: r.id, registrationHash: canonicalSha256(r), businessId: r.businessId, accountId: r.accountId, sourceOrigin: r.sourceOrigin, runtime: r.runtime, caseId: e.caseId, caseVersion: e.caseVersion, materialRevision: e.materialRevision, completion: e.completion, closedAt: e.closedAt, resolvedAt: e.resolvedAt, from: e.from, to: e.to, transition: e.transition, transitionHash: e.transitionHash, provenance: { instructionKind: p.instructionKind, instructionId: p.instructionId, humanAuthorId: n.instruction.actor_id, authorityBasis: "current_business_owner_instruction" as const, authorityBasisRevision: n.contextHash, reviewRecordId: crypto.randomUUID(), contextManifest: n.human.map(m => ({ kind: m.kind, id: m.id, contentHash: canonicalSha256(m) })) }, reviewerConversationId: r.reviewerConversationId, executorConversationId: r.executorConversationId, contextHash: n.contextHash, instructionHash: n.instructionHash, reviewHash: custodyHash('case-custody/review/v1', review), sourceEvidenceHash: e.snapshotHash, scope: review.scope, issuedAt: iso(), expiresAt: p.expiresAt };
                const authority = authoritySchema.parse({ ...tuple, authorityHash: custodyHash('case-custody/authority/v1', tuple) });
                db.prepare('INSERT INTO case_custody_authorities VALUES(?,?,?,?,?,?,?,?,?)').run(authority.id, r.id, e.caseId, e.completion.eventId, p.requestKey, requestHash, JSON.stringify(authority), JSON.stringify(s), JSON.stringify(review));
                return { ...noEffect, authority, replayed: false };
            }).immediate();
        },
        read(a: Actor, id: string) { const row = stored(id), r = registration(row.registration_id); if (a.conversationId) {
            if (![r.reviewerConversationId, r.executorConversationId].includes(a.conversationId) || a.user.id !== r.ownerUserId)
                throw new BotError(403, 'Original custody participant required');
        }
        else
            owner(a, r); return { authority: JSON.parse(row.authority_json), ...claimRead(r.id, id), revoked: !!db.prepare('SELECT 1 FROM case_custody_revocations WHERE authority_id=?').get(id) }; },
        async verify(regId: string, id: string) { const c = current(id, regId), e = await source(c.r, c.a.caseId); eligible(e); if (e.snapshotHash !== c.a.sourceEvidenceHash)
            deny('SOURCE_MATERIAL_CHANGED'); const now = current(id, regId); fresh(e); const observedAt = io.now(); return { ...noEffect, authority: now.a, observedAt: new Date(observedAt).toISOString(), expiresAt: new Date(Math.min(observedAt + 15000, Date.parse(now.a.expiresAt), Date.parse(e.expiresAt))).toISOString() }; },
        revoke(a: Actor, id: string, reason: string) { return db.transaction(() => { const row = stored(id), r = registration(row.registration_id); if (a.conversationId)
            reviewer(a, r);
        else
            owner(a, r); const claim = claimRead(r.id, id); if (!db.prepare('SELECT 1 FROM case_custody_revocations WHERE authority_id=?').get(id))
            db.prepare('INSERT INTO case_custody_revocations VALUES(?,?,?,?)').run(id, a.user.id, reason, iso()); return { ...noEffect, reservationIrrevocable: !!claim.claim }; }).immediate(); },
        claimRead,
        async claim(regId: string, raw: unknown) {
            const p = claimInput.parse(raw), r = registration(regId), prior = db.prepare('SELECT * FROM case_custody_claims WHERE authority_id=?').get(p.authorityId) as Claim | undefined;
            if (prior) {
                if (prior.registration_id !== regId || prior.request_hash !== canonicalSha256(p))
                    deny('CLAIM_CONFLICT');
                return claimRead(regId, p.authorityId);
            }
            const v = await this.verify(regId, p.authorityId);
            if (v.authority.authorityHash !== p.authorityHash)
                deny('AUTHORITY_HASH_MISMATCH');
            const intent = parseIntent(await io.intent(r, p.sourceRequestId));
            identity(intent, r);
            fresh(intent);
            if (intent.sourceRequestHash !== sourceRequestDigest(intent) || intent.transitionHash !== v.authority.transitionHash || canonicalSha256(intent.transition) !== canonicalSha256(v.authority.transition) || intent.preparation.preparedContentHash !== intent.sourceRequestHash || Date.parse(intent.preparation.preparedAt) > Date.parse(intent.preparation.redeemingAt) || Date.parse(intent.preparation.redeemingAt) > io.now() || intent.preparation.preparedEventId === intent.preparation.redeemingEventId || intent.outcome !== null || intent.state !== 'REDEEMING' || intent.claimId !== null || intent.receiptHash !== null || intent.caseId !== v.authority.caseId || intent.executorPrincipalId !== r.executorPrincipalId || ['sourceRequestId', 'sourceRequestHash', 'authorityId', 'authorityHash', 'requestKey'].some(k => intent[k as keyof typeof intent] !== p[k as keyof typeof p]))
                deny('DURABLE_SOURCE_INTENT_MISMATCH');
            return db.transaction(() => { const c = current(p.authorityId, regId); fresh(intent); fresh(v); if (c.a.authorityHash !== p.authorityHash || canonicalSha256(c.r) !== canonicalSha256(r))
                deny('CUSTODY_CHANGED'); const previous = db.prepare('SELECT * FROM case_custody_claims WHERE authority_id=?').get(p.authorityId) as Claim | undefined; if (previous) {
                if (previous.request_hash !== canonicalSha256(p))
                    deny('CLAIM_CONFLICT');
                return claimRead(regId, p.authorityId);
            } const id = crypto.randomUUID(); db.prepare('INSERT INTO case_custody_claims VALUES(?,?,?,?,?,?,?,?)').run(id, p.authorityId, regId, p.sourceRequestId, canonicalSha256(p), JSON.stringify(p), JSON.stringify(intent), iso()); return { execute: false, custodyEntitlement: true, claim: { id, authorityId: p.authorityId, sourceRequestId: p.sourceRequestId, createdAt: iso(), authorityHash: p.authorityHash, sourceRequestHash: p.sourceRequestHash, requestKey: p.requestKey } }; }).immediate();
        },
        async receipt(regId: string, id: string) {
            const r = registration(regId), c = db.prepare('SELECT * FROM case_custody_claims WHERE authority_id=? AND registration_id=?').get(id, regId) as Claim | undefined;
            if (!c)
                deny('ORIGINAL_CLAIM_REQUIRED');
            const request = claimInput.parse(JSON.parse(c.request_json)), a = authoritySchema.parse(JSON.parse(stored(id).authority_json)), e = parseIntent(await io.intent(r, c.source_request_id));
            identity(e, r);
            fresh(e);
            if (canonicalSha256(e.preparation) !== canonicalSha256(JSON.parse(c.source_intent_json).preparation) || e.sourceRequestHash !== sourceRequestDigest(e) || e.transitionHash !== a.transitionHash || canonicalSha256(e.transition) !== canonicalSha256(a.transition) || e.state === 'REDEEMING' || (e.claimId !== c.id && !(e.state === 'UNKNOWN' && e.claimId === null)) || e.caseId !== a.caseId || e.executorPrincipalId !== r.executorPrincipalId || ['sourceRequestId', 'sourceRequestHash', 'authorityId', 'authorityHash', 'requestKey'].some(k => e[k as keyof typeof e] !== request[k as keyof typeof request]) || (e.state !== 'UNKNOWN' && !e.receiptHash))
                deny('EXACT_SOURCE_RECEIPT_REQUIRED');
            if (e.state === 'UNKNOWN') {
                if (e.outcome !== null || e.receiptHash !== null)
                    deny('UNKNOWN_IS_NOT_VERIFIED_OUTCOME');
            }
            else {
                if (!e.outcome || e.outcome.kind !== e.state || e.receiptHash !== custodyHash('case-custody/outcome/v1', e.outcome))
                    deny('OUTCOME_PROOF_MISMATCH');
                if (e.outcome.kind === 'APPLIED' && (e.outcome.beforeCaseVersion !== a.caseVersion || e.outcome.afterCaseVersion !== a.caseVersion || e.outcome.transitionHash !== a.transitionHash || canonicalSha256(e.outcome.transition) !== canonicalSha256(a.transition) || Date.parse(e.outcome.committedAt) > io.now()))
                    deny('PROSPECTIVE_TRANSITION_MISMATCH');
            }
            return db.transaction(() => { if (canonicalSha256(registration(regId)) !== canonicalSha256(r))
                deny('CUSTODY_CHANGED'); fresh(e); const terminal = db.prepare("SELECT state,source_receipt_hash FROM case_custody_receipts WHERE claim_id=? AND state!='UNKNOWN' LIMIT 1").get(c.id) as {
                state: string;
                source_receipt_hash: string;
            } | undefined; if (terminal && (terminal.state !== e.state || terminal.source_receipt_hash !== e.receiptHash))
                deny('TERMINAL_RECEIPT_CONFLICT'); if (!terminal && !db.prepare('SELECT 1 FROM case_custody_receipts WHERE claim_id=? AND state=? AND source_receipt_hash IS ?').get(c.id, e.state, e.receiptHash))
                db.prepare('INSERT INTO case_custody_receipts VALUES(?,?,?,?,?,?)').run(crypto.randomUUID(), c.id, e.state, e.receiptHash, JSON.stringify(e), iso()); return { ...noEffect, state: e.state, claimId: c.id, receiptHash: e.receiptHash }; }).immediate();
        },
    };
}
