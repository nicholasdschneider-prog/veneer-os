import { z } from 'zod';
import { exactDraftPayload } from './draftPayload.js';
import { canonicalSha256 } from './canonical.js';
export const emailId = z.string().uuid();
export const emailKey = z.string().min(1).max(200).regex(/^[A-Za-z0-9:_.-]+$/);
export const emailHash = z.string().regex(/^[a-f0-9]{64}$/);
const time = z.string().datetime(), explanation = z.string().min(20).max(3000);
export const EMAIL_CONTRACT = 'customer-email-direction-dispatch/v1' as const;
export const emailInput = z.object({
    source_owner_id: emailId, source_kind: z.enum(['direct_message', 'result_reply']), source_id: emailId, executor_id: emailId, draft_id: emailId, draft_version: z.number().int().positive()
}).strict();
export const emailCaptureInput = emailInput.extend({
    registration_id: emailId, capture_id: emailId, canonical_case: emailId, canonical_customer: emailId, canonical_order: emailId
}).strict();
const citation = z.object({
    kind: z.enum(['direct_message', 'result_reply', 'decision_discussion', 'voice_dispatch', 'decision_event']), id: z.string().min(1).max(200), text: z.string().min(1).max(120000)
}).strict();
export const emailReview = z.object({
    reviewed_full_context: z.literal(true), interpretation: z.literal('unconditional_compose_and_send'), instruction: citation, composition_explanation: explanation, send_explanation: explanation,
    later_context: z.array(z.object({
        citation, classification: z.enum(['unrelated', 'status_only', 'supersedes', 'ambiguous']), explanation
    }).strict()).max(2000),
    records: z.array(z.object({
        key: emailKey, revision: emailHash, classification: z.enum(['unrelated', 'current_action', 'blocking']), explanation
    }).strict()).max(5000),
    body_parts: z.array(z.object({
        start: z.number().int().nonnegative(), end: z.number().int().positive(), human_ids: z.array(z.string().min(1)).min(1).max(100), evidence: explanation
    }).strict()).min(1).max(100), unresolved_choices: z.array(z.string()).length(0)
}).strict();
export const emailBind = emailCaptureInput.extend({
    inspection_hash: emailHash, request_key: emailKey, review: emailReview
}).strict();
export const emailConsume = z.object({
    authority_id: emailId, capture_id: emailId, request_key: emailKey, payload_hash: emailHash
}).strict();
export const emailLookup = z.object({
    source_owner_id: emailId, source_kind: z.enum(['direct_message', 'result_reply']), source_id: emailId, draft_id: emailId, request_key: emailKey
}).strict();
const credential = z.object({
    project: emailKey, config: emailKey, name: z.string().regex(/^[A-Z][A-Z0-9_]{0,199}$/)
}).strict();
export const emailRegistration = z.object({
    schemaVersion: z.literal('customer-email-registration/v1'), id: emailId, revision: z.number().int().positive(), active: z.boolean(), businessId: emailId, ownerUserId: z.number().int().positive(), sourceOwnerId: emailId, executorId: emailId, executorUserId: z.number().int().positive(), sourcePrincipalId: emailKey, executorPrincipalId: emailKey, sourceAccountId: emailKey, payloadAccount: z.string().email(), sourceOrigin: z.literal('https://orderops-dev-web-production.up.railway.app'), runtime: z.object({
        projectId: emailId, environmentId: emailId, serviceId: emailId
    }).strict(),
    sourceCredential: credential, executorCredential: credential, serviceReadCredential: credential, servicePrincipalId: emailKey, serviceBearerHash: emailHash, nativeAudience: emailKey, cfClientId: emailKey,
    contractHash: emailHash, sourceArtifactHash: emailHash, nativeArtifactHash: emailHash, guardManifestHash: emailHash, sourceRegistrationHash: emailHash, custodyReceipt: emailKey, acceptanceReceipt: emailKey, expiresAt: time,
    credentialExpiresAt: time, readbackExpiresAt: time, custodyExpiresAt: time, acceptedAt: time
}).strict();
export const emailRegistry = z.object({
    schemaVersion: z.literal('customer-email-registry/v1'), registrations: z.array(emailRegistration).max(30)
}).strict();
export type EmailRegistration = z.infer<typeof emailRegistration>;
export type EmailInput = z.infer<typeof emailInput>;
export type EmailCaptureInput = z.infer<typeof emailCaptureInput>;
export const emailRecord = z.object({
    key: emailKey, revision: emailHash
}).strict();
export const emailScopeRecord = emailRecord.extend({
    relation: z.enum(['unrelated', 'current_action', 'blocking', 'unknown']), closureHash: emailHash
}).strict();
export const emailCapture = z.object({
    schemaVersion: z.literal('customer-email-capture/v1'), captureId: emailId, registrationId: emailId, registrationHash: emailHash, sourceRegistrationHash: emailHash, guardManifestHash: emailHash, sourceArtifactHash: emailHash, runtime: emailRegistration.shape.runtime, businessId: emailId, accountId: emailKey, principalId: emailKey, executorPrincipalId: emailKey,
    observedAt: time, expiresAt: time, complete: z.literal(true), unreviewedMedia: z.array(emailKey).length(0), canonicalCaseId: emailId, canonicalCustomerId: emailId, canonicalOrderId: emailId, orderNumber: emailKey, shopifyOrderId: emailKey, caseOwnerPrincipalId: emailKey, leaseId: emailKey, leaseExpiresAt: time,
    payloadHash: emailHash, payloadAccount: z.string().email(), recipient: z.string().email(), materialHash: emailHash, scopeHash: emailHash, identityHash: emailHash, contextRevision: emailHash, inventoryHash: emailHash, records: z.array(emailScopeRecord).max(5000),
    suppression: z.literal('clear'), duplicates: z.literal('clear'), ownership: z.literal('exclusive'), crossActionFenceHash: emailHash, sourceMaterial: z.record(z.string(), z.unknown()), snapshotHash: emailHash
}).strict();
export type EmailCapture = z.infer<typeof emailCapture>;
export const emailProjection = z.object({
    schemaVersion: z.literal(EMAIL_CONTRACT), authorityId: emailId, actionId: emailId, actionFence: emailHash, registrationId: emailId, registrationHash: emailHash, contractHash: emailHash, sourceRegistrationHash: emailHash, guardManifestHash: emailHash, sourceArtifactHash: emailHash, nativeArtifactHash: emailHash, businessId: emailId, sourceOwnerId: emailId, sourceKind: emailInput.shape.source_kind, sourceId: emailId, sourceHash: emailHash, contextRevision: emailHash, inventoryHash: emailHash, executorId: emailId, executorPrincipalId: emailKey, draftId: emailId, draftVersion: z.number().int().positive(), payload: exactDraftPayload, payloadHash: emailHash, canonicalCaseId: emailId, canonicalCustomerId: emailId, canonicalOrderId: emailId, orderNumber: emailKey, shopifyOrderId: emailKey, sourceAccountId: emailKey, materialHash: emailHash, scopeHash: emailHash, identityHash: emailHash, crossActionFenceHash: emailHash, idempotencyKey: emailKey, expiresAt: time
}).strict();
export type EmailProjection = z.infer<typeof emailProjection>;
export const emailAssociation = z.object({
    authority_id: emailId, claim_id: emailId, intent_id: emailId, request_key: emailKey, authority_hash: emailHash, context_revision: emailHash, capture_id: emailId
}).strict();
export const emailIntent = z.object({
    schemaVersion: z.literal('customer-email-intent/v1'), registrationId: emailId, principalId: emailKey, runtime: emailRegistration.shape.runtime, intentId: emailId, authorityId: emailId, authorityHash: emailHash, claimId: emailId, requestKey: emailKey, idempotencyKey: emailKey, payloadHash: emailHash, contextRevision: emailHash, materialHash: emailHash, state: z.enum(['association_requested', 'dispatching', 'UNKNOWN', 'NO_EFFECT', 'SENT_ACCEPTED']), preProviderCommitted: z.boolean(), associationId: emailId.nullable(), receipt: z.object({
        provider: z.literal('gmail'), providerMessageId: emailKey, messageId: emailKey, account: z.string().email(), recipient: z.string().email(), subject: z.string(), body: z.string(), attachments: z.array(z.never()).length(0), cc: z.array(z.never()).length(0), bcc: z.array(z.never()).length(0), acceptedAt: time, payloadHash: emailHash, idempotencyKey: emailKey
    }).strict().nullable()
}).strict();
/** Stable serialized Zod contract, including bounds, enum values and strict shapes.
 * Refinement functions are represented by the reviewed artifact hash. */
