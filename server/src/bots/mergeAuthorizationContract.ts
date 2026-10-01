import { z } from 'zod';
import { canonicalSha256 } from './canonical.js';

/**
 * Native side of the agreed merge-authorization contract (build 497/498):
 * out/build497-native/native-merge-contract-proposal.md v4. Hash domains and
 * DTOs are verbatim from §1–§7; a merge is human-approved per unordered pair,
 * source case retained, never automatic.
 */
export const uuid = z.string().uuid();
export const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const text = z.string().min(1).max(2000);
export const time = z.string().datetime({ offset: true });
const revision = z.number().int().positive().safe();
const ticket = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
export const runtimeSchema = z.object({ projectId: uuid, environmentId: uuid, serviceId: uuid }).strict();

/** §1: JCS-canonical SHA-256 with the domain folded in as {domain, value}. */
export const mergeHash = (domain: string, value: unknown) => canonicalSha256({ domain, value });

export const registrationSchema = z.object({
  schemaVersion: z.literal('merge-authorization-registration/v1'), id: uuid, revision, active: z.boolean(), businessId: uuid, ownerUserId: revision,
  sourceOrigin: z.literal('https://orderops-dev-web-production.up.railway.app'), sourceId: z.string().min(1).max(100), runtime: runtimeSchema,
  reviewerConversationId: uuid, executorConversationId: uuid, executorPrincipalId: text, servicePrincipalId: text,
  audience: text, cfClientId: text, bearerHash: hash, readbackCredential: z.object({ project: z.string().regex(/^[\w-]+$/), config: z.string().regex(/^[\w-]+$/), name: z.string().regex(/^MERGE_AUTHORIZATION_[A-Z0-9_]+$/) }).strict(),
  contractHash: hash, expiresAt: time,
}).strict();
export const registrySchema = z.object({ schemaVersion: z.literal('merge-authorization-registry/v1'), registrations: z.array(registrationSchema).max(20) }).strict();
export type Registration = z.infer<typeof registrationSchema>;

export const caseTupleSchema = z.object({ ticket, caseId: uuid, materialRevision: hash, observedAt: time }).strict();
export const casesInput = z.object({ cases: z.array(caseTupleSchema).min(1).max(2) }).strict();

const caseRef = z.object({ ticket, caseId: uuid, materialRevision: hash }).strict();
export const directionSchema = z.enum(['a_into_b', 'b_into_a']);
export const intentInput = z.object({
  schemaVersion: z.literal('orderops-merge-intent/v1'), pairReceiptId: uuid, executorConversationId: uuid,
  cases: z.object({ a: caseRef, b: caseRef }).strict(), offeredDirections: z.array(directionSchema).min(1).max(2),
  candidateId: uuid.optional(), evidenceRevision: hash.optional(), action: z.literal('merge_retain_source'), requestKey: uuid,
}).strict().refine((i) => (i.candidateId === undefined) === (i.evidenceRevision === undefined), { message: 'candidateId and evidenceRevision go together' });
export type IntentInput = z.infer<typeof intentInput>;

/** §1 merge-intent-base/v1: the immutable material of one revision (no requestKey, no timestamps). */
export function intentBase(sourceId: string, businessId: string, i: IntentInput, intentRevision: number) {
  return {
    schemaVersion: i.schemaVersion, sourceId, businessId, pairReceiptId: i.pairReceiptId, intentRevision, executorConversationId: i.executorConversationId,
    cases: { a: i.cases.a, b: i.cases.b }, offeredDirections: [...i.offeredDirections].sort(),
    ...(i.candidateId ? { candidateId: i.candidateId, evidenceRevision: i.evidenceRevision } : {}), action: i.action,
  };
}
export function intentBaseHash(sourceId: string, businessId: string, i: IntentInput, intentRevision: number) {
  return mergeHash('merge-intent-base/v1', intentBase(sourceId, businessId, i, intentRevision));
}
/** §3: one direction of one revision → intentHash. */
export function directedIntent(sourceId: string, businessId: string, i: IntentInput, intentRevision: number, baseHash: string, direction: z.infer<typeof directionSchema>) {
  const from = direction === 'a_into_b' ? i.cases.a : i.cases.b, into = direction === 'a_into_b' ? i.cases.b : i.cases.a;
  return { pairReceiptId: i.pairReceiptId, intentRevision, intentBaseHash: baseHash, direction, from, into, executorConversationId: i.executorConversationId, businessId, sourceId, action: i.action, schemaVersion: i.schemaVersion };
}
export function intentHashFor(sourceId: string, businessId: string, i: IntentInput, intentRevision: number, baseHash: string, direction: z.infer<typeof directionSchema>) {
  return mergeHash('merge-intent/v1', directedIntent(sourceId, businessId, i, intentRevision, baseHash, direction));
}

