import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { BotError, createBotService, type Actor } from './service.js';
import { canonicalSha256 } from './canonical.js';
import { authoritySchema, registrationSchema, manifestSchema, evidenceSchema, evidenceMaterial, intentEvidenceSchema, intentMaterial, intentDigest, inspectInput, issueInput, associationInput, contactHash, CONTACT_CONTRACT_HASH, type Registration, type Evidence, type Authority, type IntentEvidence, type Manifest } from './contactVerificationContract.js';
export interface ContactIO {
    registration(id: string): Registration;
    evidence(r: Registration): Promise<unknown>;
    intent(r: Registration, id: string): Promise<unknown>;
    now(): number;
}
function deny(m: string): never { throw new BotError(409, m); }
const unavailable = (): never => { throw new BotError(503, 'CONTACT_VERIFICATION_UNAVAILABLE: dedicated accepted integration and actual owner enrollment required'); };
const eq = (a: unknown, b: unknown) => canonicalSha256(a) === canonicalSha256(b);
const off = { execute: false as const, dispatchEntitlement: false as const };
type Stored = {
    id: string;
    registration_id: string;
    request_key: string;
    request_hash: string;
    authority_json: string;
    context_json: string;
    generation_json: string | null;
};
type Association = {
    id: string;
    authority_id: string;
    registration_id: string;
    intent_id: string;
    channel: string;
    request_hash: string;
    association_json: string;
    source_json: string;
};
export function contactVerification(db: Database.Database, io: ContactIO) {
    const bots = createBotService(db), stamp = () => new Date(io.now()).toISOString();
    function registration(id: string, enrolled = true) {
        const r = registrationSchema.parse(io.registration(id));
        if (r.id !== id || !r.active || r.contractHash !== CONTACT_CONTRACT_HASH || Math.min(Date.parse(r.expiresAt), Date.parse(r.credentialExpiresAt)) <= io.now())
            return unavailable();
        const team = db.prepare('SELECT owner_id FROM business_teams WHERE id=?').get(r.businessId) as {
            owner_id: number;
        } | undefined;
        if (team?.owner_id !== r.ownerUserId || !db.prepare("SELECT 1 FROM users WHERE id=? AND status='active'").get(r.ownerUserId) || r.executor.userId !== r.ownerUserId || r.servicePrincipalId === r.executor.principalId)
            return unavailable();
        for (const id of [r.ownerConversationId, r.executor.conversationId]) {
            const c = db.prepare('SELECT user_id,business_team_id,archived FROM conversations WHERE id=?').get(id) as {
                user_id: number;
                business_team_id: string;
                archived: number;
            } | undefined;
            if (!c || c.archived || c.user_id !== r.ownerUserId || c.business_team_id !== r.businessId || !db.prepare('SELECT 1 FROM bot_registrations WHERE conversation_id=? AND active=1').get(id))
                return unavailable();
        }
        if (enrolled && !db.prepare('SELECT 1 FROM contact_verification_enrollments WHERE registration_id=? AND registration_hash=? AND owner_id=?').get(id, canonicalSha256(r), r.ownerUserId))
            return unavailable();
        return r;
    }
    function human(a: Actor, r: Registration) { if (a.conversationId || a.user.id !== r.ownerUserId)
        throw new BotError(403, 'Actual current human business owner required'); }
    function owner(a: Actor, r: Registration) { if (a.user.id !== r.ownerUserId || a.conversationId !== r.ownerConversationId)
        throw new BotError(403, 'Original registered decision owner required'); bots.chat(a, r.ownerConversationId); }
    function fresh(e: {
        observedAt: string;
        expiresAt: string;
    }) { const n = io.now(), t = Date.parse(e.observedAt), x = Date.parse(e.expiresAt); if (t > n || x <= n || x > t + 15000 || n - t > 15000)
        deny('SOURCE_EVIDENCE_EXPIRED'); }
    function bound(r: Registration, m: Manifest) {
        const ids = { caseId: m.target.caseId, orderId: m.target.orderId, caseCustomerId: m.target.caseCustomerId, orderCustomerId: m.target.orderCustomerId };
        if (m.registrationId !== r.id || m.registrationRevision !== r.revision || m.businessId !== r.businessId || m.accountId !== r.accountId || m.sourceOrigin !== r.sourceOrigin || !eq(m.runtime, r.runtime) || !eq(m.executor, r.executor) || !eq(ids, r.target))
            deny('EXACT_REGISTERED_TARGET_MISMATCH');
        for (let i = 0; i < 2; i++) {
            const c = m.channels[i]!, p = r.channels[i]!;
            if (!eq({ channel: c.channel, accountId: c.accountId, from: c.from, recipient: c.recipient, origin: c.slot.origin, path: c.slot.path }, p))
                deny('REGISTERED_CHANNEL_MISMATCH');
        }
    }
    async function source(r: Registration) {
        let e: Evidence;
        try {
            e = evidenceSchema.parse(await io.evidence(r));
        }
        catch {
            return deny('SOURCE_MANIFEST_CONTRACT_INVALID');
        }
        fresh(e);
        bound(r, e.manifest);
        if (e.registrationId !== r.id || e.registrationHash !== canonicalSha256(r) || e.servicePrincipalId !== r.servicePrincipalId || e.evidenceHash !== contactHash('contact-verification/evidence/v1', evidenceMaterial(e)) || !eq(registration(r.id, false), r))
            deny('SOURCE_MANIFEST_BINDING_CHANGED');
        return e;
    }
    function eligible(e: Evidence) { if (!e.coverage.complete || e.coverage.omissions.length || e.blockers.length)
        deny('SOURCE_MANIFEST_INCOMPLETE_OR_BLOCKED'); }
    function native(r: Registration, id: string, version: number) {
        const user = db.prepare("SELECT * FROM users WHERE id=? AND status='active'").get(r.ownerUserId) as Actor['user'];
        const d = bots.read({ user }, id);
        if (d.conversation_id !== r.ownerConversationId || d.version !== version)
            deny('DECISION_OWNER_OR_VERSION_CHANGED');
        const p = JSON.parse(d.proposal_json), answer = d.answer_json ? JSON.parse(d.answer_json) : null;
        if (answer?.action !== 'approve' || !['decided', 'action_pending', 'blocked', 'running'].includes(d.state))
            deny('EXACT_CURRENT_HUMAN_APPROVAL_REQUIRED');
        const events = db.prepare("SELECT rowid,id,actor_id,actor_conversation_id,payload_json,created_at FROM bot_decision_events WHERE decision_id=? AND version=? AND kind='answered'").all(id, version) as {
            rowid: number;
            id: string;
            actor_id: number;
            actor_conversation_id: string | null;
            payload_json: string;
            created_at: string;
        }[];
        if (events.length !== 1)
            deny('ONE_IMMUTABLE_HUMAN_APPROVAL_REQUIRED');
        const event = events[0]!, raw = JSON.parse(event.payload_json);
        const approver = db.prepare("SELECT * FROM users WHERE id=? AND status='active'").get(event.actor_id) as Actor['user'] | undefined;
        if (event.actor_conversation_id || raw.action !== 'approve' || event.actor_id !== answer.actor_id || raw.text !== answer.text || raw.scope !== answer.scope || !approver || !bots.view({ user: approver }, d).can_answer)
            deny('APPROVER_REVOKED_OR_NOT_HUMAN');
        const snapshot = db.prepare("SELECT kind,payload_json FROM bot_decision_events WHERE decision_id=? AND version=? AND kind IN ('raised','revised') AND rowid<? ORDER BY rowid DESC LIMIT 1").get(id, version, event.rowid) as {
            kind: string;
            payload_json: string;
        } | undefined;
        if (!snapshot || !eq(snapshot.kind === 'raised' ? JSON.parse(snapshot.payload_json).proposal : JSON.parse(snapshot.payload_json), p))
            deny('APPROVED_PROPOSAL_CHANGED');
        const m = manifestSchema.safeParse(p.contact_verification);
        if (!m.success)
            deny('PAIRED_PUBLIC_TEMPLATE_APPROVAL_REQUIRED');
        bound(r, m.data!);
        const direct = db.prepare('SELECT id,actor_id,text,created_at FROM bot_human_messages WHERE conversation_id=? ORDER BY rowid LIMIT 501').all(r.ownerConversationId) as {
            created_at: string;
        }[];
        const replies = db.prepare('SELECT r.id,r.actor_id,r.actor_conversation_id,r.text,r.created_at,t.source_text FROM bot_message_replies r JOIN bot_message_threads t ON t.id=r.thread_id WHERE t.conversation_id=? ORDER BY r.rowid LIMIT 501').all(r.ownerConversationId) as {
            created_at: string;
            actor_conversation_id: string | null;
        }[];
        const discussion = db.prepare('SELECT * FROM bot_decision_threads WHERE decision_id=? ORDER BY rowid LIMIT 501').all(id) as { created_at: string; actor_conversation_id: string | null }[];
        const context = { direct, replies, discussion, handlingRevision: d.handling_revision, answer, proposal: p };
        if ([direct, replies, discussion].some(v => v.length > 500) || Buffer.byteLength(JSON.stringify(context)) > 128000)
            deny('NATIVE_CONTEXT_EXCEEDS_BOUND');
        const date = (s: string) => Date.parse(s.includes('T') ? s : s.replace(' ', 'T') + 'Z');
        if ([...direct, ...replies.filter(x => !x.actor_conversation_id), ...discussion.filter(x => !x.actor_conversation_id)].some(x => !Number.isFinite(date(x.created_at)) || date(x.created_at) >= date(event.created_at)))
            deny('POST_APPROVAL_HUMAN_CONTEXT_REQUIRES_REVIEW');
        return { manifest: m.data!, eventId: event.id, approverId: event.actor_id, proposalHash: canonicalSha256(p), contextHash: contactHash('contact-verification/native-context/v1', context), context };
    }
    async function inspect(a: Actor, input: unknown) {
        const p = inspectInput.parse(input), r = registration(p.registrationId);
        owner(a, r);
        const n = native(r, p.decisionId, p.expectedVersion), e = await source(r), after = native(registration(r.id), p.decisionId, p.expectedVersion);
        eligible(e);
        if (!eq(e.manifest, n.manifest) || !eq(n, after))
            deny('APPROVAL_OR_SOURCE_DRIFT');
        const binding = { input: p, registrationHash: canonicalSha256(r), proposalHash: n.proposalHash, contextHash: n.contextHash, evidenceHash: e.evidenceHash };
        return { ...off, ready: false as const, inspectionHash: contactHash('contact-verification/inspection/v1', binding), binding, manifest: e.manifest, evidence: e, approval: { eventId: n.eventId, approverId: n.approverId }, context: n.context };
    }
    function stored(id: string) { const row = db.prepare('SELECT * FROM contact_verification_authorities WHERE id=?').get(id) as Stored | undefined; if (!row)
        throw new BotError(404, 'Contact authority not found'); return row; }
    function current(regId: string, id: string) { const r = registration(regId), row = stored(id), a = authoritySchema.parse(JSON.parse(row.authority_json)); if (row.registration_id !== r.id || a.registrationHash !== canonicalSha256(r))
        deny('AUTHORITY_REGISTRATION_MISMATCH'); if (Date.parse(a.expiresAt) <= io.now() || db.prepare('SELECT 1 FROM contact_verification_revocations WHERE authority_id=?').get(id))
        deny('AUTHORITY_REVOKED_OR_EXPIRED'); const n = native(r, a.decisionId, a.decisionVersion); if (n.eventId !== a.approvalEventId || n.approverId !== a.approverUserId || n.contextHash !== a.contextHash || n.proposalHash !== a.proposalHash || !eq(n.manifest, a.manifest))
        deny('AUTHORITY_APPROVAL_CONTEXT_CHANGED'); return { r, row, a }; }
    function association(id: string, regId: string) { registration(regId); const row = db.prepare('SELECT * FROM contact_verification_associations WHERE id=?').get(id) as Association | undefined; if (!row || row.registration_id !== regId)
        throw new BotError(404, 'Exact association not found'); return row; }
    function reconcile(regId: string, id: string) { const row = association(id, regId); return { ...off, association: JSON.parse(row.association_json) }; }
    function lookup(regId:string,input:unknown) {
        const p=associationInput.parse(input),r=registration(regId),saved=stored(p.authorityId),a=authoritySchema.parse(JSON.parse(saved.authority_json));
        if(saved.registration_id!==r.id||p.registrationId!==r.id||p.registrationRevision!==r.revision||a.registrationHash!==canonicalSha256(r)||p.authorityHash!==a.authorityHash||p.sourceRevision!==a.sourceRevision||p.materialRevision!==a.manifest.target.materialRevision||p.templateHash!==a.manifest.channels.find(c=>c.channel===p.channel)!.templateHash)deny('EXACT_ORIGINAL_LOOKUP_REQUIRED');
        const row=db.prepare('SELECT * FROM contact_verification_associations WHERE authority_id=? AND channel=?').get(p.authorityId,p.channel) as Association|undefined;
        if(row&&(row.registration_id!==regId||row.request_hash!==canonicalSha256(p)))deny('EXACT_ORIGINAL_LOOKUP_REQUIRED');
        for(const [col,value] of [['intent_id',p.intentId],['request_key',p.requestKey],['provider_key',p.providerIdempotencyKey],['intent_hash',p.intentHash],['request_hash',canonicalSha256(p)]] as const){const occupied=db.prepare(`SELECT id FROM contact_verification_associations WHERE ${col}=?`).get(value) as {id:string}|undefined;if(occupied&&occupied.id!==row?.id)deny('EXACT_ORIGINAL_LOOKUP_CONFLICT');}
        return {...off,retryAllowed:false as const,association:row?JSON.parse(row.association_json):null};
    }
    function rememberPairBlock(authorityId:string,e:IntentEvidence) {
        return db.transaction(()=>{
            const old=db.prepare('SELECT generation_id,block_json FROM contact_verification_pair_blocks WHERE authority_id=?').get(authorityId) as {generation_id:string;block_json:string}|undefined;
            if(old&&(old.generation_id!==e.generation.generationId||!eq(JSON.parse(old.block_json),e.pairBlock)))deny('PERMANENT_PAIR_BLOCK_CHANGED');
            if(!e.pairBlock)return;
            const a=authoritySchema.parse(JSON.parse(stored(authorityId).authority_json)),g=e.generation,r=registration(a.registrationId);fresh(e);
            if(g.authorityId!==a.authorityId||g.authorityHash!==a.authorityHash||g.registrationId!==a.registrationId||g.registrationHash!==a.registrationHash||canonicalSha256(r)!==a.registrationHash||g.businessId!==a.manifest.businessId||g.manifestHash!==a.manifestHash||g.executorPrincipalId!==a.manifest.executor.principalId||g.sourceRevision!==a.sourceRevision||g.materialRevision!==a.manifest.target.materialRevision)deny('PAIR_BLOCK_AUTHORITY_MISMATCH');
            if(!old)db.prepare('INSERT INTO contact_verification_pair_blocks VALUES(?,?,?,?,?)').run(authorityId,g.generationId,JSON.stringify(e.pairBlock),JSON.stringify(e),stamp());
        }).immediate();
    }
    async function intent(r: Registration, id: string) {
        let e: IntentEvidence;
        try {
            e = intentEvidenceSchema.parse(await io.intent(r, id));
        }
        catch {
            return deny('SOURCE_INTENT_CONTRACT_INVALID');
        }
        fresh(e);
        if (e.intentId !== id || e.registrationId !== r.id || e.registrationHash !== canonicalSha256(r) || e.servicePrincipalId !== r.servicePrincipalId || e.evidenceHash !== contactHash('contact-verification/dispatch-evidence/v1', intentMaterial(e)) || !eq(registration(r.id), r))
            deny('SOURCE_INTENT_IDENTITY_CHANGED');
        const g = e.generation, { generationHash, ...body } = g;
        if (generationHash !== contactHash('contact-verification/generation/v1', body) || g.intents[0].channel !== 'email' || g.intents[1].channel !== 'sms' || !g.intents.some(i => i.intentId === id) || g.intents.some(i => i.intentHash !== intentDigest(g, i)))
            deny('PAIRED_GENERATION_HASH_MISMATCH');
        for (const k of ['intentId', 'requestKey', 'providerIdempotencyKey', 'slotCommitment'] as const)
            if (g.intents[0][k] === g.intents[1][k])
                deny('INDEPENDENT_CHANNEL_BINDINGS_REQUIRED');
        if ((e.sendingEventId === null) !== (e.sendingAt === null) || (e.state === 'REDEEMING' && (e.sendingAt !== null || e.sendingEventId !== null)) || (['SENDING', 'SENT_ACCEPTED'].includes(e.state) && !e.sendingEventId))
            deny('DURABLE_SENDING_FENCE_REQUIRED');
        if (e.sendingAt && (Date.parse(e.sendingAt) < Date.parse(e.redeemingAt) || Date.parse(e.sendingAt) >= Date.parse(g.expiresAt) || Date.parse(e.sendingAt) > io.now() || [g.preparedEventId, e.redeemingEventId].includes(e.sendingEventId!)))
            deny('DURABLE_SENDING_FENCE_INVALID');
        if (g.preparedEventId === e.redeemingEventId || Date.parse(g.preparedAt) > Date.parse(e.redeemingAt) || Date.parse(e.redeemingAt) > io.now())
            deny('DURABLE_PREPARE_REDEEM_ORDER_REQUIRED');
        return e;
    }
    const service = { registration, inspect,
        async prepare(a: Actor, id: string) { const r = registration(id); owner(a, r); const e = await source(r); owner(a, registration(id)); eligible(e); return { ...off, ready: false as const, manifest: e.manifest, evidence: e }; },
        async prepareEnrollment(a: Actor, id: string) { const r = registration(id, false); human(a, r); const e = await source(r); return { ...off, registration: r, evidence: e, enrollmentHash: contactHash('contact-verification/enrollment/v1', { registration: r, manifest: e.manifest }) }; },
        async enroll(a: Actor, id: string, expectedHash: string) { const p = await service.prepareEnrollment(a, id); if (p.enrollmentHash !== expectedHash)
            deny('ENROLLMENT_EVIDENCE_CHANGED'); return db.transaction(() => { const r = registration(id, false); human(a, r); fresh(p.evidence); if (!eq(r, p.registration))
            deny('ENROLLMENT_REGISTRATION_CHANGED'); const old = db.prepare('SELECT registration_hash FROM contact_verification_enrollments WHERE registration_id=?').get(id) as {
            registration_hash: string;
        } | undefined; if (old && old.registration_hash !== canonicalSha256(r))
            deny('IMMUTABLE_ENROLLMENT_CONFLICT'); if (!old)
            db.prepare('INSERT INTO contact_verification_enrollments VALUES(?,?,?,?,?)').run(id, canonicalSha256(r), a.user.id, JSON.stringify(p), stamp()); return { ...off, enrolled: true }; }).immediate(); },
        async issue(a: Actor, input: unknown) {
            const p = issueInput.parse(input), requestHash = canonicalSha256(p), r = registration(p.registrationId);
            owner(a, r);
            function replay() { const old = db.prepare('SELECT * FROM contact_verification_authorities WHERE registration_id=? AND request_key=?').get(r.id, p.requestKey) as Stored | undefined; if (old) {
                if (old.request_hash !== requestHash)
                    deny('IDEMPOTENCY_CONFLICT');
                return { ...off, authority: JSON.parse(old.authority_json), replayed: true };
            } }
            const prior = replay();
            if (prior)
                return prior;
            const s = await inspect(a, { registrationId: r.id, decisionId: p.decisionId, expectedVersion: p.expectedVersion });
            if (s.inspectionHash !== p.inspectionHash)
                deny('INSPECTION_CHANGED');
            return db.transaction(() => {
                const active = registration(r.id);
                owner(a, active);
                const n = native(active, p.decisionId, p.expectedVersion);
                if (n.contextHash !== s.binding.contextHash || n.proposalHash !== s.binding.proposalHash || canonicalSha256(active) !== s.binding.registrationHash)
                    deny('NATIVE_CONTEXT_CHANGED');
                const same = replay();
                if (same)
                    return same;
                fresh(s.evidence);
                if (Date.parse(p.expiresAt) <= io.now() || Date.parse(p.expiresAt) > Math.min(io.now() + 900000, Date.parse(active.expiresAt), Date.parse(active.credentialExpiresAt)))
                    deny('AUTHORITY_EXPIRY_INVALID');
                const targetKey = contactHash('contact-verification/target-action/v1', { businessId: r.businessId, sourceOrigin: r.sourceOrigin, target: r.target });
                if (db.prepare('SELECT 1 FROM contact_verification_authorities WHERE target_key=?').get(targetKey))
                    deny('PAIRED_TARGET_ALREADY_RESERVED');
                const tuple = { schemaVersion: 'paired-contact-authority/v1' as const, authorityId: crypto.randomUUID(), revision: 1 as const, registrationId: r.id, registrationRevision: r.revision, registrationHash: canonicalSha256(active), decisionId: p.decisionId, decisionVersion: p.expectedVersion, approvalEventId: n.eventId, approverUserId: n.approverId, proposalHash: n.proposalHash, contextHash: n.contextHash, manifest: s.manifest, manifestHash: s.manifest.manifestHash, sourceRevision: s.evidence.sourceRevision, evidenceHash: s.evidence.evidenceHash, issuedAt: stamp(), expiresAt: p.expiresAt };
                const authority = authoritySchema.parse({ ...tuple, authorityHash: contactHash('contact-verification/authority/v1', tuple) });
                db.prepare('INSERT INTO contact_verification_authorities VALUES(?,?,?,?,?,?,?)').run(authority.authorityId, r.id, targetKey, p.requestKey, requestHash, JSON.stringify(authority), JSON.stringify(s.context));
                return { ...off, authority, replayed: false };
            }).immediate();
        },
        read(a: Actor, id: string) { const row = stored(id), r = registration(row.registration_id); if (a.user.id !== r.ownerUserId || (a.conversationId && ![r.ownerConversationId, r.executor.conversationId].includes(a.conversationId)))
            throw new BotError(403, 'Original participant required'); return { ...off, authority: JSON.parse(row.authority_json), associations: db.prepare('SELECT association_json FROM contact_verification_associations WHERE authority_id=? ORDER BY channel').all(id).map(v => JSON.parse((v as {
                association_json: string;
            }).association_json)), revoked: !!db.prepare('SELECT 1 FROM contact_verification_revocations WHERE authority_id=?').get(id) }; },
        async verify(regId: string, id: string) { const c = current(regId, id), e = await source(c.r); eligible(e); const last = current(regId, id); fresh(e); if (e.evidenceHash !== last.a.evidenceHash || !eq(e.manifest, last.a.manifest))
            deny('SOURCE_MATERIAL_CHANGED'); const t = io.now(); return { ...off, authority: last.a, observedAt: new Date(t).toISOString(), expiresAt: new Date(Math.min(t + 15000, Date.parse(last.a.expiresAt), Date.parse(e.expiresAt))).toISOString() }; },
        revoke(a: Actor, id: string, reason: string) { return db.transaction(() => { const row = stored(id), r = registration(row.registration_id); if (a.conversationId)
            owner(a, r);
        else
            human(a, r); if (!db.prepare('SELECT 1 FROM contact_verification_revocations WHERE authority_id=?').get(id))
            db.prepare('INSERT INTO contact_verification_revocations VALUES(?,?,?,?)').run(id, a.user.id, reason, stamp()); return { ...off, reservationsIrrevocable: true }; }).immediate(); },
        reconcile, lookup,
        async associate(regId: string, input: unknown) {
            const p = associationInput.parse(input), r = registration(regId);
            if (p.registrationId !== r.id || p.registrationRevision !== r.revision)
                deny('REGISTRATION_REQUEST_MISMATCH');
            const requestHash = canonicalSha256(p);
            function replay() { const old = db.prepare('SELECT * FROM contact_verification_associations WHERE authority_id=? AND channel=?').get(p.authorityId, p.channel) as Association | undefined; if (old) {
                if (old.registration_id !== regId || old.request_hash !== requestHash)
                    deny('CHANNEL_ALREADY_RESERVED');
                return reconcile(regId, old.id);
            } }
            const prior = replay();
            if (prior)
                return prior;
            const v = await service.verify(regId, p.authorityId), e = await intent(r, p.intentId), g = e.generation, i = g.intents.find(i => i.intentId === p.intentId)!;
            const expected = { schemaVersion: p.schemaVersion, authorityId: g.authorityId, authorityHash: g.authorityHash, registrationId: g.registrationId, registrationRevision: r.revision, generationId: g.generationId, ...i, sourceRevision: g.sourceRevision, materialRevision: g.materialRevision };
            if (!eq(expected, p) || g.registrationHash !== canonicalSha256(r) || g.businessId !== r.businessId || g.manifestHash !== v.authority.manifestHash || g.executorPrincipalId !== r.executor.principalId || g.authorityHash !== v.authority.authorityHash || g.sourceRevision !== v.authority.sourceRevision || g.materialRevision !== v.authority.manifest.target.materialRevision || Date.parse(g.expiresAt) > Date.parse(v.authority.expiresAt) || Date.parse(g.expiresAt) <= io.now() || Date.parse(g.preparedAt) < Date.parse(v.authority.issuedAt))
                deny('EXACT_PREPARED_PAIR_REQUIRED');
            for (let index = 0; index < 2; index++)
                if (g.intents[index]!.templateHash !== v.authority.manifest.channels[index]!.templateHash)
                    deny('PAIRED_TEMPLATE_CHANGED');
            rememberPairBlock(p.authorityId,e);
            if(e.pairBlock)deny('PAIR_PERMANENTLY_BLOCKED');
            if(e.state!=='REDEEMING'||e.associationId!==null||e.outcome!==null)deny('EXACT_PREPARED_PAIR_REQUIRED');
            return db.transaction(() => {
                const c = current(regId, p.authorityId);
                fresh(e);
                if (Date.parse(v.expiresAt) <= io.now() || Date.parse(g.expiresAt) <= io.now())
                    deny('SOURCE_OBSERVATION_OR_GENERATION_EXPIRED');
                if (c.a.authorityHash !== v.authority.authorityHash || !eq(c.r, r))
                    deny('AUTHORITY_CHANGED');
                const old = replay();
                if (old)
                    return old;
                const generation = db.prepare('SELECT generation_json FROM contact_verification_generations WHERE authority_id=?').get(p.authorityId) as {
                    generation_json: string;
                } | undefined;
                if (generation && !eq(JSON.parse(generation.generation_json), g))
                    deny('GENERATION_ALREADY_RESERVED');
                const blocked=db.prepare("SELECT 1 FROM contact_verification_receipts r JOIN contact_verification_associations a ON a.id=r.association_id WHERE a.authority_id=? AND (r.state IN ('UNKNOWN','ROLLED_BACK_TERMINAL') OR json_type(r.source_json,'$.pairBlock')='object') LIMIT 1").get(p.authorityId);
                if(e.pairBlock||blocked||db.prepare('SELECT 1 FROM contact_verification_pair_blocks WHERE authority_id=?').get(p.authorityId))deny('PAIR_PERMANENTLY_BLOCKED');
                if(p.channel==='sms'){
                    const email=db.prepare("SELECT id FROM contact_verification_associations WHERE authority_id=? AND channel='email'").get(p.authorityId) as {id:string}|undefined;
                    const result=email?db.prepare('SELECT state FROM contact_verification_receipts WHERE association_id=? ORDER BY rowid DESC LIMIT 1').get(email.id) as {state:string}|undefined:undefined;
                    if(result?.state!=='SENT_ACCEPTED')deny('EMAIL_FIRST_SIBLING_UNRESOLVED_NO_RETRY');
                }
                if (!generation)
                    db.prepare('INSERT INTO contact_verification_generations VALUES(?,?,?,?)').run(p.authorityId, r.id, g.generationId, JSON.stringify(g));
                for (const col of ['intent_id', 'request_key', 'provider_key'] as const) {
                    const val = col === 'intent_id' ? p.intentId : col === 'request_key' ? p.requestKey : p.providerIdempotencyKey;
                    if (db.prepare(`SELECT 1 FROM contact_verification_associations WHERE ${col}=?`).get(val))
                        deny('PERMANENT_INTENT_KEY_CONFLICT');
                }
                const value = { id: crypto.randomUUID(), binding: p, registrationHash: canonicalSha256(r), generationHash: g.generationHash, createdAt: stamp() };
                db.prepare('INSERT INTO contact_verification_associations VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(value.id, p.authorityId, r.id, p.channel, p.intentId, p.requestKey, p.providerIdempotencyKey, p.intentHash, requestHash, JSON.stringify(value), JSON.stringify(e), stamp());
                return { execute: false as const, dispatchEntitlement: true, association: value };
            }).immediate();
        },
        async receipt(regId: string, id: string) {
            const row = association(id, regId), r = registration(regId), saved = JSON.parse(row.source_json) as IntentEvidence, e = await intent(r, row.intent_id), a = JSON.parse(stored(row.authority_id).authority_json) as Authority, o = e.outcome;
            if (!eq(e.generation, saved.generation) || e.redeemingEventId !== saved.redeemingEventId || e.redeemingAt !== saved.redeemingAt || !o || !['SENT_ACCEPTED', 'UNKNOWN', 'ROLLED_BACK_TERMINAL'].includes(e.state) || e.state !== o.state)
                deny('ORIGINAL_SOURCE_RECEIPT_REQUIRED');
            const { outcomeHash, ...body } = o, binding = JSON.parse(row.association_json).binding;
            if (outcomeHash !== contactHash('contact-verification/outcome/v1', body) || ((o.associationId !== id || e.associationId !== id) && !(o.state === 'UNKNOWN' && o.associationId === null && e.associationId === null)) || o.providerAccountId !== a.manifest.channels.find(c => c.channel === row.channel)!.accountId || o.wirePayloadHash !== binding.wirePayloadHash || o.providerIdempotencyKey !== binding.providerIdempotencyKey || Date.parse(o.recordedAt) > io.now() || Date.parse(o.recordedAt) < Date.parse(JSON.parse(row.association_json).createdAt) || (o.state === 'SENT_ACCEPTED' ? !o.providerId : o.providerId !== null))
                deny('RECEIPT_PROVIDER_CORRELATION_MISMATCH');
            rememberPairBlock(row.authority_id,e);
            return db.transaction(() => { association(id, regId); if (!eq(registration(regId), r))
                deny('CUSTODY_CHANGED'); fresh(e); const last = db.prepare('SELECT state,outcome_json,source_json FROM contact_verification_receipts WHERE association_id=? ORDER BY rowid DESC LIMIT 1').get(id) as {
                state: string;
                outcome_json: string;
                source_json: string;
            } | undefined; if (last) {
                const prior = JSON.parse(last.source_json) as IntentEvidence;
                if(prior.pairBlock&&!eq(prior.pairBlock,e.pairBlock))deny('PERMANENT_PAIR_BLOCK_CHANGED');
                if (prior.sendingEventId && (prior.sendingEventId !== e.sendingEventId || prior.sendingAt !== e.sendingAt))
                    deny('SOURCE_SENDING_FENCE_CHANGED');
            } if (last && last.state !== 'UNKNOWN' && !eq(JSON.parse(last.outcome_json), o))
                deny('IMMUTABLE_TERMINAL_OUTCOME_CONFLICT'); if (!last || !eq(JSON.parse(last.outcome_json), o))
                db.prepare('INSERT INTO contact_verification_receipts VALUES(?,?,?,?,?,?)').run(crypto.randomUUID(), id, o.state, JSON.stringify(o), JSON.stringify(e), stamp()); return { ...off, associationId: id, outcome: o }; }).immediate();
        }
    };
    return service;
}
