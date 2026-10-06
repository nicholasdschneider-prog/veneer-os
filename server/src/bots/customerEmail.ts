import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import type { UserRow } from '../db/db.js';
import { BotError, type Actor } from './service.js';
import { canonicalJson, canonicalSha256 } from './canonical.js';
import { customerEmailNative } from './customerEmailNative.js';
import { emailRegistrationCurrent } from './customerEmailTrust.js';
import { validateEmailCapture, emailCaptureMatchesProjection, emailReviewMaterial, type EmailIO, type EmailNativeSnapshot } from './customerEmailIO.js';
import { EMAIL_CONTRACT, EMAIL_CONTRACT_HASH, emailInput, emailCaptureInput, emailBind, emailConsume, emailLookup, emailReview, emailProjection, emailAssociation, emailIntent, emailId, emailKey, type EmailCaptureInput, type EmailProjection, type EmailRegistration } from './customerEmailContract.js';
const nativeInput = (p: EmailCaptureInput) => ({
    source_owner_id: p.source_owner_id, source_kind: p.source_kind, source_id: p.source_id, executor_id: p.executor_id, draft_id: p.draft_id, draft_version: p.draft_version
});
type Authority = {
    id: string;
    action_id: string;
    action_fence: string;
    source_owner_id: string;
    source_kind: string;
    source_id: string;
    executor_id: string;
    draft_id: string;
    request_key: string;
    request_hash: string;
    projection_json: string;
    native_json: string;
    binding_hash: string | null;
};
type Event = {
    id: string;
    request_key: string;
    request_hash: string;
    payload_json: string;
};
type Association = {
    id: string;
    authority_id: string;
    registration_id: string;
    intent_id: string;
    request_key: string;
    request_hash: string;
    binding_json: string;
};
export function customerEmailService(db: Database.Database, io: EmailIO) {
    const native = customerEmailNative(db), stamp = () => new Date(io.now()).toISOString();
    const event = (id: string, kind: string) => db.prepare('SELECT * FROM customer_email_events WHERE authority_id=? AND kind=?').get(id, kind) as Event | undefined;
    const assoc = (id: string) => db.prepare('SELECT * FROM customer_email_associations WHERE authority_id=?').get(id) as Association | undefined;
    function row(id: string) {
        const g = db.prepare('SELECT * FROM customer_email_authorities WHERE id=?').get(id) as Authority | undefined;
        if (!g)
            throw new BotError(404, 'Customer email authority not found');
        const {binding_hash, ...original} = g;
        if (!binding_hash || binding_hash !== canonicalSha256(original))
            throw new BotError(409, 'Original corrected authority binding integrity unavailable; historical v1 is not executable');
        return g;
    }
    const projection = (g: Authority) => emailProjection.parse(JSON.parse(g.projection_json));
    function access(a: Actor, g: Authority, executorOnly = false) {
        if (!a.conversationId || !(executorOnly ? [g.executor_id] : [g.source_owner_id, g.executor_id]).includes(a.conversationId))
            throw new BotError(403, 'Original named customer email participant only');
        native.participant(a, g.source_owner_id);
        native.participant(a, g.executor_id);
    }
    function result(g: Authority) {
        const x = assoc(g.id), e = event(g.id, 'reserved'), receipt = x ? db.prepare('SELECT * FROM customer_email_readbacks WHERE association_id=? ORDER BY rowid').all(x.id) : [];
        return {
            execute: false as const, authority_id: g.id, authority: projection(g), authority_hash: canonicalSha256(projection(g)), reservation: e ? {
                claim_id: e.id, ...JSON.parse(e.payload_json)
            } : null, association: x ? {
                id: x.id, intent_id: x.intent_id, request_key: x.request_key
            } : null, revoked: !!event(g.id, 'revoked'), receipts: receipt
        };
    }
    function registration(p: EmailCaptureInput) {
        const r = io.registration(p.registration_id);
        emailRegistrationCurrent(db, r, io.now());
        if (r.sourceOwnerId !== p.source_owner_id || r.executorId !== p.executor_id)
            throw new BotError(403, 'Exact enrolled source owner/executor required');
        return r;
    }
    function usable(g: Authority) {
        if (event(g.id, 'revoked') || Date.parse(projection(g).expiresAt) <= io.now())
            throw new BotError(409, 'Customer email authority revoked or expired; reconcile only');
    }
    function duplicate(n: EmailNativeSnapshot) {
        const recipient = n.payload.recipients[0]!;
        const prior = db.prepare(`SELECT d.id FROM bot_message_drafts d JOIN compose_context_memberships m ON m.conversation_id=d.conversation_id WHERE m.business_id=? AND (d.claim_key IS NOT NULL OR d.receipt IS NOT NULL OR d.state IN ('sending','sent','uncertain')) AND lower(json_extract(d.payload_json,'$.account'))=lower(?) AND json_extract(d.payload_json,'$.channel')='email' AND EXISTS (SELECT 1 FROM json_each(d.payload_json,'$.recipients') WHERE lower(value)=lower(?)) LIMIT 1`).get(n.businessId, n.payload.account, recipient);
        if (prior || db.prepare('SELECT 1 FROM bot_vendor_email_authorities WHERE business_id=? AND lower(account)=lower(?) AND lower(recipient)=lower(?)').get(n.businessId, n.payload.account, recipient))
            throw new BotError(409, 'Existing ordinary/routine/vendor email claim, receipt or uncertain action blocks dispatch');
    }
    async function prepare(a: Actor | null, input: EmailCaptureInput, g?: Authority) {
        const p = emailCaptureInput.parse(Object.fromEntries(Object.keys(emailCaptureInput.shape).map(k => [k, (input as unknown as Record<string, unknown>)[k]]))), r = registration(p);
        let actor = a;
        if (!actor) {
            const user = db.prepare("SELECT * FROM users WHERE id=? AND status='active'").get(r.ownerUserId) as UserRow | undefined;
            if (!user)
                throw new BotError(403, 'Original owner revoked');
            actor = {
                user, conversationId: p.source_owner_id
            };
        }
        const n = native.snapshot(actor, nativeInput(p), actor.conversationId === p.executor_id, g?.id), proof = await io.capture(a, p, n, r);
        proof.assertFresh();
        validateEmailCapture(proof.wire, p, n, r, a?.conversationId === p.source_owner_id ? r.sourcePrincipalId : r.executorPrincipalId, io.now());
        const fresh = () => {
            emailRegistrationCurrent(db, io.registration(r.id), io.now());
            proof.assertFresh();
            const current = native.snapshot(actor!, nativeInput(p), actor!.conversationId === p.executor_id, g?.id);
            if (current.contextRevision !== n.contextRevision || current.inventoryHash !== n.inventoryHash)
                throw new BotError(409, 'Native context changed during source read');
            duplicate(current);
            if (g) {
                const t = projection(g);
                if (t.contextRevision !== current.contextRevision || t.inventoryHash !== canonicalSha256(current.inventory.filter(x => x.key !== current.currentAuthorityKey)) || t.payloadHash !== current.payloadHash || t.registrationHash !== canonicalSha256(r))
                    throw new BotError(409, 'Authority context, inventory, payload or registration changed');
                emailCaptureMatchesProjection(proof.wire, t);
                row(g.id); // Verify full immutable original row, including authority/review/audit pins.
                const accepted = event(g.id, 'accepted');
                if (accepted && JSON.parse(accepted.payload_json).full_review_material_hash !== emailReviewMaterial(proof.wire))
                    throw new BotError(409, 'Full accepted authority record revision/relation/closure or material changed');
                if (emailReviewMaterial(proof.wire, current.currentAuthorityKey) !== t.reviewMaterialHash)
                    throw new BotError(409, 'Reviewed source material, record revision/relation/closure or lease changed');
            }
            return current;
        };
        fresh();
        return {
            n, r, proof, fresh, inspectionHash: canonicalSha256({
                input: nativeInput(p), context: n.contextRevision, inventory: n.inventoryHash, source: n.sourceHash, payload: n.payloadHash, semanticMaterial: emailReviewMaterial(proof.wire), registration: canonicalSha256(r)
            })
        };
    }
    function review(n: EmailNativeSnapshot, w: Awaited<ReturnType<EmailIO['capture']>>['wire'], r: z.infer<typeof emailReview>) {
        const matches = (c: z.infer<typeof emailReview>['instruction'], m: EmailNativeSnapshot['source']) => c.id === m.id && c.kind === m.kind && c.text === m.text;
        if (!matches(r.instruction, n.source))
            throw new BotError(409, 'Full exact original human citation required');
        const later = new Set<string>();
        for (const item of r.later_context) {
            const k = item.citation.kind + ':' + item.citation.id;
            if (later.has(k) || !n.later_human_context.some(m => matches(item.citation, m)) || ['supersedes', 'ambiguous'].includes(item.classification))
                throw new BotError(409, 'Exact later human review contains duplicate, supersession or ambiguity');
            later.add(k);
        }
        if (later.size !== n.later_human_context.length)
            throw new BotError(409, 'Review every later human, voice and correction');
        const records = new Set<string>();
        for (const item of r.records) {
            const source = w.records.find(x => x.key === item.key);
            if (records.has(item.key) || !source || source.revision !== item.revision || source.relation !== item.classification || item.classification === 'blocking')
                throw new BotError(409, 'Complete authenticated native record relation review required');
            records.add(item.key);
        }
        if (records.size !== n.inventory.length)
            throw new BotError(409, 'Review every current native inventory record');
        let end = 0;
        const humans = [...n.context.direct_messages, ...n.context.result_replies, ...n.context.decision_discussion, ...n.context.voice_dispatches, ...n.context.human_decision_events].filter(m => !m.actor_conversation_id);
        for (const part of r.body_parts) {
            if (part.start !== end || part.end <= part.start || part.end > n.payload.body.length || part.human_ids.some(id => !humans.some(m => m.id === id)))
                throw new BotError(409, 'Contiguous full body support from authentic human context required');
            end = part.end;
        }
        if (end !== n.payload.body.length)
            throw new BotError(409, 'Review entire unchanged body');
    }
    function append(a: Actor, g: Authority, kind: string, key: string, payload: unknown, requestHash: string) {
        const old = event(g.id, kind);
        if (old) {
            if (old.request_key !== key || old.request_hash !== requestHash)
                throw new BotError(409, 'Conflicting immutable lifecycle key; original exact lookup only');
            return old;
        }
        const id = crypto.randomUUID();
        db.prepare('INSERT INTO customer_email_events VALUES(?,?,?,?,?,?,?,?,?)').run(id, g.id, kind, a.user.id, a.conversationId, key, requestHash, canonicalJson(payload), stamp());
        return event(g.id, kind)!;
    }
    function inputFor(g: Authority, captureId: string) {
        const saved = JSON.parse(g.native_json) as {
            input: EmailCaptureInput;
        };
        return {
            ...saved.input, capture_id: captureId
        };
    }
    function serviceAccess(id: string, g: Authority) {
        const t = projection(g), r = io.registration(id);
        emailRegistrationCurrent(db, r, io.now());
        if (id !== t.registrationId || canonicalSha256(r) !== t.registrationHash)
            throw new BotError(403, 'Exact original service registration required');
        return r;
    }
    const api = {
        context(a: Actor, raw: unknown) {
            return native.snapshot(a, emailInput.parse(raw));
        },
        async inspect(a: Actor, raw: unknown) {
            const p = emailCaptureInput.parse(raw);
            if (a.conversationId !== p.source_owner_id)
                throw new BotError(403, 'Original source owner only');
            const { n, r, proof, inspectionHash } = await prepare(a, p);
            return {
                execute: false, ready: false, inspection_hash: inspectionHash, review_material_hash: emailReviewMaterial(proof.wire), review_renewal: 'Obtain a new fresh own-reader capture and inspect again. Reuse full semantic review only if inspection_hash and review_material_hash are identical. Bind with the new capture; no older capture is renewed.', native: n, source: proof.wire, registration_hash: canonicalSha256(r)
            };
        },
        async bind(a: Actor, raw: unknown) {
            const p = emailBind.parse(raw);
            if (a.conversationId !== p.source_owner_id)
                throw new BotError(403, 'Original source owner only');
            const old = db.prepare('SELECT * FROM customer_email_authorities WHERE source_owner_id=? AND request_key=?').get(p.source_owner_id, p.request_key) as Authority | undefined;
            if (old) {
                row(old.id);
                access(a, old);
                if (old.request_hash !== canonicalSha256(p))
                    throw new BotError(409, 'Conflicting binding key');
                return result(old);
            }
            if (db.prepare('SELECT 1 FROM customer_email_authorities WHERE draft_id=? OR (source_kind=? AND source_id=?)').get(p.draft_id,p.source_kind,p.source_id))
                throw new BotError(409, 'Permanent original source/action/draft fence already exists; exact original lookup only');
            const { n, r, proof, fresh, inspectionHash } = await prepare(a, p);
            return db.transaction(() => {
                fresh();
                if (inspectionHash !== p.inspection_hash)
                    throw new BotError(409, 'Inspection changed');
                review(n, proof.wire, p.review);
                const w = proof.wire, actionFence = canonicalSha256({
                    business: r.businessId, sourceOwner: p.source_owner_id, sourceKind: p.source_kind, sourceId: p.source_id, action: 'customer-email-direction'
                });
                if (db.prepare('SELECT 1 FROM customer_email_authorities WHERE action_fence=? OR draft_id=? OR (source_kind=? AND source_id=?)').get(actionFence, p.draft_id, p.source_kind, p.source_id))
                    throw new BotError(409, 'Permanent original source/action/draft fence already exists');
                const id = crypto.randomUUID(), actionId = crypto.randomUUID();
                const t = emailProjection.parse({
                    schemaVersion: EMAIL_CONTRACT, authorityId: id, actionId, actionFence, registrationId: r.id, registrationHash: canonicalSha256(r), contractHash: EMAIL_CONTRACT_HASH, sourceRegistrationHash: r.sourceRegistrationHash, guardManifestHash: r.guardManifestHash, sourceArtifactHash: r.sourceArtifactHash, nativeArtifactHash: r.nativeArtifactHash, businessId: r.businessId, sourceOwnerId: p.source_owner_id, sourceKind: p.source_kind, sourceId: p.source_id, sourceHash: n.sourceHash, contextRevision: n.contextRevision, inventoryHash: n.inventoryHash, executorId: p.executor_id, executorPrincipalId: r.executorPrincipalId, draftId: p.draft_id, draftVersion: p.draft_version, payload: n.payload, payloadHash: n.payloadHash, reviewMaterialHash: emailReviewMaterial(w), canonicalCaseId: w.canonicalCaseId, canonicalCustomerId: w.canonicalCustomerId, canonicalOrderId: w.canonicalOrderId, orderNumber: w.orderNumber, shopifyOrderId: w.shopifyOrderId, sourceAccountId: r.sourceAccountId, materialHash: w.materialHash, scopeHash: w.scopeHash, identityHash: w.identityHash, crossActionFenceHash: w.crossActionFenceHash, idempotencyKey: `customer-email:${actionId}`, expiresAt: new Date(Math.min(io.now() + 30 * 60000, ...[r.expiresAt, r.credentialExpiresAt, r.custodyExpiresAt, r.readbackExpiresAt].map(Date.parse))).toISOString()
                });
                const record = {id, action_id:actionId, action_fence:actionFence, source_owner_id:p.source_owner_id,
                    source_kind:p.source_kind, source_id:p.source_id, executor_id:p.executor_id, draft_id:p.draft_id,
                    business_id:r.businessId, account:n.payload.account, recipient:n.payload.recipients[0]!, request_key:p.request_key,
                    request_hash:canonicalSha256(p), projection_json:canonicalJson(t), native_json:canonicalJson({
                    input: emailCaptureInput.parse(Object.fromEntries(Object.keys(emailCaptureInput.shape).map(k => [k, (p as unknown as Record<string, unknown>)[k]]))), contextRevision: n.contextRevision, inventoryHash: n.inventoryHash, source: n.source, native: n, source_capture: proof.wire
                }), review_json:canonicalJson(p.review), created_at:stamp()};
                const keys=Object.keys(record);
                db.prepare(`INSERT INTO customer_email_authorities(${keys.join(',')},binding_hash) VALUES(${keys.map(()=>'?').join(',')},?)`)
                    .run(...Object.values(record), canonicalSha256(record));
                return result(row(id));
            }).immediate();
        },
        read(a: Actor, raw: unknown) {
            const p = z.object({
                authority_id: emailId
            }).strict().parse(raw), g = row(p.authority_id);
            access(a, g);
            return result(g);
        },
        lookup(a: Actor, raw: unknown) {
            const p = emailLookup.parse(raw);
            if (a.conversationId !== p.source_owner_id)
                throw new BotError(403, 'Original source owner lookup only');
            const g = db.prepare('SELECT * FROM customer_email_authorities WHERE source_owner_id=? AND source_kind=? AND source_id=? AND draft_id=? AND request_key=?').get(p.source_owner_id, p.source_kind, p.source_id, p.draft_id, p.request_key) as Authority | undefined;
            if (!g) {
                native.participant(a, p.source_owner_id);
                return {
                    execute: false, found: false
                };
            }
            access(a, g);
            return result(g);
        },
        async accept(a: Actor, raw: unknown) {
            return consume(a, raw, 'accepted');
        }, async claim(a: Actor, raw: unknown) {
            return consume(a, raw, 'reserved');
        },
        revoke(a: Actor, raw: unknown) {
            const p = z.object({
                authority_id: emailId, request_key: emailKey, reason: z.string().min(20).max(3000)
            }).strict().parse(raw), g = row(p.authority_id);
            access(a, g);
            if (a.conversationId !== g.source_owner_id)
                throw new BotError(403, 'Original source owner revocation only');
            return db.transaction(() => {
                append(a, g, 'revoked', p.request_key, {
                    reason: p.reason
                }, canonicalSha256(p));
                return result(g);
            }).immediate();
        },
        serviceAuthority(registrationId: string, id: string) {
            const g = row(emailId.parse(id));
            serviceAccess(registrationId, g);
            return {
                execute: false, authority: projection(g), authority_hash: canonicalSha256(projection(g))
            };
        },
        serviceContext(registrationId: string, id: string) {
            const g = row(emailId.parse(id)), r = serviceAccess(registrationId, g), user = db.prepare('SELECT * FROM users WHERE id=?').get(r.ownerUserId) as UserRow;
            const p = inputFor(g, JSON.parse(g.native_json).input.capture_id);
            const n = native.snapshot({
                user, conversationId: r.sourceOwnerId
            }, nativeInput(p), false, g.id);
            return {
                execute: false, authority_id: g.id, context_revision: n.contextRevision, inventory_hash: n.inventoryHash, records: n.inventory, unreviewed_media: n.unreviewedMedia, complete: true
            };
        },
        async associate(registrationId: string, raw: unknown) {
            const p = emailAssociation.parse(raw), g = row(p.authority_id), r = serviceAccess(registrationId, g), existing = assoc(g.id);
            if (existing) {
                if (existing.request_hash !== canonicalSha256(p))
                    throw new BotError(409, 'Conflicting association; original exact lookup only');
                return {
                    execute: false, dispatchEntitlement: false, association_id: existing.id
                };
            }
            const t = projection(g), prepared = await prepare(null, inputFor(g, p.capture_id), g), wire = emailIntent.parse(await io.intent(r, p.intent_id));
            return db.transaction(() => {
                prepared.fresh();
                usable(g);
                serviceAccess(registrationId, g);
                const e = event(g.id, 'reserved');
                if (!e || e.id !== p.claim_id || p.authority_hash !== canonicalSha256(t) || p.context_revision !== t.contextRevision)
                    throw new BotError(409, 'Exact original reservation and authority required');
                checkIntent(wire, t, p.claim_id, p.intent_id, p.request_key);
                if (wire.state !== 'association_requested' || wire.associationId !== null || wire.preProviderCommitted || wire.receipt !== null)
                    throw new BotError(409, 'Persisted unattempted original association request required');
                if (assoc(g.id))
                    throw new BotError(409, 'Action already consumed');
                const id = crypto.randomUUID();
                db.prepare('INSERT INTO customer_email_associations VALUES(?,?,?,?,?,?,?,?)').run(id, g.id, r.id, p.intent_id, p.request_key, canonicalSha256(p), canonicalJson({
                    input: p, source_intent: wire, source_capture: prepared.proof.wire
                }), stamp());
                return {
                    execute: false, dispatchEntitlement: true, association_id: id, authority_hash: canonicalSha256(t), idempotency_key: t.idempotencyKey, instructions: 'Only this first response entitles the accepted source to its exact durable intent. Persist pre-provider dispatch marker before one invocation. Lost response is UNKNOWN and never replayable.'
                };
            }).immediate();
        },
        serviceAssociation(registrationId: string, raw: unknown) {
            const p = z.object({
                authority_id: emailId, intent_id: emailId, request_key: emailKey
            }).strict().parse(raw), g = row(p.authority_id);
            serviceAccess(registrationId, g);
            const x = assoc(g.id);
            if (!x || x.intent_id !== p.intent_id || x.request_key !== p.request_key)
                throw new BotError(404, 'Exact original association not found');
            return {
                execute: false, dispatchEntitlement: false, association_id: x.id, binding: JSON.parse(x.binding_json)
            };
        },
        async receipt(a: Actor, raw: unknown) {
            const p = z.object({
                authority_id: emailId, claim_id: emailId
            }).strict().parse(raw), g = row(p.authority_id);
            access(a, g, true);
            const claim = event(g.id, 'reserved');
            if (claim?.id !== p.claim_id)
                throw new BotError(403, 'Original exact reservation required');
            await reconcile(g);
            return result(g);
        },
        async serviceReadback(registrationId: string, id: string) {
            const g = row(emailId.parse(id));
            serviceAccess(registrationId, g);
            await reconcile(g);
            return {
                execute: false, dispatchEntitlement: false, association_id: assoc(g.id)?.id, receipts: result(g).receipts
            };
        },
    };
    async function consume(a: Actor, raw: unknown, kind: 'accepted' | 'reserved') {
        const p = emailConsume.parse(raw), g = row(p.authority_id);
        access(a, g, true);
        const old = event(g.id, kind);
        if (old) {
            if (old.request_key !== p.request_key || old.request_hash !== canonicalSha256(p))
                throw new BotError(409, 'Conflicting lifecycle request; reconcile exact original action');
            return result(g);
        }
        const prepared = await prepare(a, inputFor(g, p.capture_id), g);
        return db.transaction(() => {
            prepared.fresh();
            usable(g);
            if (p.payload_hash !== projection(g).payloadHash || (kind === 'reserved' && !event(g.id, 'accepted')))
                throw new BotError(409, 'Exact acceptance and full payload required');
            append(a, g, kind, p.request_key, {
                payload_hash: p.payload_hash, capture_id: p.capture_id, idempotency_key: projection(g).idempotencyKey, full_review_material_hash: emailReviewMaterial(prepared.proof.wire)
            }, canonicalSha256(p));
            return result(g);
        }).immediate();
    }
    function checkIntent(w: z.infer<typeof emailIntent>, t: EmailProjection, claim: string, intent: string, key: string) {
        const r = io.registration(t.registrationId);
        if (w.registrationId !== r.id || w.principalId !== r.executorPrincipalId || canonicalJson(w.runtime) !== canonicalJson(r.runtime) || w.authorityId !== t.authorityId || w.authorityHash !== canonicalSha256(t) || w.claimId !== claim || w.intentId !== intent || w.requestKey !== key || w.idempotencyKey !== t.idempotencyKey || w.payloadHash !== t.payloadHash || w.contextRevision !== t.contextRevision || w.materialHash !== t.materialHash)
            throw new BotError(409, 'Authenticated exact original source intent mismatch');
    }
    async function reconcile(g: Authority) {
        const x = assoc(g.id);
        if (!x)
            throw new BotError(409, 'No association; do not dispatch from readback');
        const r = serviceAccess(x.registration_id, g), t = projection(g), claim = event(g.id, 'reserved')!;
        const w = emailIntent.parse(await io.intent(r, x.intent_id));
        return db.transaction(() => {
            serviceAccess(x.registration_id, g);
            checkIntent(w, t, claim.id, x.intent_id, x.request_key);
            if (w.associationId !== x.id)
                throw new BotError(409, 'Exact source association readback required');
            if (!['UNKNOWN', 'NO_EFFECT', 'SENT_ACCEPTED'].includes(w.state))
                return {
                    execute: false, state: 'pending'
                };
            if (w.state === 'SENT_ACCEPTED') {
                const receipt = w.receipt;
                if (!w.preProviderCommitted || !receipt || receipt.account !== t.payload.account || receipt.recipient !== t.payload.recipients[0] || receipt.subject !== t.payload.subject || receipt.body !== t.payload.body || receipt.payloadHash !== t.payloadHash || receipt.idempotencyKey !== t.idempotencyKey || Date.parse(receipt.acceptedAt) > io.now() + 5000)
                    throw new BotError(409, 'Exact authenticated real provider acceptance required');
            }
            else if (w.receipt !== null)
                throw new BotError(409, 'Uncertain/no-effect receipt conflict');
            const hash = canonicalSha256(w), prior = db.prepare('SELECT * FROM customer_email_readbacks WHERE association_id=?').all(x.id) as {
                state: string;
                evidence_hash: string;
            }[];
            if (prior.some(p => p.state === 'SENT_ACCEPTED' && p.evidence_hash !== hash))
                throw new BotError(409, 'Conflicting accepted receipt');
            if (!prior.some(p => p.evidence_hash === hash))
                db.prepare('INSERT INTO customer_email_readbacks VALUES(?,?,?,?,?,?)').run(crypto.randomUUID(), x.id, w.state, hash, canonicalJson(w), stamp());
            return {
                execute: false, state: w.state
            };
        }).immediate();
    }
    return api;
}