export const reservationInput = z.object({ pairReceiptId: uuid, intentHash: hash, requestKey: uuid }).strict();
export const redeemInput = z.object({ requestKey: uuid, attemptId: uuid }).strict();
export const nonexecutionInput = z.object({
  requestKey: uuid, attemptId: uuid,
  readback: z.object({ schemaVersion: z.literal('orderops-merge-attempt-readback/v1'), attemptId: uuid, state: z.literal('not_executed'), fencedAt: time, attemptRowHash: hash }).strict(),
}).strict();
/** What native reads back itself from ${sourceOrigin}/api/cs/merge-attempts/:attemptId. */
export const attemptReadbackSchema = z.object({
  schemaVersion: z.literal('orderops-merge-attempt-readback/v1'), attemptId: uuid, pairReceiptId: uuid, generation: revision, reservationId: uuid,
  state: z.enum(['redeeming', 'committed', 'not_executed', 'unknown']), lateCommitFenced: z.boolean(), fencedAt: time.nullable(), attemptRowHash: hash,
}).strict();

export const commitSchema = z.object({
  schemaVersion: z.literal('orderops-merge-commit/v1'), pairReceiptId: uuid, generation: revision, reservationId: uuid, redemptionId: uuid, attemptId: uuid, intentHash: hash,
  preconditions: z.object({ fromMaterialRevision: hash, intoMaterialRevision: hash }).strict(),
  result: z.object({ fromMaterialRevision: hash, intoMaterialRevision: hash, sourceRetained: z.boolean(), sourceCommitId: z.string().min(1).max(200) }).strict(),
  commitHash: hash,
}).strict();
export const candidateSchema = z.object({
  schemaVersion: z.literal('orderops-duplicate-candidate/v1'), candidateId: uuid, pairReceiptId: uuid, intentRevision: revision, evidenceRevision: hash,
  reasons: z.array(z.object({ kind: z.enum(['customer_record', 'email_digest', 'phone_digest', 'order', 'product', 'problem']), evidenceHash: hash, explanation: z.string().min(1).max(200) }).strict()).min(1).max(20),
  identityClusterVerified: z.boolean(), supersedes: uuid.optional(), candidateHash: hash,
}).strict();
export function commitHashOf(c: z.infer<typeof commitSchema>) { const { commitHash, ...rest } = c; void commitHash; return mergeHash('merge-commit/v1', rest); }
export function candidateHashOf(c: z.infer<typeof candidateSchema>) { const { candidateHash, ...rest } = c; void candidateHash; return mergeHash('duplicate-candidate/v1', rest); }
/** §7: evidenceRevision hashes only the sorted set of {kind, evidenceHash}. */
export function evidenceRevisionOf(reasons: { kind: string; evidenceHash: string }[]) {
  const set = [...new Map(reasons.map((r) => [`${r.kind}:${r.evidenceHash}`, { kind: r.kind, evidenceHash: r.evidenceHash }])).values()].sort((x, y) => (`${x.kind}:${x.evidenceHash}` < `${y.kind}:${y.evidenceHash}` ? -1 : 1));
  return mergeHash('duplicate-evidence/v1', set);
}

export const mergedEventSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_.:-]{1,150}$/), type: z.literal('ticket.merged'), ticket_id: ticket, occurred_at: z.string().datetime(), assigned_bot: uuid.optional(), commit: commitSchema,
}).strict();
export const candidateEventSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_.:-]{1,150}$/), type: z.literal('ticket.duplicate_candidate'), ticket_id: ticket, occurred_at: z.string().datetime(), assigned_bot: uuid, candidate: candidateSchema,
}).strict();
export type MergedEvent = z.infer<typeof mergedEventSchema>;
export type CandidateEvent = z.infer<typeof candidateEventSchema>;
/** §1 bot-event/v1: the full canonical envelope. */
export function eventHashOf(sourceId: string, event: object) { return mergeHash('bot-event/v1', { sourceId, ...event }); }

/** Addendum (standing rule): OrderOps asserts under custody that a pair is a clear duplicate. */
export const standingBasisSchema = z.object({ kind: z.literal('same_customer_record_and_order'), customerRecordHash: hash, orderHash: hash, bothTicketsOpen: z.literal(true) }).strict();
export const standingApprovalInput = z.object({ pairReceiptId: uuid, intentRevision: revision, direction: directionSchema, basis: standingBasisSchema, requestKey: uuid }).strict();
export const standingToggleInput = z.object({ registrationId: uuid, enabled: z.boolean(), reason: z.string().trim().max(500).optional() }).strict();

export const MERGE_CONTRACT_HASH = '3d4356ab24624f99cee4840170597ea40918b9bedd8d1fa980ff8d1c870b634e';
