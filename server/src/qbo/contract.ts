import { z } from 'zod';
import { canonicalSha256 } from '../bots/canonical.js';
export const hash = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().uuid(), ref = z.string().min(1).max(200), time = z.string().datetime({ offset: true });
export const H = (domain: string, value: unknown) => canonicalSha256({ domain, value });
export const operationSchema = z.object({
  kind: z.enum(['query', 'verify-attachment', 'create-bill', 'update-bill', 'attach-pdf']),
  target: z.object({ entity: z.enum(['Query', 'Bill']), id: z.string().regex(/^[1-9][0-9]*$/).nullable(), syncToken: z.string().regex(/^[0-9]+$/).nullable() }).strict(),
  payloadHash: hash,
  attachments: z.array(z.object({ sha256: hash, bytes: z.number().int().positive().safe().max(25 * 1024 * 1024), mime: z.literal('application/pdf') }).strict()).max(1),
  sourceContext: z.array(z.object({ system: z.enum(['gmail-message', 'gmail-thread', 'source-document', 'source-attachment']), id: z.string().min(1).max(4096), revision: hash, contentHash: hash.nullable() }).strict()).min(1).max(20),
  sourceContextHash: hash,
}).strict().superRefine((o, c) => {
  const valid = o.kind === 'query' ? o.target.entity === 'Query' && o.target.id === null && o.target.syncToken === null && !o.attachments.length
    : o.target.entity === 'Bill' && (o.kind === 'create-bill' ? o.target.id === null && o.target.syncToken === null && !o.attachments.length
      : o.target.id !== null && o.target.syncToken !== null && (['attach-pdf', 'verify-attachment'].includes(o.kind) ? o.attachments.length === 1 : !o.attachments.length));
  if (o.sourceContextHash !== H('qbo/source-context/v1', o.sourceContext)) c.addIssue({ code: 'custom', message: 'Source context commitment mismatch' });
  if (!valid) c.addIssue({ code: 'custom', message: 'Exact operation-specific target and attachment scope required' });
});
export const requestSchema = z.object({
  schemaVersion: z.literal('qbo-operation/v1'), bindingRef: id, assignmentRevision: hash, authorityRevision: hash,
  audience: z.literal('qbo-canonical-helper/v1'), requestKey: id, operation: operationSchema,
}).strict();
export const lookupSchema = z.object({ requestKey: id }).strict();
export const factsSchema = z.object({
  bindingRef: id, businessId: id, accountRef: ref, existingGrantRef: ref,
  companyRealm: z.string().regex(/^[1-9][0-9]*$/), companyName: ref, companyInfoId: ref,
  jobId: id, assignmentRevision: hash, assignmentEvidenceHash: hash,
  executorConversationId: id, ownerUserId: z.number().int().positive().safe(),
  authorityRef: ref, authorityRevision: hash, authorityEvidenceHash: hash,
  authorityScopeHash: hash, logicalEffectId: ref, operation: operationSchema,
  sourceRevision: hash, expiresAt: time,
  assignmentState: z.enum(['assigned', 'revoked', 'completed']), authorityState: z.enum(['current', 'revoked']),
  integration: z.object({ audience: z.literal('qbo-canonical-helper/v1'), helperImplementationHash: hash, acceptanceReceiptHash: hash, custodyRevision: hash, expiresAt: time }).strict(),
}).strict();
export type Request = z.infer<typeof requestSchema>;
export type Facts = z.infer<typeof factsSchema>;
export type Caller = { userId: number; conversationId: string; executionConversationId: string | null; sessionExpiresAt: string };
export const effectDigest = (f: Facts) => H('qbo/logical-effect/v1', { businessId: f.businessId, companyRealm: f.companyRealm, existingGrantRef: f.existingGrantRef, logicalEffectId: f.logicalEffectId });
export const sourceReceiptSchema = z.object({
  schemaVersion: z.literal('qbo-helper-receipt/v1'), reservationId: id, effectDigest: hash, scopeHash: hash,
  receiptId: id, outcome: z.enum(['SUCCESS', 'UNKNOWN', 'FAILED_NO_RETRY']),
  evidenceHash: hash, recordedAt: time,
  providerEvidence: z.object({ requestId: ref, responseHash: hash, entityId: ref.nullable() }).strict().nullable(),
}).strict().refine(v => v.outcome !== 'SUCCESS' || v.providerEvidence !== null, 'Successful receipt needs durable provider evidence');
export const reservationSchema = z.object({
  schemaVersion: z.literal('qbo-admission/v1'), reservationId: id, requestKey: id,
  authenticatedCaller: z.object({ userId: z.number().int().positive().safe(), conversationId: id, executionConversationId: id.nullable(), sessionExpiresAt: time }).strict(),
  originalExecutor: id, jobId: id, assignmentRevision: hash, authorityRef: ref, authorityRevision: hash,
  businessId: id, accountRef: ref, existingGrantRef: ref, companyRealm: ref,
  effectDigest: hash, scopeHash: hash, factsHash: hash,
  audience: z.literal('qbo-canonical-helper/v1'), reservedAt: time, expiresAt: time,
}).strict();
export const responseSchema = z.object({
  execute: z.literal(false), refreshEntitlement: z.boolean(), operationEntitlement: z.boolean(), retryAllowed: z.literal(false),
  reservation: reservationSchema,
}).strict().refine(v => v.refreshEntitlement === v.operationEntitlement, 'Entitlements must agree');

export const authorityScope = (f: Facts) => H('qbo/authority-scope/v1', { businessId: f.businessId, accountRef: f.accountRef, existingGrantRef: f.existingGrantRef, companyRealm: f.companyRealm, executorConversationId: f.executorConversationId, operation: f.operation });

const noEntitlement = z.object({ execute: z.literal(false), refreshEntitlement: z.literal(false), operationEntitlement: z.literal(false), retryAllowed: z.literal(false) });
export const inspectResponseSchema = noEntitlement.extend({ authenticatedCaller: reservationSchema.shape.authenticatedCaller, factsHash: hash, scopeHash: hash, assignmentRevision: hash, authorityRevision: hash }).strict();
export const readResponseSchema = z.discriminatedUnion('status', [
  noEntitlement.extend({ status: z.literal('ABSENT') }).strict(),
  noEntitlement.extend({ status: z.literal('RESERVED'), reservation: reservationSchema, receipts: z.array(sourceReceiptSchema).max(100) }).strict(),
]);
export const reconcileResponseSchema = noEntitlement.extend({ reservation: reservationSchema, receipt: sourceReceiptSchema }).strict();
export const errorResponseSchema = z.object({ error: z.string().regex(/^QBO_[A-Z_]+$/).max(120) }).strict();
