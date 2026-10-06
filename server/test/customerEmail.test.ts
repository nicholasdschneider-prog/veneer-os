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
import { emailEnrollment, emailBearer, loadEmailRegistry } from '../src/bots/customerEmailTrust.js';
import { customerEmailRoutes, customerEmailVerifierRoutes } from '../src/bots/customerEmailRoutes.js';
import { canonicalSha256 } from '../src/bots/canonical.js';
import { EMAIL_CONTRACT_HASH, emailRegistration, emailCapture, emailIntent, type EmailRegistration } from '../src/bots/customerEmailContract.js';
import type { EmailIO } from '../src/bots/customerEmailIO.js';
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
        db.prepare('INSERT INTO customer_email_enrollments VALUES(?,?,?,?,?,?)').run(r.id, canonicalSha256(r), 1, 'fixture-enrollment', '{}', new Date(now).toISOString());
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
                    schemaVersion: 'customer-email-capture/v1', captureId: p.capture_id, registrationId: r.id, registrationHash: canonicalSha256(r), sourceRegistrationHash: r.sourceRegistrationHash, guardManifestHash: r.guardManifestHash, sourceArtifactHash: r.sourceArtifactHash, runtime: r.runtime, businessId: r.businessId, accountId: r.sourceAccountId, principalId: actor?.conversationId === owner ? r.sourcePrincipalId : r.executorPrincipalId, executorPrincipalId: r.executorPrincipalId, observedAt: new Date(now).toISOString(), expiresAt: new Date(now + 15000).toISOString(), complete: true, unreviewedMedia: [], canonicalCaseId: p.canonical_case, canonicalCustomerId: p.canonical_customer, canonicalOrderId: p.canonical_order, orderNumber: '123', shopifyOrderId: 'fixture123', caseOwnerPrincipalId: r.executorPrincipalId, leaseId: 'fixture-lease', leaseExpiresAt: new Date(now + 30000).toISOString(), payloadHash: n.payloadHash, payloadAccount: n.payload.account, recipient: n.payload.recipients[0], materialHash: hash(), scopeHash: hash(), identityHash: hash(), contextRevision: n.contextRevision, inventoryHash: n.inventoryHash, records: n.inventory.map(x => ({
                        ...x, relation: x.key === `draft:${draft}` ? 'current_action' : 'unrelated', closureHash: hash()
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
                    key: m.key, revision: m.revision, classification: m.relation as 'unrelated' | 'current_action', explanation: explain
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
        const { id } = await setup();
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
            ...await prepared(), request_key: 'replacement'
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
        expect(employeeRouteAllowed('GET', '/bot-workflows/guide')).toBe(true);
        for (const elevated of [false, true])
            expect(coreVeneerRules({
                workspaceDir: '/repo', assistantSlug: 'bot', elevated
            })).toContain(f.agent);
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
        expect(() => db.prepare('INSERT INTO return_bridge_claims VALUES(?,?,?,?,?,?)').run(uuid(), mapping, decision, 'fixture-return-claim', hash(), new Date(now).toISOString())).toThrow('shared native');
        expect(() => db.prepare('INSERT INTO bot_composed_sms_authorities(id,action_id,owner_id,executor_id,source_id,draft_id,request_key,request_hash,snapshot_json,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(uuid(), 'fixture-sms', owner, executor, source, draft, 'fixture-sms', hash(), JSON.stringify({
            scope: {
                canonical_case: caseId
            }
        }), r.expiresAt)).toThrow('shared native');
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

});
