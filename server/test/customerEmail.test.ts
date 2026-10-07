import { customerEmailPrebind, EMAIL_PREBIND_CONTRACT_HASH, emailPrebindResponse, retainedEmailLocators } from '../src/bots/customerEmailPrebind.js';
import {createBotService,proposalSchema} from '../src/bots/service.js';
import {approvedMessageSchema} from '../src/bots/draftPayload.js';
import {messageDelegationService} from '../src/bots/messageDelegation.js';
import {routinePolicyService} from '../src/bots/routinePolicies.js';
import {routineExecutionService,routineCaptureSchema} from '../src/bots/routineExecution.js';
import {vendorEmailService,vendorEmailScope,vendorEmailReview,vendorEmailCheck} from '../src/bots/vendorEmail.js';
import { CUSTOMER_EMAIL_NATIVE_ARTIFACT_HASH, CUSTOMER_EMAIL_NATIVE_ARTIFACT_FILES } from '../src/bots/customerEmailArtifact.js';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import type { Server } from 'node:http';
import { migrate } from '../src/db/migrate.js';
import { customerEmailService } from '../src/bots/customerEmail.js';
import { customerEmailNative } from '../src/bots/customerEmailNative.js';
import { emailEnrollment, emailBearer, loadEmailRegistry, emailRegistrationCurrent } from '../src/bots/customerEmailTrust.js';
import { customerEmailRoutes, customerEmailVerifierRoutes } from '../src/bots/customerEmailRoutes.js';
import { canonicalSha256 } from '../src/bots/canonical.js';
import { EMAIL_CONTRACT_HASH, emailRegistration, emailCapture, emailIntent, type EmailRegistration } from '../src/bots/customerEmailContract.js';
import {validateEmailReadWindow, type EmailIO} from '../src/bots/customerEmailIO.js';
import type { Actor } from '../src/bots/service.js';
import type { UserRow } from '../src/db/db.js';
import type { AppContext } from '../src/context.js';
import { communicationService } from '../src/bots/communication.js';
import { BOT_TOOL_DEFINITIONS, callBotTool } from '../src/mcp/botTools.js';
import { botFeatureCatalog } from '../src/featureGuide/catalog.js';
import { coreVeneerRules } from '../src/instructions/context.js';
import { employeeRouteAllowed } from '../src/bots/employeeAccess.js';
const uuid = () => crypto.randomUUID(), hash = () => 'a'.repeat(64), explain = 'All exact fixture context and supported original composition/send scope were reviewed.';
describe('staged native customer email direction', () => {
    let db: Database.Database, s: ReturnType<typeof customerEmailService>, io: EmailIO, r: EmailRegistration, a: Actor, grant: Actor, owner: string, executor: string, other: string, source: string, draft: string, now: number;
    let wireIntent: ReturnType<typeof emailIntent.parse> | null, alter: (w: Record<string, unknown>) => void, sourceFresh: boolean, sourceError: boolean;
    const servers: Server[] = [];
    const input = () => ({
        source_owner_id: owner, executor_id: executor, source_kind: 'direct_message' as const, source_id: source, draft_id: draft, draft_version: 1
    });
    const captureInput = () => ({
        ...input(), registration_id: r.id, capture_id: uuid(), canonical_case: caseId, canonical_customer: customerId, canonical_order: orderId
    });
    let caseId: string, customerId: string, orderId: string;
    function human(id: string, text: string, chat = owner, time = new Date(now + 1000).toISOString()) {
        db.prepare('INSERT INTO bot_human_messages VALUES(?,?,?,?,?,?)').run(id, chat, 2, text, '[]', time);
    }
    beforeEach(() => {
        db = new Database(':memory:');
        db.pragma('foreign_keys=ON');
        migrate(db, fileURLToPath(new URL('../src/db/migrations', import.meta.url)));
        now = Date.parse('2026-10-06T18:00:00Z');
        owner = uuid();
        executor = uuid();
        other = uuid();
        source = uuid();
        caseId = uuid();
        customerId = uuid();
        orderId = uuid();
        for (const id of [1, 2])
            db.prepare("INSERT INTO users(id,email,display_name,role) VALUES(?,?,?,'owner')").run(id, `fixture${id}@example.test`, `Person ${id}`);
        const business = uuid();
        db.prepare('INSERT INTO business_teams(id,name,owner_id) VALUES(?,?,1)').run(business, 'Fixture');
        db.prepare("INSERT INTO business_team_members(team_id,user_id,role) VALUES(?,2,'manager')").run(business);
        for (const id of [owner, executor, other]) {
            db.prepare("INSERT INTO conversations(id,assistant_id,user_id,title,provider,native_session_id,visibility,business_team_id) VALUES(?,1,1,?,'claude',?,'team',?)").run(id, id, id, business);
            db.prepare('INSERT INTO bot_registrations(conversation_id,name,active,registered_by) VALUES(?,?,1,1)').run(id, id);
        }
        a = {
            user: db.prepare('SELECT * FROM users WHERE id=1').get() as UserRow, conversationId: owner
        };
        grant = {
            ...a, conversationId: executor
        };
        human(source, 'Compose and send a customer email asking for a new shipping address before supplier placement.', owner, new Date(now - 1000).toISOString());
        const p = {
            channel: 'email', account: 'help@example.test', recipients: ['customer@example.test'], subject: 'New shipping address needed for order #123', body: 'Hi Customer,\nPlease reply with a different complete shipping address before we place your supplier order.\nGrant', attachments: [], customer: 'Descriptive customer', ticket: 'Descriptive order, not a case', context: 'Unapproved original draft'
        };
        draft = communicationService(db).saveDraft(grant, executor, 'fixture-draft', p).id;
        const credential = (name: string) => ({
            project: 'fixture', config: 'fixture', name
        });
        r = emailRegistration.parse({
            schemaVersion: 'customer-email-registration/v1', id: uuid(), revision: 1, active: true, businessId: business, ownerUserId: 1, sourceOwnerId: owner, executorId: executor, executorUserId: 1, sourcePrincipalId: 'fixture:sage', executorPrincipalId: 'fixture:grant', sourceAccountId: 'fixture-account', payloadAccount: p.account, sourceOrigin: 'https://orderops-dev-web-production.up.railway.app', runtime: {
                projectId: uuid(), environmentId: uuid(), serviceId: uuid()
            }, sourceCredential: credential('SAGE'), executorCredential: credential('GRANT'), serviceReadCredential: credential('SERVICE'), servicePrincipalId: 'fixture:service', serviceBearerHash: crypto.createHash('sha256').update('fixture-service-token-'.repeat(3)).digest('hex'), nativeAudience: 'dedicated-email-aud', cfClientId: 'dedicated-email-client', contractHash: EMAIL_CONTRACT_HASH, sourceArtifactHash: hash(), nativeArtifactHash: CUSTOMER_EMAIL_NATIVE_ARTIFACT_HASH, guardManifestHash: hash(), sourceRegistrationHash: hash(), custodyReceipt: 'fixture-custody', acceptanceReceipt: 'fixture-adoption', expiresAt: new Date(now + 86400000).toISOString(), credentialExpiresAt: new Date(now + 86400000).toISOString(), readbackExpiresAt: new Date(now + 86400000).toISOString(), custodyExpiresAt: new Date(now + 86400000).toISOString(), acceptedAt: new Date(now - 10000).toISOString()
        });
        db.prepare('INSERT INTO customer_email_enrollments VALUES(?,?,?,?,?,?)').run(r.id, canonicalSha256(r), 1, 'fixture-enrollment', JSON.stringify(r), new Date(now).toISOString());
        wireIntent = null;
        alter = () => {
        };
        sourceFresh = true;
        sourceError = false;
        io = {
            now: () => now, registration: () => r, async capture(actor, p, n) {
                if (sourceError)
                    throw Error('Fixture source unavailable');
                const raw: Record<string, unknown> = {
                    schemaVersion: 'customer-email-capture/v2', captureId: p.capture_id, registrationId: r.id, registrationHash: canonicalSha256(r), sourceRegistrationHash: r.sourceRegistrationHash, guardManifestHash: r.guardManifestHash, sourceArtifactHash: r.sourceArtifactHash, runtime: r.runtime, businessId: r.businessId, accountId: r.sourceAccountId, principalId: actor?.conversationId === owner ? r.sourcePrincipalId : r.executorPrincipalId, executorPrincipalId: r.executorPrincipalId, observedAt: new Date(now).toISOString(), expiresAt: new Date(now + 15000).toISOString(), complete: true, unreviewedMedia: [], canonicalCaseId: p.canonical_case, canonicalCustomerId: p.canonical_customer, canonicalOrderId: p.canonical_order, orderNumber: '123', shopifyOrderId: 'fixture123', caseOwnerPrincipalId: r.executorPrincipalId, leaseId: 'fixture-lease', leaseExpiresAt: new Date(Date.parse(r.acceptedAt) + 900000).toISOString(), payloadHash: n.payloadHash, payloadAccount: n.payload.account, recipient: n.payload.recipients[0], materialHash: hash(), scopeHash: hash(), identityHash: hash(), contextRevision: n.contextRevision, inventoryHash: n.inventoryHash, records: n.inventory.map(x => ({
                        ...x, relation: x.key === `draft:${p.draft_id}` || x.key === n.currentAuthorityKey ? 'current_action' : n.completedActionKeys.includes(x.key) ? 'completed_action' : 'unrelated', closureHash: hash()
                    })), suppression: 'clear', duplicates: 'clear', ownership: 'exclusive', crossActionFenceHash: hash(), sourceMaterial: {
                        fixture: 'complete canonical evidence'
                    }
                };
                alter(raw);
                raw.snapshotHash = canonicalSha256(raw);
                return {
                    wire: emailCapture.parse(raw), assertFresh: () => {
                        if (!sourceFresh)
                            throw Error('Fixture evidence expired');
                    }
                };
            }, async intent() {
                if (sourceError)
                    throw Error('Fixture readback unavailable');
                return wireIntent;
            }
        };
        s = customerEmailService(db, io);
    });
    afterEach(async () => {
        for (const server of servers.splice(0))
            await new Promise<void>(done => server.close(() => done()));
        db.close();
    });
    async function prepared() {
        const p = captureInput(), i = await s.inspect(a, p);
        return {
            ...p, inspection_hash: i.inspection_hash, request_key: 'bind-once', review: {
                reviewed_full_context: true as const, interpretation: 'unconditional_compose_and_send' as const, instruction: {
                    kind: i.native.source.kind, id: i.native.source.id, text: i.native.source.text
                }, composition_explanation: explain, send_explanation: explain, later_context: i.native.later_human_context.map(m => ({
                    citation: {
                        kind: m.kind, id: m.id, text: m.text
                    }, classification: 'status_only' as const, explanation: explain
                })), records: i.source.records.map(m => ({
                    key: m.key, revision: m.revision, classification: m.relation as 'unrelated' | 'current_action' | 'completed_action', explanation: explain
                })), body_parts: [{
                        start: 0, end: i.native.payload.body.length, human_ids: [source], evidence: explain
                    }], unresolved_choices: []
            }
        };
    }
    async function setup() {
        const p = await prepared(), g = await s.bind(a, p);
        return {
            p, g, id: g.authority_id
        };
    }
    const consume = (id: string, key: string) => ({
        authority_id: id, capture_id: uuid(), request_key: key, payload_hash: s.read(grant, {
            authority_id: id
        }).authority.payloadHash
    });
    async function reserve(id: string) {
        await s.accept(grant, consume(id, 'accept'));
        return s.claim(grant, consume(id, 'claim'));
    }
    async function association(id: string) {
        const read = s.read(grant, {
            authority_id: id
        }), t = read.authority, claim = read.reservation!.claim_id, intent = uuid(), request_key = 'association-once';
        wireIntent = emailIntent.parse({
            schemaVersion: 'customer-email-intent/v1', registrationId: r.id, principalId: r.executorPrincipalId, runtime: r.runtime, intentId: intent, authorityId: id, authorityHash: canonicalSha256(t), claimId: claim, requestKey: request_key, idempotencyKey: t.idempotencyKey, payloadHash: t.payloadHash, contextRevision: t.contextRevision, materialHash: t.materialHash, state: 'association_requested', preProviderCommitted: false, associationId: null, receipt: null
        });
        return {
            authority_id: id, claim_id: claim, intent_id: intent, request_key, authority_hash: canonicalSha256(t), context_revision: t.contextRevision, capture_id: uuid()
        };
    }
    it('reads source independently of withdrawn purchase decisions, preserves draft and retirement audit', async () => {
        const withdrawn = uuid();
        db.prepare("INSERT INTO bot_decisions(id,conversation_id,source_key,proposal_key,state,proposal_json,assignee_id,answer_json) VALUES(?,?,?,?,'decided',?,2,?)").run(withdrawn, owner, 'fixture-purchase', 'fixture-withdrawn', JSON.stringify({
            question: 'Purchase held pending new address', recommendation: 'Keep Addresshold'
        }), JSON.stringify({
            action: 'withdraw', actor_id: 1
        }));
        const withdrawnBefore = db.prepare('SELECT * FROM bot_decisions WHERE id=?').get(withdrawn);
        const old = communicationService(db).saveDraft(grant, executor, 'retired-fixture', {
            ...s.context(a, input()).payload, body: 'Superseded billing request'
        });
        communicationService(db).retire(grant, old.id, {
            expected_version: 1, request_key: 'retire', reason: explain, evidence: explain
        });
        const draftBefore = db.prepare('SELECT * FROM bot_message_drafts WHERE id=?').get(draft), audit = db.prepare('SELECT * FROM bot_message_retirements WHERE draft_id=?').get(old.id);
        const { p, g, id } = await setup();
        expect(g.execute).toBe(false);
        expect((await s.bind(a, p)).authority_id).toBe(id);
        expect(db.prepare('SELECT * FROM bot_message_drafts WHERE id=?').get(draft)).toEqual(draftBefore);
        expect(db.prepare('SELECT * FROM bot_message_retirements WHERE draft_id=?').get(old.id)).toEqual(audit);
        expect(db.prepare('SELECT count(*) n FROM bot_conversational_answers').get()).toEqual({
            n: 0
        });
        expect(db.prepare('SELECT * FROM bot_decisions WHERE id=?').get(withdrawn)).toEqual(withdrawnBefore);
    });
    it('original Grant reserves execute=false; only first durable service association entitles one source intent', async () => {
        const { id } = await setup(), reserved = await reserve(id);
        expect(reserved.execute).toBe(false);
        expect(reserved.reservation!.claim_id).toBeTruthy();
        const p = await association(id), first = await s.associate(r.id, p);
        expect(first.dispatchEntitlement).toBe(true);
        expect(first.execute).toBe(false);
        expect(db.prepare('SELECT count(*) n FROM customer_email_associations').get()).toEqual({
            n: 1
        });
        expect((await s.associate(r.id, p)).dispatchEntitlement).toBe(false);
        expect(s.serviceAssociation(r.id, {
            authority_id: id, intent_id: p.intent_id, request_key: p.request_key
        }).dispatchEntitlement).toBe(false);
        await expect(s.associate(r.id, {
            ...p, request_key: 'new-key'
        })).rejects.toThrow('Conflicting');
    });
    it('lost association response, UNKNOWN, provider timeout and receipt-save loss never enable resend', async () => {
        const { id } = await setup();
        await reserve(id);
        const p = await association(id), x = await s.associate(r.id, p);
        wireIntent = {
            ...wireIntent!, state: 'UNKNOWN', preProviderCommitted: true, associationId: x.association_id
        };
        expect((await s.receipt(grant, {
            authority_id: id, claim_id: p.claim_id
        })).execute).toBe(false);
        expect((await s.associate(r.id, p)).dispatchEntitlement).toBe(false);
        sourceError = true;
        await expect(s.receipt(grant, {
            authority_id: id, claim_id: p.claim_id
        })).rejects.toThrow();
        sourceError = false;
        expect((await s.associate(r.id, p)).dispatchEntitlement).toBe(false);
        expect(() => s.serviceAssociation(r.id, {
            authority_id: id, intent_id: p.intent_id, request_key: 'changed'
        })).toThrow();
    });
    it('fetches exact positive provider acceptance read-only, rejects forged/mismatched proof and preserves UNKNOWN', async () => {
        const { id } = await setup();
        await reserve(id);
        const p = await association(id), x = await s.associate(r.id, p), t = s.read(grant, {
            authority_id: id
        }).authority;
        wireIntent = {
            ...wireIntent!, state: 'UNKNOWN', preProviderCommitted: true, associationId: x.association_id
        };
        await s.receipt(grant, {
            authority_id: id, claim_id: p.claim_id
        });
        const receipt = {
            provider: 'gmail' as const, providerMessageId: 'fixture-provider', messageId: 'fixture-message-id', account: t.payload.account, recipient: t.payload.recipients[0]!, subject: t.payload.subject, body: t.payload.body, attachments: [], cc: [], bcc: [], acceptedAt: new Date(now).toISOString(), payloadHash: t.payloadHash, idempotencyKey: t.idempotencyKey
        };
        wireIntent = {
            ...wireIntent, state: 'SENT_ACCEPTED', receipt: {
                ...receipt, body: 'Different'
            }
        };
        await expect(s.receipt(grant, {
            authority_id: id, claim_id: p.claim_id
        })).rejects.toThrow('Exact authenticated');
        wireIntent = {
            ...wireIntent, receipt
        };
        const read = await s.receipt(grant, {
            authority_id: id, claim_id: p.claim_id
        });
        expect(read.receipts).toHaveLength(2);
        await s.receipt(grant, {
            authority_id: id, claim_id: p.claim_id
        });
        expect(s.read(grant, {
            authority_id: id
        }).receipts).toHaveLength(2);
        expect((await s.associate(r.id, p)).dispatchEntitlement).toBe(false);
        await expect(s.receipt(grant, {
            authority_id: id, claim_id: p.claim_id, provider_id: 'forged'
        })).rejects.toThrow();
    });
    it('NO_EFFECT and revoked/expired reservations retain all action/source/recipient fences', async () => {
        const { id, p: originalBind } = await setup();
        await reserve(id);
        const p = await association(id), x = await s.associate(r.id, p);
        wireIntent = {
            ...wireIntent!, state: 'NO_EFFECT', associationId: x.association_id
        };
        await s.receipt(grant, {
            authority_id: id, claim_id: p.claim_id
        });
        s.revoke(a, {
            authority_id: id, request_key: 'revoke', reason: explain
        });
        now += 3600000;
        expect((await s.associate(r.id, p)).dispatchEntitlement).toBe(false);
        await expect(s.bind(a, {
            ...originalBind, request_key: 'replacement'
        })).rejects.toThrow('fence');
    });
    it('requires original source and every later human/result/voice/correction and all exact body spans', async () => {
        human(uuid(), 'What is the status?');
        const p = await prepared();
        p.review.later_context = [];
        await expect(s.bind(a, p)).rejects.toThrow('every later');
        const q = await prepared();
        q.review.instruction.text = 'Send';
        await expect(s.bind(a, q)).rejects.toThrow('Full exact');
        const v = await prepared();
        v.review.body_parts[0]!.end--;
        await expect(s.bind(a, v)).rejects.toThrow('entire');
        const x = await prepared();
        (x.review.later_context[0] as {
            classification: string;
        }).classification = 'supersedes';
        await expect(s.bind(a, x)).rejects.toThrow('supersession');
    });
    it.each(['status_only', 'wording_edit', 'conditional', 'quoted', 'ambiguous'])('rejects %s as semantic compose-and-send authority', async (mode) => {
        const p = await prepared();
        await expect(s.bind(a, {
            ...p, review: {
                ...p.review, interpretation: mode
            }
        })).rejects.toThrow();
    });
    it.each(['source', 'executor', 'author', 'registration', 'membership', 'business', 'archive'])('fresh %s revocation blocks acceptance/association', async (what) => {
        const { id } = await setup(), request = consume(id, 'accept');
        if (what === 'source' || what === 'executor')
            db.prepare('UPDATE bot_registrations SET active=0 WHERE conversation_id=?').run(what === 'source' ? owner : executor);
        if (what === 'author')
            db.prepare("UPDATE users SET status='disabled' WHERE id=2").run();
        if (what === 'registration')
            r = {
                ...r, active: false
            };
        if (what === 'membership')
            db.prepare('DELETE FROM business_team_members WHERE user_id=2').run();
        if (what === 'business')
            db.prepare('UPDATE conversations SET business_team_id=NULL WHERE id=?').run(executor);
        if (what === 'archive')
            db.prepare('UPDATE conversations SET archived=1 WHERE id=?').run(owner);
        await expect(s.accept(grant, request)).rejects.toThrow();
    });
    it.each(['version', 'body', 'subject', 'account', 'recipient', 'context', 'customer', 'ticket'])('rejects full draft %s drift', async (what) => {
        const { id } = await setup();
        const d = db.prepare('SELECT payload_json FROM bot_message_drafts WHERE id=?').get(draft) as {
            payload_json: string;
        };
        if (what === 'version')
            db.prepare('UPDATE bot_message_drafts SET version=version+1 WHERE id=?').run(draft);
        else {
            const p = JSON.parse(d.payload_json);
            p[what === 'recipient' ? 'recipients' : what] = what === 'recipient' ? ['other@example.test'] : String(p[what]) + 'x';
            db.prepare('UPDATE bot_message_drafts SET payload_json=? WHERE id=?').run(JSON.stringify(p), draft);
        }
        await expect(s.accept(grant, consume(id, 'accept'))).rejects.toThrow();
    });
    it.each(['canonicalCaseId', 'canonicalCustomerId', 'canonicalOrderId', 'principalId', 'caseOwnerPrincipalId', 'payloadHash', 'contextRevision', 'inventoryHash', 'guardManifestHash', 'registrationHash', 'leaseExpiresAt', 'complete'])('rejects unauthenticated or incomplete source %s', async (field) => {
        alter = w => {
            w[field] = field === 'complete' ? false : field === 'leaseExpiresAt' ? new Date(now - 1).toISOString() : field.includes('Id') ? uuid() : hash().replace(/^a/, 'b');
        };
        await expect(s.inspect(a, captureInput())).rejects.toThrow();
    });
    it('does not guess canonical scope or dismiss unknown and overlapping holds', async () => {
        alter = w => {
            const xs = w.records as {
                relation: string;
            }[];
            xs[0]!.relation = 'unknown';
        };
        await expect(s.inspect(a, captureInput())).rejects.toThrow('blocking');
        alter = () => {
        };
        const p = await prepared();
        p.review.records = [];
        await expect(s.bind(a, p)).rejects.toThrow('every current');
        const invalid = {
            ...captureInput(), canonical_case: 'Order #123; no matching CS case'
        };
        await expect(s.inspect(a, invalid)).rejects.toThrow();
    });
    it('blocks missing media and capped chronology without native transcript bypass', async () => {
        human(uuid(), 'See ![customer photo](/uploads/photo.png)');
        await expect(s.inspect(a, captureInput())).rejects.toThrow('media');
        expect(s.context(a, input()).unreviewedMedia).toHaveLength(1);
    });
    it('rejects builder, human, other bot, forwarded bot result and substitute executor', async () => {
        const p = await prepared();
        await expect(s.bind({
            ...a, conversationId: other
        }, p)).rejects.toThrow();
        await expect(s.bind({
            user: a.user
        }, p)).rejects.toThrow();
        await expect(s.accept(a, {
            authority_id: (await s.bind(a, p)).authority_id, capture_id: uuid(), request_key: 'no', payload_hash: hash()
        })).rejects.toThrow('participant');
        expect(() => s.context(a, {
            ...input(), source_id: uuid()
        })).toThrow('authenticated');
    });
    it('retains full result anchors and shared voice, never caller-private voice', async () => {
        const thread = uuid(), reply = uuid();
        db.prepare('INSERT INTO bot_message_threads(id,conversation_id,anchor,source_text) VALUES(?,?,?,?)').run(thread, owner, 'fixture-anchor', 'Exact original result payload');
        db.prepare('INSERT INTO bot_message_replies(id,thread_id,actor_id,text,request_key,created_at) VALUES(?,?,2,?,?,?)').run(reply, thread, 'Compose and send the exact address request', 'reply-key', new Date(now).toISOString());
        const ctx = s.context(a, {
            ...input(), source_kind: 'result_reply', source_id: reply
        });
        expect(ctx.context.result_replies[0]).toMatchObject({
            source_text: 'Exact original result payload'
        });
        expect(ctx.coverage.caller_private_voice).toBe(false);
        db.prepare('INSERT INTO bot_message_replies(id,thread_id,actor_id,actor_conversation_id,text,request_key) VALUES(?,?,1,?,?,?)').run(uuid(), thread, owner, 'Reported human consent', 'bot-reply');
        const bot = db.prepare('SELECT id FROM bot_message_replies WHERE actor_conversation_id IS NOT NULL').get() as {
            id: string;
        };
        expect(() => s.context(a, {
            ...input(), source_kind: 'result_reply', source_id: bot.id
        })).toThrow('authenticated');
    });
    it('preserves stable key replay and lost binding lookup, rejects changed key/bytes', async () => {
        const { p, id } = await setup();
        expect(s.lookup(a, {
            source_owner_id: owner, source_kind: p.source_kind, source_id: source, draft_id: draft, request_key: p.request_key
        })).toMatchObject({
            authority_id: id, execute: false
        });
        await expect(s.bind(a, {
            ...p, review: {
                ...p.review, send_explanation: explain + 'x'
            }
        })).rejects.toThrow('Conflicting');
        await expect(s.bind(a, {
            ...p, request_key: 'replacement'
        })).rejects.toThrow('fence');
    });
    it('source expiry and native/source drift fail before reservation or association', async () => {
        const { id } = await setup();
        sourceFresh = false;
        await expect(s.accept(grant, consume(id, 'accept'))).rejects.toThrow('expired');
        sourceFresh = true;
        await reserve(id);
        human(uuid(), 'Hold the address email');
        const p = await association(id);
        await expect(s.associate(r.id, p)).rejects.toThrow('context');
        expect(db.prepare('SELECT count(*) n FROM customer_email_associations').get()).toEqual({
            n: 0
        });
    });
    it('durable native association insert failure yields no entitlement', async () => {
        const { id } = await setup();
        await reserve(id);
        const p = await association(id);
        db.exec("CREATE TRIGGER fixture_fail BEFORE INSERT ON customer_email_associations BEGIN SELECT RAISE(ABORT,'Fixture commit failure'); END");
        await expect(s.associate(r.id, p)).rejects.toThrow('commit failure');
        expect(db.prepare('SELECT count(*) n FROM customer_email_associations').get()).toEqual({
            n: 0
        });
    });
    it('fences ordinary/delegated/routine claims atomically and detects prior effects', async () => {
        const { id } = await setup();
        const d = communicationService(db).saveDraft(grant, executor, 'other-draft', {
            ...s.read(grant, {
                authority_id: id
            }).authority.payload, body: 'Replacement'
        });
        expect(() => db.prepare("UPDATE bot_message_drafts SET claim_key='bypass',state='sending' WHERE id=?").run(d.id)).toThrow('fenced');
        expect(() => db.prepare('DELETE FROM customer_email_authorities WHERE id=?').run(id)).toThrow('Immutable');
    });
    it('prior ordinary UNKNOWN cannot be classified away by source scope', async () => {
        db.prepare("UPDATE bot_message_drafts SET state='uncertain',claim_key='old' WHERE id=?").run(draft);
        await expect(s.inspect(a, captureInput())).rejects.toThrow('untouched');
    });
    it('requires human-owner technical enrollment, never builders/bots or shared vendor/SMS trust', () => {
        const enroll = emailEnrollment(db, () => r, () => now), humanActor = {
            user: a.user
        };
        expect(() => enroll.prepare(a, {
            registration_id: r.id
        })).toThrow('human');
        const p = enroll.prepare(humanActor, {
            registration_id: r.id
        });
        expect(p.execute).toBe(false);
        expect(() => enroll.confirm(a, {
            registration_id: r.id, confirmation_hash: p.confirmation_hash, request_key: 'setup'
        })).toThrow('human');
        expect(() => loadEmailRegistry(null)).toThrow('CUSTODY_REQUIRED');
        expect(emailBearer('Bearer ' + 'fixture-service-token-'.repeat(3), r)).toBe(true);
        expect(emailBearer('Bearer ' + 'wrong-service-token-'.repeat(3), r)).toBe(false);
    });
    it('wires exact MCP input without dropping draft_id and delivers staged employee/resumed guidance', async () => {
        const defs = BOT_TOOL_DEFINITIONS.filter(t => t.name.includes('customer_email_direction'));
        expect(defs).toHaveLength(9);
        let route = '', body = '';
        await callBotTool({
            name: 'read_customer_email_direction_context', args: input(), callApi: async (url, options) => {
                route = url;
                body = String(options?.body);
                return {};
            }
        });
        expect(route).toBe('/api/bot-communication/customer-email-direction/context');
        expect(JSON.parse(body).draft_id).toBe(draft);
        const f = botFeatureCatalog(now).features.find(x => x.id === 'customer-email-direction')!;
        expect(f.limits).toContain('Staged');
        expect(f.agent).toContain('Nick');
        expect(f.agent).toContain('review_material_hash');
        expect(f.agent).toContain('all-version SMS');
        expect(f.steps.join(' ')).toContain('dispatch/v2');
        expect(employeeRouteAllowed('GET', '/bot-workflows/guide')).toBe(true);
        for (const elevated of [false, true])
            expect(coreVeneerRules({
                workspaceDir: '/repo', assistantSlug: 'bot', elevated
            })).toContain(f.agent);
    });
    function permitPrebind() {
        r=emailRegistration.parse({...r,id:uuid(),prebindCapability:{
            schemaVersion:'customer-email-prebind-capability/v1',input:input(),contractHash:EMAIL_PREBIND_CONTRACT_HASH,
            custodyReceipt:'fixture-prebind-custody',acceptanceReceipt:'fixture-prebind-adoption',
            expiresAt:new Date(now+60000).toISOString(),nativeRecords:'complete-business-structured-locators-no-human-text/v1'
        }});
        const e=emailEnrollment(db,()=>r,()=>now), humanActor={user:a.user};
        const p=e.prepare(humanActor,{registration_id:r.id});
        e.confirm(humanActor,{registration_id:r.id,confirmation_hash:p.confirmation_hash,request_key:uuid()});
    }
    async function prebindRoute(cf:()=>Promise<boolean>=async()=>true) {
        const app=express(),ctx={db,config:{}} as unknown as AppContext;
        app.use('/verifier',customerEmailVerifierRoutes(ctx,{io,cf}));
        const server=app.listen(0,'127.0.0.1');servers.push(server);
        await new Promise<void>(done=>server.once('listening',done));
        const url=`http://127.0.0.1:${(server.address() as {port:number}).port}/verifier/prebind-context`;
        return (body:unknown=input(),headers:Record<string,string>={})=>fetch(url,{method:'POST',headers:{
            'Content-Type':'application/json','x-customer-email-registration-id':r.id,
            Authorization:'Bearer '+'fixture-service-token-'.repeat(3),...headers},body:JSON.stringify(body)});
    }
    it('requires explicit human-reviewed exact prebind capability; old enrollment is not broadened',async()=>{
        const post=await prebindRoute();
        expect((await post()).status).toBe(403);
        permitPrebind();
        const before=db.serialize();
        const response=await post();expect(response.status).toBe(200);
        const value=emailPrebindResponse.parse(await response.json());
        expect(value.payload_hash).toBe(canonicalSha256(value.payload));
        expect(value.records.map(x=>({key:x.key,revision:x.revision}))).toEqual(customerEmailNative(db).snapshot(a,input()).inventory);
        expect(value).toMatchObject({execute:false,authority:false,ready:false,dispatchEntitlement:false,scope_complete:false});
        expect(value.records.find(x=>x.key===`draft:${draft}`)?.unknown).toBe(true);
        expect(JSON.stringify(value)).not.toContain('Compose and send a customer email');
        expect(JSON.stringify(value)).not.toContain('sourceCredential');
        expect(JSON.stringify(customerEmailNative(db).snapshot(a,input()))).not.toContain('locatorRows');
        expect(db.serialize()).toEqual(before);
    });
    it.each(['source_owner_id','executor_id','source_id','draft_id'])('prebind denies changed %s identifiers',async field=>{
        permitPrebind();const post=await prebindRoute();
        expect((await post({...input(),[field]:uuid()})).status).toBe(403);
    });
    it('strict prebind rejects caller scope, payload, inventory, mapping, registration and authority assertions',async()=>{
        permitPrebind();const post=await prebindRoute();
        for(const field of ['registration_id','payload','inventory','canonical_case','authority_id','actor_id','inspection_hash'])
            expect((await post({...input(),[field]:'forbidden'})).status).toBe(400);
        expect((await post({...input(),draft_version:2})).status).toBe(403);
    });
    it('prebind service requires dedicated bearer and CF identity with current registration after authentication',async()=>{
        permitPrebind();const post=await prebindRoute();
        expect((await post(input(),{Authorization:'Bearer '+'wrong-service-token-'.repeat(3)})).status).toBe(401);
        expect((await post(input(),{'x-customer-email-registration-id':uuid()})).status).toBe(403);
        const failed=await prebindRoute(async()=>false);expect((await failed()).status).toBe(401);
        const drift=await prebindRoute(async()=>{db.prepare('INSERT INTO customer_email_enrollment_revocations VALUES(?,?,?,?)').run(r.id,1,'fixture revoked',new Date(now).toISOString());return true;});
        expect((await drift()).status).toBe(503);
    });
    it.each(['active','custody','capability','business','principal','account','sourceAuthor','executor','draft'])('prebind fails current %s drift',async drift=>{
        permitPrebind();const post=await prebindRoute();
        if(drift==='active')r={...r,active:false};
        if(drift==='custody')r={...r,custodyExpiresAt:new Date(now).toISOString()};
        if(drift==='capability')now+=60001;
        if(drift==='business')r={...r,businessId:uuid()};
        if(drift==='principal')r={...r,servicePrincipalId:r.executorPrincipalId};
        if(drift==='account')db.prepare("UPDATE bot_message_drafts SET payload_json=json_set(payload_json,'$.account','changed@example.test') WHERE id=?").run(draft);
        if(drift==='sourceAuthor')db.prepare("UPDATE users SET status='disabled' WHERE id=2").run();
        if(drift==='executor')db.prepare('UPDATE bot_registrations SET active=0 WHERE conversation_id=?').run(executor);
        if(drift==='draft')db.prepare('UPDATE bot_message_drafts SET version=2 WHERE id=?').run(draft);
        expect((await post()).status).toBeGreaterThanOrEqual(400);
    });
    it.each(['media','chronology','anchor','cap','source','rows'])('prebind fails incomplete %s context',async failure=>{
        if(failure==='source')source=uuid();
        permitPrebind();const post=await prebindRoute();
        if(failure==='media')human(uuid(),'![Private media](/uploads/private.png)');
        if(failure==='chronology')human(uuid(),'fixture status',owner,'invalid');
        if(failure==='anchor')db.prepare('INSERT INTO bot_message_threads(id,conversation_id,anchor,source_text) VALUES(?,?,?,?)').run(uuid(),owner,'fixture-empty','');
        if(failure==='cap')human(uuid(),'x'.repeat(2000001));
        if(failure==='rows')db.transaction(()=>{for(let i=0;i<5001;i++)human(uuid(),'fixture status');})();
        expect((await post()).status).toBe(409);
    });
    it('prebind captures full context/payload/inventory drift and stable ACL revisions without source IO',()=>{
        permitPrebind();io.capture=async()=>{throw Error('Must not call source');};io.intent=async()=>{throw Error('Must not read source');};
        const read=customerEmailPrebind(db,io),one=read(r.id,input()),same=read(r.id,input());
        expect(one).toEqual(same);
        human(uuid(),'status-only private human text');
        const two=read(r.id,input());expect(two.context_revision).not.toBe(one.context_revision);expect(two.acl_hash).toBe(one.acl_hash);
        expect(JSON.stringify(two)).not.toContain('status-only private human text');
        db.prepare("UPDATE bot_message_drafts SET payload_json=json_set(payload_json,'$.body','Changed fixture body') WHERE id=?").run(draft);
        const three=read(r.id,input());expect(three.payload_hash).not.toBe(two.payload_hash);expect(three.inventory_hash).not.toBe(two.inventory_hash);
    });
    it('prebind denies unreviewed competing inventory media without exposing unrelated draft payload or file paths',async()=>{
        permitPrebind();
        communicationService(db).saveDraft({...a,conversationId:other},other,'foreign-media',{
            channel:'email',account:'other@example.test',recipients:['different@example.test'],subject:'PRIVATE other subject',
            body:'PRIVATE other body',attachments:[{name:'private.pdf',reference:'private-fixture-document'}],customer:'Fixture',ticket:'Fixture',context:'Fixture'
        });
        const post=await prebindRoute(),response=await post();expect(response.status).toBe(409);
        const value=await response.json();expect(value.error).toContain('INVENTORY_MEDIA');expect(JSON.stringify(value)).not.toContain('PRIVATE');
    });
    it('prebind read envelope is bounded by current custody and fails clock or long-read drift',()=>{
        permitPrebind();const read=customerEmailPrebind(db,io),value=read(r.id,input());
        expect(Date.parse(value.expires_at)-Date.parse(value.observed_at)).toBe(5000);
        let calls=0;io.registration=()=>{if(++calls===2)now+=5001;return r;};
        expect(()=>read(r.id,input())).toThrow('fresh bound');
        calls=0;io.registration=()=>{if(++calls===2)now-=1;return r;};
        expect(()=>read(r.id,input())).toThrow('fresh bound');
    });
    it('prebind supports exact result-reply provenance without exporting original result or human text',async()=>{
        const thread=uuid();source=uuid();
        db.prepare('INSERT INTO bot_message_threads(id,conversation_id,anchor,source_text) VALUES(?,?,?,?)').run(thread,owner,'fixture-result','PRIVATE retained original result text');
        db.prepare('INSERT INTO bot_message_replies(id,thread_id,actor_id,text,request_key,created_at) VALUES(?,?,2,?,?,?)').run(source,thread,'PRIVATE result-reply human instruction','fixture-reply',new Date(now).toISOString());
        const tuple={...input(),source_kind:'result_reply' as const};
        r=emailRegistration.parse({...r,id:uuid(),prebindCapability:{schemaVersion:'customer-email-prebind-capability/v1',input:tuple,contractHash:EMAIL_PREBIND_CONTRACT_HASH,custodyReceipt:'fixture-custody',acceptanceReceipt:'fixture-adoption',expiresAt:new Date(now+60000).toISOString(),nativeRecords:'complete-business-structured-locators-no-human-text/v1'}});
        const e=emailEnrollment(db,()=>r,()=>now),h={user:a.user},p=e.prepare(h,{registration_id:r.id});e.confirm(h,{registration_id:r.id,confirmation_hash:p.confirmation_hash,request_key:uuid()});
        const post=await prebindRoute(),response=await post(tuple);expect(response.status).toBe(200);
        const value=await response.json();expect(value.input.source_kind).toBe('result_reply');expect(JSON.stringify(value)).not.toContain('PRIVATE');
    });
    it('prebind includes competing immutable customer authority and subsequent revocation revisions',async()=>{
        permitPrebind();const read=customerEmailPrebind(db,io);const before=read(r.id,input());
        const {id}=await setup(),bound=read(r.id,input());
        expect(bound.inventory_hash).not.toBe(before.inventory_hash);
        const row=bound.records.find(x=>x.key===`customer_email:${id}`)!;
        expect(row.references.filter(x=>x.namespace.startsWith('source_'))).toHaveLength(3);
        s.revoke(a,{authority_id:id,reason:'Synthetic immutable competing authority revocation.',request_key:'fixture-prebind-revoke'});
        const revoked=read(r.id,input());expect(revoked.records.find(x=>x.key===row.key)?.revision).not.toBe(row.revision);
        expect(revoked.dispatchEntitlement).toBe(false);
    });
    it('locators retain actual structured provenance without inventing roots from descriptive payload or prose',()=>{
        const id=uuid(),root=uuid(),revision=hash();
        const records=retainedEmailLocators([
            {key:`composition:${id}`,revision,row:{snapshot_json:JSON.stringify({scope:{canonical_case:root,contact_case:'descriptive'},review:{text:'private human'}}),draft_id:uuid()}},
            {key:`draft:${uuid()}`,revision,row:{payload_json:JSON.stringify({ticket:root,customer:root})}},
            {key:`routine:${uuid()}`,revision,row:{locator_scope_json:JSON.stringify({canonical_case:root}),proof_id:uuid()}},
            {key:`customer_email:${uuid()}`,revision,row:{projection_json:JSON.stringify({canonicalCaseId:root,canonicalCustomerId:uuid(),canonicalOrderId:uuid()})}}
        ]);
        expect(records.find(x=>x.key===`composition:${id}`)?.references).toContainEqual({namespace:'source_case',id:root,field:'snapshot_json.scope.canonical_case',provenance:'retained-native-structured-field'});
        expect(records.find(x=>x.key.startsWith('draft:'))?.references).toEqual([]);
        expect(records.every(x=>x.resolution==='SOURCE_CLOSURE_REQUIRED')).toBe(true);
        expect(JSON.stringify(records)).not.toContain('private human');
        expect(()=>retainedEmailLocators([{key:`composition:${id}`,revision,row:{snapshot_json:'{malformed'}}])).toThrow();
    });
    it('dedicated verifier denies missing/wrong service authentication and returns no private human text', async () => {
        const ctx = {
            db, config: {}, projectDopplerCli: null
        } as unknown as AppContext, app = express();
        app.use('/verifier', customerEmailVerifierRoutes(ctx, {
            io, cf: async () => true
        }));
        const server = app.listen(0, '127.0.0.1');
        servers.push(server);
        await new Promise<void>(done => server.once('listening', () => done()));
        const port = (server.address() as {
            port: number;
        }).port;
        const { id } = await setup();
        expect((await fetch(`http://127.0.0.1:${port}/verifier/authorities/${id}`)).status).toBe(400);
        const response = await fetch(`http://127.0.0.1:${port}/verifier/authorities/${id}`, {
            headers: {
                'x-customer-email-registration-id': r.id, Authorization: 'Bearer ' + 'fixture-service-token-'.repeat(3)
            }
        });
        expect(response.status).toBe(200);
        const value = await response.json();
        expect(value.execute).toBe(false);
        expect(JSON.stringify(value)).not.toContain('Compose and send a customer email');
    });
    it('keeps registrations pinned to the previous native MCP artifact rejected after build 640', () => {
        expect(() => emailRegistrationCurrent(db, {...r, nativeArtifactHash:'024e1c2cf878ebe2f877a4d9e9e0a3f79b764e75dabac94c4f9ad27ec1dd3ffc'}, now)).toThrow('unaccepted');
    });
    it('pins actual native artifacts and separates own-principal custody', () => {
        const root = fileURLToPath(new URL('../../', import.meta.url));
        const manifest = CUSTOMER_EMAIL_NATIVE_ARTIFACT_FILES.map(p => ({
            path: p, sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(root, p))).digest('hex')
        }));
        expect(crypto.createHash('sha256').update(JSON.stringify(manifest)).digest('hex')).toBe(CUSTOMER_EMAIL_NATIVE_ARTIFACT_HASH);
    });
    it('covers later shared voice and native human decision-event citations', async () => {
        const decision = uuid(), e = uuid();
        db.prepare("INSERT INTO bot_decisions(id,conversation_id,source_key,proposal_key,proposal_json,assignee_id) VALUES(?,?,?,?,?,2)").run(decision, owner, 'voice-fixture', 'voice-fixture', '{}');
        db.prepare('INSERT INTO bot_decision_events(id,decision_id,version,kind,actor_id,payload_json,request_key,created_at) VALUES(?,?,1,?,2,?,?,?)').run(e, decision, 'discussion', JSON.stringify({
            text: 'Any update?'
        }), 'fixture-event', new Date(now).toISOString());
        db.prepare('INSERT INTO voice_dispatches(user_id,conversation_id,instruction_id,text,created_at) VALUES(2,?,?,?,?)').run(owner, 'fixture-shared-voice', 'What is the status?', new Date(now).toISOString());
        const p = await prepared();
        expect(p.review.later_context.map(x => x.citation.kind)).toEqual(expect.arrayContaining(['voice_dispatch', 'decision_event']));
        p.review.later_context = p.review.later_context.filter(x => x.citation.kind !== 'voice_dispatch');
        await expect(s.bind(a, p)).rejects.toThrow('every later');
    });
    it('rejects entire capped context, structured attachments and noncanonical chronology', async () => {
        human(uuid(), 'Attached files (saved on this server — read them from these paths):\n/Users/fixture/photo.png');
        await expect(s.inspect(a, captureInput())).rejects.toThrow('media');
        human(uuid(), 'Status', owner, 'not-a-time');
        expect(() => s.context(a, input())).toThrow('chronology');
    });
    it('native return and SMS action fences prevent related claims in both directions', async () => {
        const { id } = await setup(), decision = uuid(), trust = uuid(), mapping = uuid();
        db.prepare("INSERT INTO bot_decisions(id,conversation_id,source_key,proposal_key,proposal_json,assignee_id) VALUES(?,?,?,?,?,2)").run(decision, executor, 'return-fixture', 'return-fixture', '{}');
        db.prepare('INSERT INTO return_bridge_trust(id,business_id,owner_id,executor_id,client_id,audience,account_id,principal_id,source_origin,request_key) VALUES(?,?,1,?,?,?,?,?,?,?)').run(trust, r.businessId, executor, 'fixture-client', 'fixture-aud', r.sourceAccountId, r.executorPrincipalId, r.sourceOrigin, 'fixture-return');
        const approval = uuid();
        db.prepare('INSERT INTO bot_decision_events(id,decision_id,version,kind,actor_id,payload_json,request_key) VALUES(?,?,1,?,2,?,?)').run(approval, decision, 'answered', '{}', 'fixture-approval');
        db.prepare('INSERT INTO return_bridge_mappings(id,trust_id,decision_id,decision_version,approval_event_id,proposal_hash,request_key,scope_hash,capture_json,receipt_json) VALUES(?,?,?,1,?,?,?,?,?,?)').run(mapping, trust, decision, approval, hash(), 'fixture-return-map', hash(), JSON.stringify({
            conversation: {
                id: caseId
            }, order: {
                id: orderId
            }
        }), '{}');
        expect(() => db.prepare('INSERT INTO return_bridge_claims VALUES(?,?,?,?,?,?)').run(uuid(), mapping, decision, 'fixture-return-claim', hash(), new Date(now).toISOString())).toThrow('fenced');
        expect(() => db.prepare('INSERT INTO bot_composed_sms_authorities(id,action_id,owner_id,executor_id,source_id,draft_id,request_key,request_hash,snapshot_json,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(uuid(), 'fixture-sms', owner, executor, source, draft, 'fixture-sms', hash(), JSON.stringify({
            scope: {
                canonical_case: caseId
            }
        }), r.expiresAt)).toThrow('fenced');
        expect(s.read(grant, {
            authority_id: id
        }).execute).toBe(false);
    });
    it('source/native authority insert races cannot mint a second recipient or changed-key attempt', async () => {
        const p = await prepared();
        const results = await Promise.allSettled([s.bind(a, p), s.bind(a, {
                ...p, request_key: 'race'
            })]);
        expect(results.filter(x => x.status === 'fulfilled')).toHaveLength(1);
        expect(db.prepare('SELECT count(*) n FROM customer_email_authorities').get()).toEqual({
            n: 1
        });
    });
    it('persisted positive source receipt survives native receipt-save failure without dispatch retry', async () => {
        const { id } = await setup();
        await reserve(id);
        const p = await association(id), x = await s.associate(r.id, p), t = s.read(grant, {
            authority_id: id
        }).authority;
        wireIntent = {
            ...wireIntent!, state: 'SENT_ACCEPTED', associationId: x.association_id, preProviderCommitted: true, receipt: {
                provider: 'gmail', providerMessageId: 'fixture-positive', messageId: 'fixture-message', account: t.payload.account, recipient: t.payload.recipients[0]!, subject: t.payload.subject, body: t.payload.body, attachments: [], cc: [], bcc: [], acceptedAt: new Date(now).toISOString(), payloadHash: t.payloadHash, idempotencyKey: t.idempotencyKey
            }
        };
        db.exec("CREATE TRIGGER fixture_receipt_fail BEFORE INSERT ON customer_email_readbacks BEGIN SELECT RAISE(ABORT,'Fixture receipt save loss'); END");
        await expect(s.receipt(grant, {
            authority_id: id, claim_id: p.claim_id
        })).rejects.toThrow('save loss');
        expect((await s.associate(r.id, p)).dispatchEntitlement).toBe(false);
        db.exec('DROP TRIGGER fixture_receipt_fail');
        expect((await s.receipt(grant, {
            authority_id: id, claim_id: p.claim_id
        })).receipts).toHaveLength(1);
    });
    it('blocks omitted media in original result anchors and capped complete native surfaces',async()=>{
      const thread=uuid();db.prepare('INSERT INTO bot_message_threads(id,conversation_id,anchor,source_text) VALUES(?,?,?,?)').run(thread,owner,'fixture-result','![Original photo](/uploads/original.png)');await expect(s.inspect(a,captureInput())).rejects.toThrow('media');
      human(uuid(),'x'.repeat(2000001));expect(()=>s.context(a,input())).toThrow('bound');
    });

    it('includes coarse same-second human events instead of guessing they preceded the source',async()=>{
      source=uuid();human(source,'Compose and send this address request.',owner,new Date(now+500).toISOString());
      const decision=uuid(),event=uuid();db.prepare("INSERT INTO bot_decisions(id,conversation_id,source_key,proposal_key,proposal_json,assignee_id) VALUES(?,?,?,?,?,2)").run(decision,owner,'coarse-fixture','coarse-fixture','{}');
      db.prepare('INSERT INTO bot_decision_events(id,decision_id,version,kind,actor_id,payload_json,request_key,created_at) VALUES(?,?,1,?,2,?,?,?)').run(event,decision,'discussion',JSON.stringify({text:'Hold the email'}),'coarse-event',new Date(now).toISOString().slice(0,19).replace('T',' '));now+=1000;
      const p=await prepared();expect(p.review.later_context.some(x=>x.citation.id===event)).toBe(true);p.review.later_context=p.review.later_context.filter(x=>x.citation.id!==event);await expect(s.bind(a,p)).rejects.toThrow('every later');
    });
    // Build605 regression fixtures: every identity and effect is synthetic.
    async function vendorPrepared() {
        const actor={...a,conversationId:other}, service=vendorEmailService(db);
        const id=uuid(); human(id,'Compose and send this separate fixture reply.',other,new Date(now-1000).toISOString());
        const scope=vendorEmailScope.parse({executor_conversation_id:other,channel:'email',account:r.payloadAccount,recipient:'customer@example.test',thread_id:'fixture-thread',in_reply_to:'fixture-message',subject:'Fixture distinct reply',body:'Fixture reply',attachments:[]});
        const i=await service.inspect(actor,{source_kind:'direct_message',source_id:id,scope});
        const review=vendorEmailReview.parse({reviewed_full_context:true,interpretation:'unconditional_compose_and_send',instruction:{kind:i.source.kind,id:i.source.id,text:i.source.text},explanation:explain,scope_explanation:explain,later_context:i.later_human_context.map(m=>({citation:{kind:m.kind,id:m.id,text:m.text},classification:'status_only',explanation:explain})),records:[...i.context.drafts,...i.context.decisions].map(m=>({kind:m.kind,id:m.id,classification:'unrelated',explanation:explain})),body_parts:[{start:0,end:scope.body.length,human_ids:[id],evidence:explain}],unresolved_choices:[]});
        const source_check=vendorEmailCheck.parse({observed_at:new Date().toISOString(),payload_hash:i.payload_hash,account_thread_recipient_verified:true,permissions_verified:true,attachments_verified:true,no_prior_or_uncertain_send:true,exclusive_source_ownership:true,evidence:explain});
        return {actor,service,source_hash:i.source_hash,p:{source_kind:'direct_message' as const,source_id:id,scope,inspection_hash:i.inspection_hash,review,source_check,request_key:'fixture-vendor'}};
    }
    function insertLegacyVendor(p:Awaited<ReturnType<typeof vendorPrepared>>['p'],sourceHash:string) {
        // Emulate an existing pre-correction coexistence record. Restore the guard
        // before testing the genuine service claim and its transaction boundaries.
        const sql=(db.prepare("SELECT sql FROM sqlite_master WHERE name='customer_email_vendor_bind'").get() as {sql:string}).sql;
        db.exec('DROP TRIGGER customer_email_vendor_bind');
        const id=uuid(),key=uuid();
        db.prepare('INSERT INTO bot_vendor_email_authorities(id,conversation_id,executor_user_id,business_id,source_kind,source_id,author_id,target_key,account,recipient,scope_json,payload_hash,source_hash,request_key,request_hash,review_json) VALUES(?,?,1,?,?,?,2,?,?,?,?,?,?,?,?,?)').run(id,other,r.businessId,p.source_kind,p.source_id,key,p.scope.account,p.scope.recipient,JSON.stringify(p.scope),p.source_check.payload_hash,sourceHash,'legacy',hash(),JSON.stringify(p));
        db.prepare('INSERT INTO bot_vendor_email_targets(target_key,authority_id) VALUES(?,?)').run(key,id);
        db.exec(sql);
        return {id,key};
    }
    async function acceptedFixture(id:string, priorUnknown=false) {
        await reserve(id);const p=await association(id),x=await s.associate(r.id,p),t=s.read(grant,{authority_id:id}).authority;
        if(priorUnknown){wireIntent={...wireIntent!,state:'UNKNOWN',preProviderCommitted:true,associationId:x.association_id};await s.receipt(grant,{authority_id:id,claim_id:p.claim_id});}
        wireIntent={...wireIntent!,state:'SENT_ACCEPTED',preProviderCommitted:true,associationId:x.association_id,receipt:{provider:'gmail',providerMessageId:uuid(),messageId:uuid(),account:t.payload.account,recipient:t.payload.recipients[0]!,subject:t.payload.subject,body:t.payload.body,attachments:[],cc:[],bcc:[],acceptedAt:new Date(now).toISOString(),payloadHash:t.payloadHash,idempotencyKey:t.idempotencyKey}};
        await s.receipt(grant,{authority_id:id,claim_id:p.claim_id});return p;
    }
    it.each(['bound','associated','UNKNOWN'] as const)('customer %s first denies genuine vendor bind and legacy vendor claim without writes',async state=>{
        const v=await vendorPrepared();const {id}=await setup();
        if(state!=='bound'){await reserve(id);const assoc=await association(id),x=await s.associate(r.id,assoc);if(state==='UNKNOWN'){wireIntent={...wireIntent!,state:'UNKNOWN',preProviderCommitted:true,associationId:x.association_id};await s.receipt(grant,{authority_id:id,claim_id:assoc.claim_id});}}
        await expect(v.service.bind(v.actor,v.p)).rejects.toThrow('customer email');
        expect(db.prepare('SELECT count(*) n FROM bot_vendor_email_authorities').get()).toEqual({n:0});
        const legacy=insertLegacyVendor(v.p,v.source_hash);
        await expect(v.service.claim(v.actor,{authority_id:legacy.id,claim_key:'legacy-claim',inspection_hash:v.p.inspection_hash,review:v.p.review,source_check:v.p.source_check})).rejects.toThrow('customer email');
        expect(db.prepare('SELECT count(*) n FROM bot_vendor_email_events').get()).toEqual({n:0});
        expect((db.prepare('SELECT claim_key FROM bot_vendor_email_targets WHERE target_key=?').get(legacy.key) as {claim_key:null}).claim_key).toBeNull();
        expect(()=>db.prepare("UPDATE bot_vendor_email_targets SET claim_key='raw',state='claimed' WHERE target_key=?").run(legacy.key)).toThrow('fenced');
        expect(s.read(grant,{authority_id:id}).execute).toBe(false);
    });
    it.each(['bound','claimed','uncertain'])('vendor %s first denies customer bind without authority insertion',async state=>{
        const v=await vendorPrepared(),g=await v.service.bind(v.actor,v.p);
        if(state!=='bound'){await v.service.claim(v.actor,{authority_id:g.authority.id,claim_key:'vendor-claim',inspection_hash:v.p.inspection_hash,review:v.p.review,source_check:v.p.source_check});}
        if(state==='uncertain')v.service.receipt(v.actor,{authority_id:g.authority.id,claim_key:'vendor-claim',request_key:'uncertain',state:'uncertain',evidence:explain});
        await expect(s.inspect(a,captureInput())).rejects.toThrow('vendor');
        expect(db.prepare('SELECT count(*) n FROM customer_email_authorities').get()).toEqual({n:0});
    });
    it.each(['bot_vendor_email_authorities','bot_vendor_email_targets','bot_vendor_email_sources'])('vendor bind %s persistence failure rolls back all fences atomically',async table=>{
        const v=await vendorPrepared();db.exec(`CREATE TRIGGER fixture_fail BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'fixture persistence failure'); END`);
        await expect(v.service.bind(v.actor,v.p)).rejects.toThrow('persistence failure');
        for(const t of ['bot_vendor_email_authorities','bot_vendor_email_targets','bot_vendor_email_sources','bot_vendor_email_events'])expect(db.prepare(`SELECT count(*) n FROM ${t}`).get()).toEqual({n:0});
        expect((await setup()).g.execute).toBe(false);
    });
    it.each(['event','target'])('vendor claim %s persistence failure rolls back consumption and keeps competitor fence',async boundary=>{
        const v=await vendorPrepared(),g=await v.service.bind(v.actor,v.p);
        db.exec(boundary==='event'?"CREATE TRIGGER fixture_fail BEFORE INSERT ON bot_vendor_email_events BEGIN SELECT RAISE(ABORT,'fixture persistence failure'); END":"CREATE TRIGGER fixture_fail BEFORE UPDATE OF claim_key ON bot_vendor_email_targets BEGIN SELECT RAISE(ABORT,'fixture persistence failure'); END");
        await expect(v.service.claim(v.actor,{authority_id:g.authority.id,claim_key:'vendor-claim',inspection_hash:v.p.inspection_hash,review:v.p.review,source_check:v.p.source_check})).rejects.toThrow('persistence failure');
        expect(db.prepare('SELECT count(*) n FROM bot_vendor_email_events').get()).toEqual({n:0});
        expect(v.service.read(v.actor,g.authority.id).target.claim_key).toBeNull();
        await expect(s.inspect(a,captureInput())).rejects.toThrow('vendor');
    });
    it('native bind persistence failure leaves no phantom recipient lock',async()=>{
        const p=await prepared();db.exec("CREATE TRIGGER fixture_fail BEFORE INSERT ON customer_email_authorities BEGIN SELECT RAISE(ABORT,'fixture persistence failure'); END");
        await expect(s.bind(a,p)).rejects.toThrow('persistence failure');
        expect(db.prepare('SELECT count(*) n FROM customer_email_overlap_locks').get()).toEqual({n:0});
        const v=await vendorPrepared();expect((await v.service.bind(v.actor,v.p)).execute).toBe(false);
    });
    it('authenticated acceptance permits a genuinely distinct later reply, never original source/draft/key replay',async()=>{
        const {id,p}=await setup();const claim=await acceptedFixture(id,true);
        expect(db.prepare('SELECT count(*) n FROM customer_email_overlap_locks').get()).toEqual({n:0});
        expect(s.read(grant,{authority_id:id}).receipts).toHaveLength(2); // UNKNOWN audit retained.
        await expect(s.bind(a,{...p,request_key:'original-retry'})).rejects.toThrow('Permanent original');
        expect(()=>db.prepare("UPDATE bot_message_drafts SET claim_key='ordinary-original',state='sending' WHERE id=?").run(draft)).toThrow('fenced');
        expect((await s.associate(r.id,claim)).dispatchEntitlement).toBe(false);
        const oldDraft=draft;source=uuid();human(source,'Compose and send the genuinely distinct later reply.',owner);
        draft=communicationService(db).saveDraft(grant,executor,'later-reply',{...s.read(grant,{authority_id:id}).authority.payload,body:'Genuinely distinct authorized later reply.'}).id;
        const later=await prepared();later.request_key='later-action';expect(later.review.records.find(x=>x.key===`customer_email:${id}`)?.classification).toBe('completed_action');
        const g=await s.bind(a,later);expect(g.authority.actionFence).not.toBe(s.read(grant,{authority_id:id}).authority.actionFence);expect(g.authority.draftId).not.toBe(oldDraft);
        await reserve(g.authority_id);expect(db.prepare('SELECT count(*) n FROM customer_email_authorities').get()).toEqual({n:2});
        expect(s.read(grant,{authority_id:id}).receipts).toHaveLength(2);
    });
    it('only authenticated saved positive receipt releases overlap; lost receipt save keeps overlap blocked',async()=>{
        const {id}=await setup();await reserve(id);const p=await association(id),x=await s.associate(r.id,p),t=s.read(grant,{authority_id:id}).authority;
        wireIntent={...wireIntent!,state:'SENT_ACCEPTED',associationId:x.association_id,preProviderCommitted:true,receipt:{provider:'gmail',providerMessageId:uuid(),messageId:uuid(),account:t.payload.account,recipient:t.payload.recipients[0]!,subject:t.payload.subject,body:t.payload.body,attachments:[],cc:[],bcc:[],acceptedAt:new Date(now).toISOString(),payloadHash:t.payloadHash,idempotencyKey:t.idempotencyKey}};
        db.exec("CREATE TRIGGER fixture_fail BEFORE INSERT ON customer_email_readbacks BEGIN SELECT RAISE(ABORT,'fixture loss'); END");
        await expect(s.receipt(grant,{authority_id:id,claim_id:p.claim_id})).rejects.toThrow('loss');
        expect(db.prepare('SELECT count(*) n FROM customer_email_overlap_locks').get()).toEqual({n:1});
        db.exec('DROP TRIGGER fixture_fail');await s.receipt(grant,{authority_id:id,claim_id:p.claim_id});expect(db.prepare('SELECT count(*) n FROM customer_email_overlap_locks').get()).toEqual({n:0});
    });
    it.each(['bound','UNKNOWN','NO_EFFECT','revoked','expired'])('%s never releases recipient/order overlap for distinct later action',async state=>{
        const {id}=await setup();
        if(state==='UNKNOWN'||state==='NO_EFFECT'){await reserve(id);const p=await association(id),x=await s.associate(r.id,p);wireIntent={...wireIntent!,state,associationId:x.association_id};await s.receipt(grant,{authority_id:id,claim_id:p.claim_id});}
        if(state==='revoked')s.revoke(a,{authority_id:id,request_key:'revoke',reason:explain});
        if(state==='expired')now+=1800001;
        expect(db.prepare('SELECT count(*) n FROM customer_email_overlap_locks').get()).toEqual({n:1});
        const v=await vendorPrepared();await expect(v.service.bind(v.actor,v.p)).rejects.toThrow('customer email');
    });
    it('pre-bind semantic review survives supported reinspection with fresh envelope after minutes',async()=>{
        const p=await prepared(),i=await s.inspect(a,{...input(),registration_id:p.registration_id,capture_id:p.capture_id,canonical_case:p.canonical_case,canonical_customer:p.canonical_customer,canonical_order:p.canonical_order});now+=120000;
        const renewed={...captureInput(),capture_id:uuid()},next=await s.inspect(a,renewed);
        expect(next.inspection_hash).toBe(i.inspection_hash);expect(next.review_material_hash).toBe(i.review_material_hash);expect(next.source.snapshotHash).not.toBe(i.source.snapshotHash);
        const bound=await s.bind(a,{...renewed,inspection_hash:next.inspection_hash,review:p.review,request_key:p.request_key});expect(bound.execute).toBe(false);await reserve(bound.authority_id);
    });
    it.each(['materialHash','identityHash','scopeHash','crossActionFenceHash','leaseId','leaseExpiresAt','sourceMaterial','closure','relation','coverage'])('pre-bind renewal rejects reviewed %s drift',async field=>{
        const p=await prepared();now+=1000;alter=w=>{
            if(field==='closure')(w.records as Array<{closureHash:string}>)[0]!.closureHash='b'.repeat(64);
            else if(field==='relation')(w.records as Array<{relation:string}>)[0]!.relation='blocking';
            else if(field==='coverage')(w.records as unknown[]).pop();
            else w[field]=field==='sourceMaterial'?{fixture:'changed material'}:field==='leaseId'?'different-lease':field==='leaseExpiresAt'?new Date(now+20000).toISOString():'b'.repeat(64);
        };
        await expect(s.bind(a,{...p,capture_id:uuid()})).rejects.toThrow();expect(db.prepare('SELECT count(*) n FROM customer_email_authorities').get()).toEqual({n:0});
    });
    it.each(['human','ACL','payload','registration'])('pre-bind fresh renewal rejects %s drift even with original semantic review',async field=>{
        const p=await prepared();
        if(field==='human')human(uuid(),'Hold this message.');
        if(field==='ACL')db.prepare("UPDATE conversations SET visibility='private' WHERE id=?").run(executor);
        if(field==='payload'){const payload=s.context(a,input()).payload;db.prepare('UPDATE bot_message_drafts SET payload_json=? WHERE id=?').run(JSON.stringify({...payload,body:payload.body+'Changed'}),draft);}
        if(field==='registration')r={...r,revision:2};
        await expect(s.bind(a,{...p,capture_id:uuid()})).rejects.toThrow();
    });
    it.each(['oldCapture','postRead'])('fresh review continuity never weakens %s timing bound',async mode=>{
        const p=await prepared();
        if(mode==='oldCapture')alter=w=>{w.observedAt=new Date(now-15001).toISOString();w.expiresAt=new Date(now-1).toISOString();};
        else sourceFresh=false;
        await expect(s.bind(a,{...p,capture_id:uuid()})).rejects.toThrow();
    });
    it('current authority is fully inventoried; only exact own acceptance/reservation/receipt bookkeeping is stable',async()=>{
        const {id}=await setup(),view=()=>s.serviceContext(r.id,id),before=view();
        expect(before.records.some(x=>x.key===`customer_email:${id}`)).toBe(true);
        await acceptedFixture(id,true);expect(view().inventory_hash).toBe(before.inventory_hash);
        s.revoke(a,{authority_id:id,request_key:'revoke',reason:explain});expect(view().inventory_hash).not.toBe(before.inventory_hash);
    });
    it.each(['accepted','reserved','associated','readback','revoked'])('competing customer authority %s audit always changes inventory',async change=>{
        const {id}=await setup(),view=()=>s.context(a,input()).inventoryHash,before=view();
        if(change==='revoked')s.revoke(a,{authority_id:id,request_key:'revoke',reason:explain});
        else if(change==='accepted')await s.accept(grant,consume(id,'accept'));
        else if(change==='reserved')await reserve(id);
        else {await reserve(id);const p=await association(id),x=await s.associate(r.id,p);if(change==='readback'){wireIntent={...wireIntent!,state:'UNKNOWN',associationId:x.association_id};await s.receipt(grant,{authority_id:id,claim_id:p.claim_id});}}
        expect(view()).not.toBe(before);
    });
    it('corrected authority integrity detects changed original row even if immutable trigger is bypassed in a fixture',async()=>{
        const {id}=await setup();db.exec('DROP TRIGGER customer_email_authorities_no_update');db.prepare("UPDATE customer_email_authorities SET review_json='{}' WHERE id=?").run(id);
        expect(()=>s.read(grant,{authority_id:id})).toThrow('integrity');
    });
    it.each(['lineage','dispatch','association','receipt','scope','scope_revocation','event'])('all-version SMS %s is inventoried and invalidates review',async change=>{
        const sms=uuid(),smsSource=uuid();human(smsSource,'Fixture independent SMS direction.',other,new Date(now-2000).toISOString());
        db.prepare('INSERT INTO bot_composed_sms_authorities(id,action_id,owner_id,executor_id,source_id,draft_id,request_key,request_hash,snapshot_json,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(sms,uuid(),other,other,smsSource,draft,'sms',hash(),JSON.stringify({version:'fixture-correction-v2',scope:{canonical_case:uuid()}}),r.expiresAt);
        const dispatch=()=>db.prepare('INSERT INTO bot_composed_sms_dispatch_authorities VALUES(?,?,?,?,?,?,?)').run(sms,uuid(),r.id,hash(),'{}',r.expiresAt,r.expiresAt);
        const associate=()=>{dispatch();const id=uuid();db.prepare('INSERT INTO bot_composed_sms_associations VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id,sms,uuid(),uuid(),r.id,uuid(),'sms-associate',hash(),hash(),'{}',new Date(now).toISOString(),r.expiresAt);return id;};
        const scope=()=>{const id=uuid();db.prepare('INSERT INTO compose_scope_reviews(id,authority_id,owner_id,request_key,request_hash,context_revision,evidence_json) VALUES(?,?,?,?,?,?,?)').run(id,sms,other,'scope',hash(),hash(),'{}');return id;};
        // Start after prerequisite records so each individual surface is the drift.
        const assoc=change==='receipt'?associate():null,review=change==='scope_revocation'?scope():null;
        const p=await prepared(),before=s.context(a,input()).inventoryHash;
        if(change==='lineage')db.prepare('INSERT INTO compose_action_lineages VALUES(?,?,?,?,?,?)').run(hash(),uuid(),r.businessId,uuid(),sms,new Date(now).toISOString());
        if(change==='dispatch')dispatch();if(change==='association')associate();
        if(change==='receipt')db.prepare('INSERT INTO bot_composed_sms_service_receipts VALUES(?,?,?,?,?,?)').run(assoc,r.id,'{"state":"UNKNOWN"}','fixture-account',uuid(),new Date(now).toISOString());
        if(change==='scope')scope();if(change==='scope_revocation')db.prepare('INSERT INTO compose_scope_revocations VALUES(?,?,?)').run(review,'Fixture revoke',new Date(now).toISOString());
        if(change==='event')db.prepare('INSERT INTO bot_composed_sms_events(authority_id,kind,actor_id,actor_conversation_id,request_key,payload_json) VALUES(?,\'unknown\',1,?,?,?)').run(sms,other,'unknown','{}');
        expect(s.context(a,input()).inventoryHash).not.toBe(before);await expect(s.bind(a,p)).rejects.toThrow('Inspection changed');
    });

    it.each(['closure','relation','lease','material'])('accepted full own-authority %s pin cannot drift before claim',async drift=>{
        const {id}=await setup();await s.accept(grant,consume(id,'accept'));
        alter=w=>{if(drift==='closure'||drift==='relation'){const record=(w.records as Array<{key:string;closureHash:string;relation:string}>).find(x=>x.key===`customer_email:${id}`)!;if(drift==='closure')record.closureHash='b'.repeat(64);else record.relation='unrelated';}else if(drift==='lease')w.leaseId='changed-lease';else w.sourceMaterial={fixture:'changed'};};
        await expect(s.claim(grant,consume(id,'claim'))).rejects.toThrow();expect(s.read(grant,{authority_id:id}).reservation).toBeNull();
    });
    it('production post-read bound is exactly five seconds, finite and monotonic',()=>{
        expect(()=>validateEmailReadWindow(now,now+5000)).not.toThrow();
        for(const n of [now+5001,now-1,NaN,Infinity])expect(()=>validateEmailReadWindow(now,n)).toThrow('expired');
    });

    it('technical customer enrollment audit revision is part of complete inventory',async()=>{
        const before=s.context(a,input()).inventoryHash;
        db.prepare('INSERT INTO customer_email_enrollment_revocations VALUES(?,?,?,?)').run(r.id,1,'Fixture withdrawal',new Date(now).toISOString());
        expect(s.context(a,input()).inventoryHash).not.toBe(before);
        await expect(s.inspect(a,captureInput())).rejects.toThrow('CUSTODY');
    });
    function readyOrdinary(kind:'ordinary'|'delegated') {
        const actor={...a,conversationId:other}, comm=communicationService(db), payload={...s.context(a,input()).payload,body:'Independent synthetic '+kind+' reply.',ticket:caseId};
        let id:string,checks:unknown;
        if(kind==='ordinary'){
            const d=comm.saveDraft(actor,other,'ordinary-'+uuid(),payload);
            comm.mutateDraft({user:db.prepare('SELECT * FROM users WHERE id=2').get() as UserRow},d.id,d.version,'send');id=d.id;
        }else{
            const bots=createBotService(db),bridge=messageDelegationService(db),scope=approvedMessageSchema.parse({canonical_case:caseId,executor_conversation_id:other,payload});
            const d=bots.raise(actor,{source_key:uuid(),proposal_key:uuid(),proposal:proposalSchema.parse({question:'Send this exact synthetic reply?',recommendation:'One separate synthetic message.',consequence:'Fixture only.',blocked_action:'Exact synthetic customer-message scope; no real send.',assignee_id:2,message_delivery:scope})});
            bots.answer({user:db.prepare('SELECT * FROM users WHERE id=2').get() as UserRow},d.id,1,'synthetic-approval',{action:'approve',text:'Approve synthetic fixture only.',scope:'this_case'});
            const g=bridge.delegate(actor,d.id,1,other,'synthetic-delegate',scope),draft=bridge.accept(actor,g.id,'synthetic-accept',scope);id=draft.id;
            db.prepare("UPDATE conversation_wakeups SET status='delivered' WHERE id IN (SELECT id FROM bot_decision_events WHERE decision_id=? AND kind='answered')").run(d.id);
            db.prepare("UPDATE bot_decisions SET state='action_pending' WHERE id=?").run(d.id);
            bots.result(actor,d.id,1,'synthetic-running',{state:'running',evidence:explain,material_evidence_unchanged:true});
            checks={payload_hash:g.payload_hash,material_evidence_unchanged:true,recipient_account_case_verified:true,lease_and_duplicates_checked:true,evidence:explain};
        }
        return {id,actor,claim:()=>comm.claim(actor,id,'synthetic-claim',checks)};
    }
    function readyRoutine() {
        const actor={...a,conversationId:other},person={user:a.user},identity={clientId:'fixture-routine',audience:'fixture-routine-audience'};
        const policy=routinePolicyService(db).enroll(person,{business_id:r.businessId,policy_key:'fixture-routine',expected_version:0,request_key:'fixture-policy',source_reference:explain,policy_text:explain+explain,executor_ids:[other],categories:['missing_information']}).id;
        const service=routineExecutionService(db,{now:()=>now,identity});
        const trust=service.enroll(person,{policy_id:policy,executor_id:other,request_key:'fixture-routine-trust',client_id:identity.clientId,audience:identity.audience,account_id:'fixture-routine-account',principal_id:'fixture-routine-principal',source_origin:'https://source.example.test',registration_reference:explain,adapter_digest:hash(),contract:'routine-missing-information/v1'}).trust_id;
        const capture=(key:string)=>routineCaptureSchema.parse({schema_version:'routine-missing-information/v1',trust_id:trust,request_key:key,native_context_revision:service.nativeContext(identity,{trust_id:trust,canonical_case:caseId}).revision,captured_at:new Date(now).toISOString(),adapter_digest:hash(),account_id:'fixture-routine-account',principal_id:'fixture-routine-principal',source_origin:'https://source.example.test',enrollment_revision:'fixture',source_intent:'fixture-routine-intent',lease:{case_id:caseId,principal_id:'fixture-routine-principal',revision:'fixture-lease',expires_at:new Date(now+60000).toISOString()},material:{case_id:caseId,ticket:caseId,customer_id:customerId,sender_account:r.payloadAccount,recipient:'customer@example.test',retained_principal_id:'fixture-routine-principal',revision:'fixture-material',context:{completeness:'all-channels-sisters-and-outbound/v1',snapshot_revision:'fixture',channels:['email'],conversation_ids:[caseId],message_count:1,messages_hash:hash(),source_records_hash:hash(),next_cursor:null,truncation:'none'},human_directive:'none',prior_effect:'none',disposition:'open_question',requested_fields:['model_number'],field_evidence:[{field:'model_number',state:'missing',relevance:'needed_for_current_question',evidence_revision:'fixture'}],duplicate_scope_hashes:[]}});
        const proof=service.capture(identity,capture('prepare')),d=communicationService(db).saveDraft(actor,other,'routine-draft',proof.scope.payload);
        service.accept(actor,{draft_id:d.id,proof_id:proof.proof_id,expected_version:d.version,request_key:'accept'});
        const claimProof=service.capture(identity,capture('claim'));
        return {id:d.id,claim:()=>service.claim(actor,{draft_id:d.id,proof_id:claimProof.proof_id,claim_key:'fixture-routine-claim'})};
    }
    it.each((['ordinary','delegated','routine'] as const).flatMap(kind=>(['bound','associated','UNKNOWN'] as const).map(state=>({kind,state}))))('customer $state first atomically denies actual $kind claim and rolls back internal events',async ({kind,state})=>{
        const {id}=await setup();
        if(state!=='bound'){await reserve(id);const assoc=await association(id),x=await s.associate(r.id,assoc);if(state==='UNKNOWN'){wireIntent={...wireIntent!,state:'UNKNOWN',preProviderCommitted:true,associationId:x.association_id};await s.receipt(grant,{authority_id:id,claim_id:assoc.claim_id});}}
        const p=kind==='routine'?readyRoutine():readyOrdinary(kind);
        const before=db.prepare('SELECT * FROM bot_message_drafts WHERE id=?').get(p.id);
        expect(()=>p.claim()).toThrow('fenced');
        expect(db.prepare('SELECT * FROM bot_message_drafts WHERE id=?').get(p.id)).toEqual(before);
        expect(db.prepare('SELECT count(*) n FROM routine_draft_claims').get()).toEqual({n:0});
        expect(db.prepare("SELECT count(*) n FROM bot_message_delegation_events WHERE kind='claimed'").get()).toEqual({n:0});
    });
    it.each(['ordinary','delegated','routine'] as const)('%s claim first atomically prevents customer authority insertion',async kind=>{
        const p=kind==='routine'?readyRoutine():readyOrdinary(kind);expect(p.claim().execute).toBe(kind!=='routine');
        await expect(s.inspect(a,captureInput())).rejects.toThrow('claim');
        expect(db.prepare('SELECT count(*) n FROM customer_email_authorities').get()).toEqual({n:0});
    });
    it.each(['ordinary','delegated','routine'] as const)('%s queued authority first prevents customer bind before either can dispatch',async kind=>{
        kind==='routine'?readyRoutine():readyOrdinary(kind);
        const p=await prepared();await expect(s.bind(a,p)).rejects.toThrow('fenced');
        expect(db.prepare('SELECT count(*) n FROM customer_email_authorities').get()).toEqual({n:0});
    });
    it('new ordinary reply can claim only after authenticated original acceptance; original draft stays fenced',async()=>{
        const {id}=await setup();await acceptedFixture(id);
        const p=readyOrdinary('ordinary');expect(p.claim().execute).toBe(true);
        expect(()=>db.prepare("UPDATE bot_message_drafts SET claim_key='original-resend',state='sending' WHERE id=?").run(draft)).toThrow('fenced');
    });
    it.each(['SMS','customer','SMS_scope'].flatMap(kind=>['accept','claim'].map(phase=>({kind,phase}))))('competitor $kind insertion DURING source read invalidates snapshot before $phase',async ({kind,phase})=>{
        const competitorDraft=communicationService(db).saveDraft({...a,conversationId:other},other,'competitor',{...s.context(a,input()).payload,recipients:['other@example.test']}).id;
        const competitorSource=uuid();human(competitorSource,'Independent synthetic direction.',other,new Date(now-3000).toISOString());
        let sms:string|undefined;
        if(kind==='SMS_scope'){sms=uuid();db.prepare('INSERT INTO bot_composed_sms_authorities(id,action_id,owner_id,executor_id,source_id,draft_id,request_key,request_hash,snapshot_json,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(sms,uuid(),other,other,competitorSource,competitorDraft,'sms',hash(),JSON.stringify({scope:{canonical_case:uuid()}}),r.expiresAt);}
        const {id}=await setup();if(phase==='claim')await s.accept(grant,consume(id,'accept'));const original=io.capture;
        io.capture=async(...args)=>{const proof=await original(...args);
            if(kind==='SMS')db.prepare('INSERT INTO bot_composed_sms_authorities(id,action_id,owner_id,executor_id,source_id,draft_id,request_key,request_hash,snapshot_json,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(uuid(),uuid(),other,other,competitorSource,competitorDraft,'sms',hash(),JSON.stringify({scope:{canonical_case:uuid()}}),r.expiresAt);
            if(kind==='SMS_scope')db.prepare('INSERT INTO compose_scope_reviews(id,authority_id,owner_id,request_key,request_hash,context_revision,evidence_json) VALUES(?,?,?,?,?,?,?)').run(uuid(),sms,other,'new-scope',hash(),hash(),'{}');
            if(kind==='customer'){
                const row=db.prepare('SELECT * FROM customer_email_authorities WHERE id=?').get(id) as Record<string,unknown>,t=JSON.parse(String(row.projection_json));
                const newId=uuid(),newSource=competitorSource,newPayload={...t.payload,recipients:['other@example.test']},newProjection={...t,authorityId:newId,actionId:uuid(),actionFence:canonicalSha256({fixture:newId}),sourceId:newSource,draftId:competitorDraft,payload:newPayload,payloadHash:canonicalSha256(newPayload),canonicalCaseId:uuid(),canonicalOrderId:uuid(),idempotencyKey:'fixture:'+newId};
                const {binding_hash:_binding,...copy}=row;Object.assign(copy,{id:newId,action_id:newProjection.actionId,action_fence:newProjection.actionFence,source_id:newSource,draft_id:competitorDraft,recipient:'other@example.test',request_key:'competing',projection_json:JSON.stringify(newProjection)});
                const columns=Object.keys(copy);db.prepare(`INSERT INTO customer_email_authorities(${columns.join(',')},binding_hash) VALUES(${columns.map(()=>'?').join(',')},?)`).run(...Object.values(copy),canonicalSha256(copy));
            }
            return proof;
        };
        await expect(phase==='accept'?s.accept(grant,consume(id,'accept')):s.claim(grant,consume(id,'claim'))).rejects.toThrow('during source read');
        expect(db.prepare("SELECT count(*) n FROM customer_email_events WHERE authority_id=? AND kind=?").get(id,phase==='accept'?'accepted':'reserved')).toEqual({n:0});
    });
    it.each(['SMS','return'])('prior structured %s canonical overlap rejects reverse customer bind',async kind=>{
        if(kind==='SMS'){
            const smsSource=uuid();human(smsSource,'Synthetic separate SMS.',other,new Date(now-2000).toISOString());
            db.prepare('INSERT INTO bot_composed_sms_authorities(id,action_id,owner_id,executor_id,source_id,draft_id,request_key,request_hash,snapshot_json,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(uuid(),uuid(),other,other,smsSource,draft,'sms',hash(),JSON.stringify({scope:{canonical_case:caseId}}),r.expiresAt);
        }else{
            const decision=uuid(),trust=uuid(),mapping=uuid(),approval=uuid();
            db.prepare('INSERT INTO bot_decisions(id,conversation_id,source_key,proposal_key,proposal_json,assignee_id) VALUES(?,?,?,?,?,2)').run(decision,other,'return','return','{}');
            db.prepare('INSERT INTO return_bridge_trust(id,business_id,owner_id,executor_id,client_id,audience,account_id,principal_id,source_origin,request_key) VALUES(?,?,1,?,?,?,?,?,?,?)').run(trust,r.businessId,other,'fixture-client','fixture-aud',r.sourceAccountId,'fixture-other',r.sourceOrigin,'return');
            db.prepare('INSERT INTO bot_decision_events(id,decision_id,version,kind,actor_id,payload_json,request_key) VALUES(?,?,1,?,2,?,?)').run(approval,decision,'answered','{}','approval');
            db.prepare('INSERT INTO return_bridge_mappings(id,trust_id,decision_id,decision_version,approval_event_id,proposal_hash,request_key,scope_hash,capture_json,receipt_json) VALUES(?,?,?,1,?,?,?,?,?,?)').run(mapping,trust,decision,approval,hash(),'map',hash(),JSON.stringify({conversation:{id:caseId},order:{id:orderId}}),'{}');
            db.prepare('INSERT INTO return_bridge_claims VALUES(?,?,?,?,?,?)').run(uuid(),mapping,decision,'claim',hash(),new Date(now).toISOString());
        }
        const p=await prepared();await expect(s.bind(a,p)).rejects.toThrow('shared native');expect(db.prepare('SELECT count(*) n FROM customer_email_authorities').get()).toEqual({n:0});
    });

    it('competitor insertion after awaited intent read invalidates first association before durable entitlement',async()=>{
        const smsSource=uuid();human(smsSource,'Independent synthetic SMS direction.',other,new Date(now-3000).toISOString());
        const {id}=await setup();await reserve(id);const p=await association(id),original=io.intent;
        io.intent=async(...args)=>{const wire=await original(...args);db.prepare('INSERT INTO bot_composed_sms_authorities(id,action_id,owner_id,executor_id,source_id,draft_id,request_key,request_hash,snapshot_json,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(uuid(),uuid(),other,other,smsSource,draft,'intent-race',hash(),JSON.stringify({scope:{canonical_case:uuid()}}),r.expiresAt);return wire;};
        await expect(s.associate(r.id,p)).rejects.toThrow('during source read');
        expect(db.prepare('SELECT count(*) n FROM customer_email_associations').get()).toEqual({n:0});
        expect(()=>s.serviceAssociation(r.id,{authority_id:id,intent_id:p.intent_id,request_key:p.request_key})).toThrow('not found');
        expect(s.read(grant,{authority_id:id}).association).toBeNull();
    });

});