export function emailSchemaManifest(schema: z.ZodTypeAny): unknown {
    const d = schema._def as Record<string, unknown>, kind = String(d.typeName);
    if (kind === 'ZodObject') {
        const shape = (d.shape as () => Record<string, z.ZodTypeAny>)();
        return {
            kind, unknownKeys: d.unknownKeys, fields: Object.fromEntries(Object.entries(shape).map(([k, v]) => [k, emailSchemaManifest(v)]))
        };
    }
    if (kind === 'ZodArray')
        return {
            kind, min: d.minLength, max: d.maxLength, exact: d.exactLength, item: emailSchemaManifest(d.type as z.ZodTypeAny)
        };
    if (kind === 'ZodOptional' || kind === 'ZodNullable' || kind === 'ZodDefault')
        return {
            kind, inner: emailSchemaManifest(d.innerType as z.ZodTypeAny)
        };
    if (kind === 'ZodEffects')
        return {
            kind, effectType: (d.effect as {
                type: string;
            }).type, inner: emailSchemaManifest(d.schema as z.ZodTypeAny)
        };
    if (kind === 'ZodRecord')
        return {
            kind, key: emailSchemaManifest(d.keyType as z.ZodTypeAny), value: emailSchemaManifest(d.valueType as z.ZodTypeAny)
        };
    if (kind === 'ZodEnum')
        return {
            kind, values: d.values
        };
    if (kind === 'ZodLiteral')
        return {
            kind, value: d.value
        };
    if (['ZodString', 'ZodNumber', 'ZodBoolean', 'ZodNever', 'ZodUnknown'].includes(kind))
        return {
            kind, checks: Array.isArray(d.checks)?d.checks.map((c:Record<string,unknown>)=>Object.fromEntries(Object.entries(c).map(([k,v])=>[k,v instanceof RegExp?{pattern:v.source,flags:v.flags}:v]))):d.checks
        };
    throw new Error('Unsupported customer email contract schema');
}
export const EMAIL_WIRE_MANIFEST = {
    contract: EMAIL_CONTRACT, projection: emailSchemaManifest(emailProjection), capture: emailSchemaManifest(emailCapture), intent: emailSchemaManifest(emailIntent), association: emailSchemaManifest(emailAssociation), encoding: 'canonical-json-utf8-sha256', replay: 'never-entitles', nativeClaim: 'reserve-only'
};
export const EMAIL_CONTRACT_HASH = canonicalSha256(EMAIL_WIRE_MANIFEST);
