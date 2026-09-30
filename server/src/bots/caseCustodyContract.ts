import { z } from 'zod';
import { canonicalSha256 } from './canonical.js';
export const uuid = z.string().uuid();
export const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const text = z.string().min(1).max(2000);
export const time = z.string().datetime({ offset: true });
export const version = z.string().min(1).max(100); // Opaque PostgreSQL version: never parse/round it.
const revision = z.number().int().positive().safe();
export const runtimeSchema = z.object({ projectId: uuid, environmentId: uuid, serviceId: uuid }).strict();
export const custodyHash = (domain: string, value: unknown) => canonicalSha256({ domain, value });
const ref = z.object({ project: z.string().regex(/^[\w-]+$/), config: z.string().regex(/^[\w-]+$/), name: z.string().regex(/^[A-Z][A-Z0-9_]+$/) }).strict();
export const registrationSchema = z.object({
    schemaVersion: z.literal('case-custody-registration/v1'), id: uuid, revision, active: z.boolean(), businessId: uuid, ownerUserId: revision,
    sourceOrigin: z.literal('https://orderops-dev-web-production.up.railway.app'), accountId: text, runtime: runtimeSchema,
    reviewerConversationId: uuid, executorConversationId: uuid, executorPrincipalId: text,
    servicePrincipalId: text, audience: text, cfClientId: text, bearerHash: hash, readerCredential: ref,
    historicalEnrollment: z.object({ id: uuid, revision, principalId: text, identityEvidenceHash: hash }).strict(), destinationEnrollment: z.object({ id: uuid, revision, principalId: text, identityEvidenceHash: hash }).strict(),
    custodyReceiptHash: hash, sourceAcceptanceHash: hash, contractHash: hash, expiresAt: time, credentialExpiresAt: time,
}).strict();
export const registrySchema = z.object({ schemaVersion: z.literal('case-custody-registry/v1'), registrations: z.array(registrationSchema).max(20) }).strict();
export type Registration = z.infer<typeof registrationSchema>;
export const enrollmentSchema = z.object({ id: uuid, revision, principalId: text, mode: z.enum(['historical_only', 'active_destination']), identityEvidenceHash: hash, revoked: z.boolean(), retired: z.boolean() }).strict();
export const transitionSchema = z.object({ schemaVersion: z.literal('prospective-custody-transition/v1'), ledger: z.literal('cs_prospective_custody'), caseId: uuid, expectedCustodyRevision: z.literal(0), expectedCustodyOwner: z.null(), destinationPrincipalId: text, permittedChanges: z.tuple([z.literal('insert_prospective_custody_ledger')]), caseMutation: z.literal(false), historicalMutation: z.literal(false) }).strict();
export const preparationSchema = z.object({ preparedEventId: uuid, preparedAt: time, preparedContentHash: hash, redeemingEventId: uuid, redeemingAt: time, transitionRevision: z.literal(1) }).strict();
export const outcomeSchema = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('APPLIED'), auditEventId: uuid, committedAt: time, beforeCaseVersion: version, afterCaseVersion: version, beforeCustodyRevision: z.literal(0), afterCustodyRevision: z.literal(1), transition: transitionSchema, transitionHash: hash }).strict(),
    z.object({ kind: z.literal('ROLLED_BACK_TERMINAL'), auditEventId: uuid, recordedAt: time, rollbackEvidenceHash: hash, noRetry: z.literal(true) }).strict(),
]);
export const evidenceSchema = z.object({
    schemaVersion: z.literal('case-custody-evidence/v1'), registrationId: uuid, registrationRevision: revision, servicePrincipalId: text,
    businessId: uuid, accountId: text, sourceOrigin: text, runtime: runtimeSchema, caseId: uuid, ticket: text,
    caseVersion: version, materialRevision: hash, status: z.literal('complete'), closedAt: time.nullable(), resolvedAt: time.nullable(),
    completion: z.object({ eventCaseId: uuid, eventId: z.string().regex(/^[1-9][0-9]*$/), eventHash: hash, principalId: text, eventAt: version, caseVersion: version, chronology: z.enum(['event_not_after_case_version', 'event_after_case_version_unbound', 'unavailable']), linkage: z.enum(['bound', 'unbound']) }).strict(),
    from: enrollmentSchema, to: enrollmentSchema, transition: transitionSchema, transitionHash: hash,
    blockers: z.array(text).max(50), priorEffects: z.array(z.object({ id: text, revision: hash, summary: text, disposition: z.enum(['no_effect', 'completed', 'unknown']) }).strict()).max(100),
    coverage: z.object({ complete: z.boolean(), omissions: z.array(text).max(50) }).strict(),
    observedAt: time, expiresAt: time, snapshotHash: hash,
}).strict();
export type Evidence = z.infer<typeof evidenceSchema>;
export function evidenceMaterial(e: Evidence) { const { observedAt, expiresAt, snapshotHash, ...material } = e; return material; }
export const inspectionInput = z.object({ registrationId: uuid, caseId: uuid, instructionKind: z.enum(['direct_message', 'result_reply']), instructionId: uuid }).strict();
export const citationSchema = z.object({ kind: z.enum(['direct_message', 'result_reply']), id: uuid, text: z.string().min(1).max(120000) }).strict();
export const reviewSchema = z.object({
    reviewedFullContext: z.literal(true), instruction: citationSchema, interpretation: z.enum(['unconditional_prospective_custody', 'status_only', 'quoted', 'conditional', 'ambiguous']),
    explanation: z.string().min(20).max(3000),
    context: z.array(z.object({ citation: citationSchema, classification: z.enum(['supports', 'status_only', 'resolved_prior_constraint', 'supersedes', 'ambiguous', 'quoted']), explanation: z.string().min(10).max(2000) }).strict()).max(1000),
    effects: z.array(z.object({ id: text, revision: hash, disposition: z.literal('reconciled_no_parallel_effect'), explanation: z.string().min(10).max(2000) }).strict()).max(100),
    scope: z.literal('prospective_completed_case_custody_only'), noUnresolvedConditions: z.literal(true),
}).strict();
export const issueInput = inspectionInput.extend({ inspectionHash: hash, review: reviewSchema, requestKey: uuid, expiresAt: time }).strict();
export const authoritySchema = z.object({ schemaVersion: z.literal('prospective-case-custody/v1'), id: uuid, revision: z.literal(1), registrationId: uuid, registrationHash: hash,
    businessId: uuid, accountId: text, sourceOrigin: text, runtime: runtimeSchema, caseId: uuid, caseVersion: version, materialRevision: hash,
    completion: evidenceSchema.shape.completion, closedAt: time.nullable(), resolvedAt: time.nullable(), from: enrollmentSchema, to: enrollmentSchema, transition: transitionSchema, transitionHash: hash,
    reviewerConversationId: uuid, executorConversationId: uuid, contextHash: hash, instructionHash: hash, reviewHash: hash, sourceEvidenceHash: hash,
    provenance: z.object({ instructionKind: z.enum(['direct_message', 'result_reply']), instructionId: uuid, humanAuthorId: revision, authorityBasis: z.literal('current_business_owner_instruction'), authorityBasisRevision: hash, reviewRecordId: uuid, contextManifest: z.array(z.object({ kind: z.enum(['direct_message', 'result_reply']), id: uuid, contentHash: hash }).strict()).max(1000) }).strict(),
    scope: z.literal('prospective_completed_case_custody_only'), issuedAt: time, expiresAt: time, authorityHash: hash,
}).strict();
export type Authority = z.infer<typeof authoritySchema>;
export const claimInput = z.object({ schemaVersion: z.literal('case-custody-claim/v1'), authorityId: uuid, authorityHash: hash, sourceRequestId: uuid, sourceRequestHash: hash, requestKey: uuid }).strict();
export const sourceIntentSchema = z.object({ schemaVersion: z.literal('case-custody-intent/v1'), registrationId: uuid, servicePrincipalId: text, businessId: uuid, accountId: text, sourceOrigin: text, runtime: runtimeSchema,
    sourceRequestId: uuid, sourceRequestHash: hash, authorityId: uuid, authorityHash: hash, requestKey: uuid, caseId: uuid, executorPrincipalId: text,
    state: z.enum(['REDEEMING', 'APPLIED', 'UNKNOWN', 'ROLLED_BACK_TERMINAL']), claimId: uuid.nullable(), receiptHash: hash.nullable(),
    preparation: preparationSchema, transition: transitionSchema, transitionHash: hash, outcome: outcomeSchema.nullable(), observedAt: time, expiresAt: time,
}).strict();
export type SourceIntent = z.infer<typeof sourceIntentSchema>;
export const sourceRequestTupleSchema = z.object({ schemaVersion: z.literal('case-custody-request/v1'), registrationId: uuid, authorityId: uuid, authorityHash: hash, sourceRequestId: uuid, caseId: uuid, executorPrincipalId: text, transitionHash: hash }).strict();
export function sourceRequestDigest(i: z.infer<typeof sourceIntentSchema>) { return custodyHash('case-custody/request/v1', sourceRequestTupleSchema.parse({ schemaVersion: 'case-custody-request/v1', registrationId: i.registrationId, authorityId: i.authorityId, authorityHash: i.authorityHash, sourceRequestId: i.sourceRequestId, caseId: i.caseId, executorPrincipalId: i.executorPrincipalId, transitionHash: i.transitionHash })); }
export const claimSummarySchema = z.object({ id: uuid, authorityId: uuid, sourceRequestId: uuid, createdAt: time, authorityHash: hash, sourceRequestHash: hash, requestKey: uuid }).strict();
export const claimResponseSchema = z.object({ execute: z.literal(false), custodyEntitlement: z.boolean(), claim: claimSummarySchema.nullable() }).strict().refine(x => !x.custodyEntitlement || x.claim !== null, { message: 'Entitlement requires durable claim' });
export const claimReconciliationSchema = z.object({ execute: z.literal(false), custodyEntitlement: z.literal(false), claim: claimSummarySchema.nullable() }).strict();
export const exportResponseSchema = z.object({ execute: z.literal(false), custodyEntitlement: z.literal(false), authority: authoritySchema, observedAt: time, expiresAt: time }).strict();
export const issueResponseSchema = z.object({ execute: z.literal(false), custodyEntitlement: z.literal(false), authority: authoritySchema, replayed: z.boolean() }).strict();
export const readResponseSchema = z.object({ execute: z.literal(false), custodyEntitlement: z.literal(false), authority: authoritySchema, claim: claimSummarySchema.nullable(), revoked: z.boolean() }).strict();
export const receiptResponseSchema = z.object({ execute: z.literal(false), custodyEntitlement: z.literal(false), state: z.enum(['APPLIED', 'UNKNOWN', 'ROLLED_BACK_TERMINAL']), claimId: uuid, receiptHash: hash.nullable() }).strict();
export const revokeResponseSchema = z.object({ execute: z.literal(false), custodyEntitlement: z.literal(false), reservationIrrevocable: z.boolean() }).strict();
export const nativeMessageSchema = z.object({ id: uuid, actor_id: z.number().int(), actor_conversation_id: z.string().nullable().optional(), text: z.string(), created_at: z.string(), kind: z.enum(['direct_message', 'result_reply']), proposals_json: z.string().optional(), source_text: z.string().optional(), anchor: z.string().optional(), thread_id: z.string().optional() }).strict();
export const nativeSnapshotSchema = z.object({ input: inspectionInput, context: z.object({ direct: z.array(nativeMessageSchema).max(500), replies: z.array(nativeMessageSchema).max(500), decisions: z.array(z.object({ id: z.string(), version: z.number(), handling_revision: z.number(), state: z.string(), proposal_json: z.string(), answer_json: z.string().nullable() }).strict()).max(500), discussions: z.array(z.never()).max(0) }).strict(), human: z.array(nativeMessageSchema).max(1000), instruction: nativeMessageSchema, contextHash: hash, instructionHash: hash }).strict();
export const inspectionResponseSchema = z.object({ execute: z.literal(false), authority: z.literal(false), inspectionHash: hash, binding: z.object({ registrationHash: hash, contextHash: hash, instructionHash: hash, sourceEvidenceHash: hash, input: inspectionInput }).strict(), native: nativeSnapshotSchema, evidence: evidenceSchema }).strict();
export function validateSourceIntent(i: SourceIntent) {
    if (i.sourceRequestHash !== sourceRequestDigest(i) || i.preparation.preparedContentHash !== i.sourceRequestHash || i.preparation.preparedEventId === i.preparation.redeemingEventId || Date.parse(i.preparation.preparedAt) > Date.parse(i.preparation.redeemingAt) || Date.parse(i.preparation.redeemingAt) > Date.parse(i.observedAt) || i.transition.caseId !== i.caseId || i.transition.destinationPrincipalId !== i.executorPrincipalId || i.transitionHash !== custodyHash('case-custody/transition/v1', i.transition))
        throw Error('Invalid source intent binding');
    if (i.state === 'REDEEMING') {
        if (i.claimId !== null || i.outcome !== null || i.receiptHash !== null)
            throw Error('Invalid redeeming intent');
    }
    else if (i.state === 'UNKNOWN') {
        if (i.outcome !== null || i.receiptHash !== null)
            throw Error('Invalid unknown intent');
    }
    else {
        if (!i.claimId || !i.outcome || i.outcome.kind !== i.state || i.receiptHash !== custodyHash('case-custody/outcome/v1', i.outcome))
            throw Error('Invalid terminal intent');
        const o = i.outcome;
        if (o.kind === 'APPLIED' && (o.beforeCaseVersion !== o.afterCaseVersion || o.transitionHash !== i.transitionHash || canonicalSha256(o.transition) !== canonicalSha256(i.transition) || Date.parse(o.committedAt) > Date.parse(i.observedAt) || Date.parse(o.committedAt) < Date.parse(i.preparation.redeemingAt)))
            throw Error('Invalid applied transition');
        if (o.kind === 'ROLLED_BACK_TERMINAL' && (Date.parse(o.recordedAt) < Date.parse(i.preparation.redeemingAt) || Date.parse(o.recordedAt) > Date.parse(i.observedAt)))
            throw Error('Invalid rollback observation');
    }
    return i;
}
export const CUSTODY_CONTRACT_HASH = '970c6170699273aa42222fc7dcd4565383ef942e43bd22c0d7ce052db4603131';
