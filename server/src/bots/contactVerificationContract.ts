import { z } from 'zod';
import { canonicalSha256 } from './canonical.js';
export const uuid = z.string().uuid(), hash = z.string().regex(/^[a-f0-9]{64}$/), text = z.string().min(1).max(2000), time = z.string().datetime({ offset: true }), revision = z.number().int().positive().safe();
export const contactHash = (domain: string, value: unknown) => canonicalSha256({ domain, value });
const runtime = z.object({ projectId: uuid, environmentId: uuid, serviceId: uuid }).strict();
const origin = z.string().url().refine(s => { try {
    const u = new URL(s);
    return u.protocol === 'https:' && !u.username && !u.password && u.origin === s;
}
catch {
    return false;
} }, 'Exact HTTPS origin required');
export const targetSchema = z.object({ caseId: uuid, orderId: uuid, caseCustomerId: uuid, orderCustomerId: uuid, caseRevision: text, orderRevision: text, caseCustomerRevision: text, orderCustomerRevision: text, contactRevision: hash, materialRevision: hash }).strict().refine(t => t.caseCustomerId !== t.orderCustomerId, 'Two distinct existing customer records required');
const executor = z.object({ conversationId: uuid, userId: revision, principalId: text, enrollmentId: uuid, enrollmentRevision: revision, identityEvidenceHash: hash }).strict();
export const channel = z.enum(['email', 'sms']);
const slot = z.object({ slotId: uuid, kind: z.literal('source_generated_single_use_link'), channel, entropyBits: z.literal(256), encoding: z.literal('base64url'), origin, path: z.string().regex(/^\/[A-Za-z0-9/_-]+$/), placement: z.literal('fragment'), fragmentEncoding: z.literal('generation-channel-secret/v1'), generationBinding: z.literal('authority_generation_channel_intent') }).strict();
const segments = z.array(z.discriminatedUnion('kind', [z.object({ kind: z.literal('literal'), text: z.string().max(10000) }).strict(), z.object({ kind: z.literal('slot'), slotId: uuid }).strict()])).min(1).max(30);
export const channelSchema = z.object({ channel, accountId: text, from: text, recipient: text, subject: z.string().max(300), segments, slot, attachments: z.array(z.object({ name: text, sha256: hash }).strict()).max(10), renderingVersion: z.literal('contact-template-utf8/v1'), templateHash: hash }).strict().superRefine((v, c) => {
    const slots = v.segments.filter(x => x.kind === 'slot');
    if (slots.length !== 1 || slots[0]?.slotId !== v.slot.slotId || v.slot.channel !== v.channel)
        c.addIssue({ code: 'custom', message: 'Exactly one matching secret slot required' });
    if (v.channel === 'sms' && (v.subject !== '' || v.attachments.length || !/^\+[1-9][0-9]{7,14}$/.test(v.from) || !/^\+[1-9][0-9]{7,14}$/.test(v.recipient)))
        c.addIssue({ code: 'custom', message: 'SMS exact E164 endpoints and no subject/media required' });
    if (v.channel === 'email' && (!z.string().email().safeParse(v.from).success || !z.string().email().safeParse(v.recipient).success))
        c.addIssue({ code: 'custom', message: 'Exact email endpoints required' });
    const { templateHash, ...body } = v;
    if (templateHash !== contactHash('contact-verification/template/v1', body))
        c.addIssue({ code: 'custom', message: 'Template hash mismatch' });
});
export const manifestSchema = z.object({ schemaVersion: z.literal('paired-contact-manifest/v1'), manifestId: uuid, manifestRevision: revision, registrationId: uuid, registrationRevision: revision, businessId: uuid, accountId: text, sourceOrigin: origin, runtime, target: targetSchema, executor, statement: text, statementHash: hash, channels: z.tuple([channelSchema, channelSchema]), manifestHash: hash }).strict().superRefine((m, c) => {
    if (m.channels[0].channel !== 'email' || m.channels[1].channel !== 'sms' || m.channels[0].slot.slotId === m.channels[1].slot.slotId)
        c.addIssue({ code: 'custom', message: 'Ordered independent email and SMS channels required' });
    if (m.statementHash !== contactHash('contact-verification/statement/v1', m.statement))
        c.addIssue({ code: 'custom', message: 'Statement hash mismatch' });
    const { manifestHash, ...body } = m;
    if (manifestHash !== contactHash('contact-verification/manifest/v1', body))
        c.addIssue({ code: 'custom', message: 'Manifest hash mismatch' });
});
export type Manifest = z.infer<typeof manifestSchema>;
const targetIds = z.object({ caseId: uuid, orderId: uuid, caseCustomerId: uuid, orderCustomerId: uuid }).strict();
const ref = z.object({ project: z.string().regex(/^[\w-]+$/), config: z.string().regex(/^[\w-]+$/), name: z.string().regex(/^CONTACT_VERIFICATION_[A-Z0-9_]+$/) }).strict();
export const registrationSchema = z.object({ schemaVersion: z.literal('contact-verification-registration/v1'), id: uuid, revision, active: z.boolean(), businessId: uuid, ownerUserId: revision, accountId: text, sourceOrigin: origin, runtime, target: targetIds, executor, ownerConversationId: uuid, servicePrincipalId: text, audience: text, cfClientId: text, bearerHash: hash, readerCredential: ref, custodyReceiptHash: hash, sourceAcceptanceHash: hash, rendererAcceptanceHash: hash, redemptionAcceptanceHash: hash, contractHash: hash, expiresAt: time, credentialExpiresAt: time, channels: z.tuple([z.object({ channel: z.literal('email'), accountId: text, from: text, recipient: text, origin, path: z.string() }).strict(), z.object({ channel: z.literal('sms'), accountId: text, from: text, recipient: text, origin, path: z.string() }).strict()]) }).strict();
export type Registration = z.infer<typeof registrationSchema>;
export const registrySchema = z.object({ schemaVersion: z.literal('contact-verification-registry/v1'), registrations: z.array(registrationSchema).max(50) }).strict();
export const evidenceSchema = z.object({ schemaVersion: z.literal('paired-contact-evidence/v1'), registrationId: uuid, registrationHash: hash, servicePrincipalId: text, manifest: manifestSchema, sourceRevision: hash, coverage: z.object({ complete: z.boolean(), omissions: z.array(text).max(30) }).strict(), blockers: z.array(text).max(30), observedAt: time, expiresAt: time, evidenceHash: hash }).strict().superRefine((e,c)=>{ if(e.registrationId!==e.manifest.registrationId || e.evidenceHash!==contactHash('contact-verification/evidence/v1',evidenceMaterial(e)) || !observationValid(e)) c.addIssue({code:'custom',message:'Invalid manifest evidence binding/hash/observation'}); });
export type Evidence = z.infer<typeof evidenceSchema>;
export function evidenceMaterial(e: {observedAt:string;expiresAt:string;evidenceHash:string;[key:string]:unknown}) { const { observedAt, expiresAt, evidenceHash, ...v } = e; return v; }
export const authoritySchema = z.object({ schemaVersion: z.literal('paired-contact-authority/v1'), authorityId: uuid, revision: z.literal(1), registrationId: uuid, registrationRevision: revision, registrationHash: hash, decisionId: uuid, decisionVersion: revision, approvalEventId: uuid, approverUserId: revision, proposalHash: hash, contextHash: hash, manifest: manifestSchema, manifestHash: hash, sourceRevision: hash, evidenceHash: hash, issuedAt: time, expiresAt: time, authorityHash: hash }).strict().superRefine((a,c)=>{ const {authorityHash,...v}=a; if(authorityHash!==contactHash('contact-verification/authority/v1',v)||a.registrationId!==a.manifest.registrationId||a.registrationRevision!==a.manifest.registrationRevision||a.manifestHash!==a.manifest.manifestHash||Date.parse(a.expiresAt)<=Date.parse(a.issuedAt)||Date.parse(a.expiresAt)>Date.parse(a.issuedAt)+900000)c.addIssue({code:'custom',message:'Invalid authority hash/binding/expiry'}); });
export type Authority = z.infer<typeof authoritySchema>;
export const associationInput = z.object({ schemaVersion: z.literal('contact-dispatch-association/v1'), authorityId: uuid, authorityHash: hash, registrationId: uuid, registrationRevision: revision, generationId: uuid, channel, intentId: uuid, intentHash: hash, requestKey: uuid, templateHash: hash, slotCommitment: hash, wirePayloadHash: hash, sourceRevision: hash, materialRevision: hash, providerIdempotencyKey: uuid }).strict();
const intentCore = z.object({ intentId: uuid, channel, requestKey: uuid, templateHash: hash, slotCommitment: hash, wirePayloadHash: hash, providerIdempotencyKey: uuid, intentHash: hash }).strict();
export const generationSchema = z.object({ schemaVersion: z.literal('paired-contact-generation/v1'), generationId: uuid, authorityId: uuid, authorityHash: hash, registrationId: uuid, registrationHash: hash, businessId: uuid, manifestHash: hash, sourceRevision: hash, materialRevision: hash, executorPrincipalId: text, preparedEventId: uuid, preparedAt: time, expiresAt: time, intents: z.tuple([intentCore, intentCore]), generationHash: hash }).strict().superRefine((g,c)=>{const {generationHash,...v}=g; if(generationHash!==contactHash('contact-verification/generation/v1',v)||g.intents[0].channel!=='email'||g.intents[1].channel!=='sms'||g.intents.some(i=>i.intentHash!==intentDigest(g,i))||Date.parse(g.preparedAt)>=Date.parse(g.expiresAt))c.addIssue({code:'custom',message:'Invalid paired generation hash/order/expiry'}); for(const k of ['intentId','requestKey','providerIdempotencyKey','slotCommitment'] as const)if(g.intents[0][k]===g.intents[1][k])c.addIssue({code:'custom',message:'Distinct channel identities and commitments required'}); });
export type Generation = z.infer<typeof generationSchema>;
export function intentDigest(g: {generationId:string;authorityId:string;authorityHash:string;registrationId:string;registrationHash:string;businessId:string;manifestHash:string;sourceRevision:string;materialRevision:string;executorPrincipalId:string}, i: z.infer<typeof intentCore>) { const { intentHash, ...binding } = i; return contactHash('contact-verification/intent/v1', { generationId: g.generationId, authorityId: g.authorityId, authorityHash: g.authorityHash, registrationId: g.registrationId, registrationHash: g.registrationHash, businessId: g.businessId, manifestHash: g.manifestHash, sourceRevision: g.sourceRevision, materialRevision: g.materialRevision, executorPrincipalId: g.executorPrincipalId, ...binding }); }
export const outcomeSchema = z.object({ schemaVersion: z.literal('contact-dispatch-outcome/v1'), state: z.enum(['SENT_ACCEPTED', 'UNKNOWN', 'ROLLED_BACK_TERMINAL']), associationId: uuid.nullable(), providerId: text.nullable(), providerAccountId: text, providerIdempotencyKey: uuid, wirePayloadHash: hash, auditEventId: uuid, recordedAt: time, noRetry: z.literal(true), outcomeHash: hash }).strict().superRefine((o,c)=>{const {outcomeHash,...v}=o;if(outcomeHash!==contactHash('contact-verification/outcome/v1',v)||(o.state==='SENT_ACCEPTED'?(!o.associationId||!o.providerId):o.providerId!==null)||(o.state==='ROLLED_BACK_TERMINAL'&&!o.associationId))c.addIssue({code:'custom',message:'Invalid outcome hash/state/correlation'});});
function observationValid(e:{observedAt:string;expiresAt:string}) {return Date.parse(e.expiresAt)>Date.parse(e.observedAt)&&Date.parse(e.expiresAt)<=Date.parse(e.observedAt)+15000;}
function validateIntentEvidence(e: {registrationId:string;registrationHash:string;generation:Generation;intentId:string;state:string;redeemingEventId:string;redeemingAt:string;sendingEventId:string|null;sendingAt:string|null;pairBlock:{eventId:string;at:string;reason:string;intentId:string}|null;associationId:string|null;outcome:z.infer<typeof outcomeSchema>|null;observedAt:string;expiresAt:string;evidenceHash:string}, c:z.RefinementCtx) {
 const g=e.generation, i=g.intents.find(i=>i.intentId===e.intentId), o=e.outcome, t=Date.parse;
 const fail=(message:string)=>c.addIssue({code:'custom',message});
 if(!observationValid(e)||e.evidenceHash!==contactHash('contact-verification/dispatch-evidence/v1',intentMaterial(e))||e.registrationId!==g.registrationId||e.registrationHash!==g.registrationHash||!i)fail('Invalid source intent binding/hash/observation');
 if(g.preparedEventId===e.redeemingEventId||t(g.preparedAt)>t(e.redeemingAt)||t(e.redeemingAt)>=t(g.expiresAt)||t(e.redeemingAt)>t(e.observedAt))fail('Invalid prepare/redemption ordering');
 if((e.sendingEventId===null)!==(e.sendingAt===null)||(['SENDING','SENT_ACCEPTED'].includes(e.state)&&!e.sendingEventId))fail('Required durable SENDING fence');
 if(e.sendingAt&&!e.associationId)fail('SENDING always retains exact association');
 if(e.sendingAt&&(t(e.sendingAt)<t(e.redeemingAt)||t(e.sendingAt)>=t(g.expiresAt)||t(e.sendingAt)>t(e.observedAt)||[g.preparedEventId,e.redeemingEventId].includes(e.sendingEventId!)))fail('Invalid SENDING audit/expiry');
 if(e.state==='REDEEMING'&&(e.associationId!==null||o!==null||e.sendingAt!==null))fail('Contradictory REDEEMING state');
 if(e.state==='SENDING'&&(!e.associationId||o!==null))fail('Contradictory SENDING state');
 if(['SENT_ACCEPTED','UNKNOWN','ROLLED_BACK_TERMINAL'].includes(e.state)&&(!o||o.state!==e.state||o.associationId!==e.associationId))fail('Contradictory terminal/unknown outcome');
 if(['UNKNOWN','ROLLED_BACK_TERMINAL'].includes(e.state)&&!e.pairBlock)fail('Permanent pair block required');
 if(e.pairBlock&&(!g.intents.some(i=>i.intentId===e.pairBlock!.intentId)||t(e.pairBlock.at)<t(g.preparedAt)||t(e.pairBlock.at)>t(e.observedAt)||[g.preparedEventId,e.redeemingEventId,e.sendingEventId].includes(e.pairBlock.eventId)))fail('Invalid permanent pair block');
 if(o&&i&&(o.providerIdempotencyKey!==i.providerIdempotencyKey||o.wirePayloadHash!==i.wirePayloadHash||t(o.recordedAt)<t(e.sendingAt??e.redeemingAt)||t(o.recordedAt)>t(e.observedAt)||[g.preparedEventId,e.redeemingEventId,e.sendingEventId].includes(o.auditEventId)))fail('Outcome crosses intent or audit ordering');
}
export const intentEvidenceSchema = z.object({ schemaVersion: z.literal('contact-dispatch-evidence/v1'), registrationId: uuid, registrationHash: hash, servicePrincipalId: text, generation: generationSchema, intentId: uuid, state: z.enum(['REDEEMING', 'SENDING', 'SENT_ACCEPTED', 'UNKNOWN', 'ROLLED_BACK_TERMINAL']), redeemingEventId: uuid, redeemingAt: time, sendingEventId: uuid.nullable(), sendingAt: time.nullable(), pairBlock: z.object({eventId:uuid,at:time,reason:z.enum(['UNKNOWN','ROLLED_BACK_TERMINAL']),intentId:uuid}).strict().nullable(), associationId: uuid.nullable(), outcome: outcomeSchema.nullable(), observedAt: time, expiresAt: time, evidenceHash: hash }).strict().superRefine(validateIntentEvidence);
export type IntentEvidence = z.infer<typeof intentEvidenceSchema>;
export function intentMaterial(e: {observedAt:string;expiresAt:string;evidenceHash:string;[key:string]:unknown}) { const { observedAt, expiresAt, evidenceHash, ...v } = e; return v; }
export const inspectInput = z.object({ registrationId: uuid, decisionId: uuid, expectedVersion: revision }).strict();
export const issueInput = inspectInput.extend({ inspectionHash: hash, requestKey: uuid, expiresAt: time }).strict();
export const associationSchema = z.object({ id: uuid, binding: associationInput, registrationHash: hash, generationHash: hash, createdAt: time }).strict();
export const associationResponse = z.object({ execute: z.literal(false), dispatchEntitlement: z.boolean(), association: associationSchema }).strict();
export const reconcileResponse = associationResponse.extend({ dispatchEntitlement: z.literal(false) }).strict();
export const lookupResponse=z.object({execute:z.literal(false),dispatchEntitlement:z.literal(false),retryAllowed:z.literal(false),association:associationSchema.nullable()}).strict();
export const exportResponse = z.object({ execute: z.literal(false), dispatchEntitlement: z.literal(false), authority: authoritySchema, observedAt: time, expiresAt: time }).strict();
export const receiptResponse = z.object({ execute: z.literal(false), dispatchEntitlement: z.literal(false), associationId: uuid, outcome: outcomeSchema }).strict();
// Exact published native candidate; production requires separate source acceptance and enrollment.
export const CONTACT_CONTRACT_HASH = '9ff5bb2cbbdd687b5d590a3395ac24f0eda0ecf9750b44e9e3d01faeda3379fb';
