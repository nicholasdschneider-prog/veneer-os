import {manifestSchema as contactVerificationManifestSchema} from './contactVerificationContract.js';
import { timingProposalSchema, timingHumanContext } from './purchaseTimingSchema.js';
import { withEditedReply } from './replyEdit.js';
import { approvedMessageSchema } from './draftPayload.js';
import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { canonicalSha256 } from './canonical.js';
import { orderReference, shopifyOrderSchema } from './orderReference.js';
import type { ConversationRow, UserRow } from '../db/db.js';
import { canViewConversation, canSendToConversation, sameBusiness } from '../conversations/access.js';

const text = z.string().trim().min(1).max(12000);
export const evidenceSchema = z
  .object({ label: text, conversation_id: z.string().min(1) })
  .strict();
export const caseTimelineEntrySchema = z.object({
  when: z.string().trim().min(1).max(100).nullable(),
  actor: z.string().trim().min(1).max(160),
  bot: z.string().trim().min(1).max(120).nullable().optional(),
  channel: z.string().trim().min(1).max(80).nullable().optional(),
  kind: z.enum(['event', 'request', 'promise', 'proposal']),
  summary: z.string().trim().min(1).max(400),
  source: z.string().trim().min(1).max(600),
}).strict();
export const decisionChoiceSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  label: z.string().trim().min(1).max(120),
  description: z.string().trim().max(300).optional(),
  action: z.enum(['approve', 'reject', 'defer', 'withdraw']),
  /** The concrete value a tap hands back to the bot (a pack, a date, a wording). */
  answer: z.string().trim().min(1).max(300).optional(),
  /** The bot's researched best guess; rendered first. At most one per proposal. */
  recommended: z.boolean().optional(),
}).strict();
/** The reserved id of the human's typed "Something else" answer; never a bot-supplied choice. */
export const CUSTOM_CHOICE_ID = 'custom';
export const CUSTOM_CHOICE_LABEL = 'Something else';
const GENERIC_CHOICE_LABELS = new Set(['yes','no','ok','okay','approve','approved','approve recommendation','approve as proposed','approve proposal','approve this','confirm','confirmed','accept','accepted','reject','rejected','reject proposal','decline','declined','proceed','go ahead','do it','sounds good','not now','hold','withdraw','withdraw request','cancel','other','something else']);
const PHOTO_RE = /\b(photo|photos|picture|pictures|image|images|attachment|attachments|screenshot|screenshots)\b/i;
const MONEY_RE = /\b(refund|refunded|refunds|reimburse|chargeback|credit back|money back|store credit|partial credit)\b/i;
/**
 * A question must carry what the human needs to answer it. If it talks about
 * photos, the photos are on the card. If it touches money, the refund facts
 * are verified and cited, never "not verified" next to a recommended refund.
 */
export function validateDecisionEvidence(p: { question: string; recommendation: string; consequence: string; review_summary?: { request?: string; customer_request?: string; background?: string[]; refund?: { status: string } } | undefined; message_delivery?: { payload: { body: string } } | undefined; images?: unknown[] | undefined; evidence_items?: EvidenceItem[] | undefined }): void {
  const items = p.evidence_items ?? [];
  const humanText = [p.question, p.review_summary?.request, p.review_summary?.customer_request, ...(p.review_summary?.background ?? [])].filter(Boolean).join('\n');
  const files = (p.images?.length ?? 0) + items.filter(i => i.kind === 'image' || i.kind === 'document').length;
  if (PHOTO_RE.test(humanText) && files === 0)
    throw new BotError(400, 'This question refers to photos or attachments but attaches none. Add them as evidence_items (kind image/document from gmail, orderops or a chat file) so the human can see them on the card. If the right photos do not exist yet, ask the customer for them first and raise the question afterwards.');
  const moneyText = [humanText, p.recommendation, p.consequence, p.message_delivery?.payload.body].filter(Boolean).join('\n');
  if (MONEY_RE.test(moneyText) || p.review_summary?.refund) {
    const refund = p.review_summary?.refund;
    if (!refund || refund.status === 'not_verified')
      throw new BotError(400, 'This question involves a refund or credit but review_summary.refund is not verified. Read the order’s refund history (Shopify/OrderOps) first and supply refund with status none, partial or full plus its source, scope and as_of.');
    if (!items.some(i => i.kind === 'record' && (i.source.system === 'shopify' || i.source.system === 'orderops')))
      throw new BotError(400, 'Cite the refund facts as a record evidence item from shopify or orderops (order id, refund ids and amounts in text) so the human sees them on the card.');
  }
}

const normalizeLabel = (label: string) => label.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
/**
 * A bot-raised question must arrive with researched, self-explaining options:
 * an informed best guess and viable alternatives the human can tap without
 * re-deriving the answer. Generic labels without a description are refused;
 * the human's own typed answer is reserved as `custom`.
 */
export function validateDecisionChoices(choices: z.infer<typeof decisionChoiceSchema>[] | undefined): void {
  if (!choices || choices.length < 2) throw new BotError(400, 'Supply at least two researched proposal.choices: your best guess with its evidence and a viable alternative. Generic approve/reject buttons are not offered by default.');
  if (choices.some(c => c.id === CUSTOM_CHOICE_ID || normalizeLabel(c.label) === normalizeLabel(CUSTOM_CHOICE_LABEL))) throw new BotError(400, 'The "Something else" typed answer is added by Veneer; do not supply it as a choice');
  if (choices.filter(c => c.recommended).length > 1) throw new BotError(400, 'Mark at most one choice as recommended');
  for (const c of choices) {
    if (!c.description && GENERIC_CHOICE_LABELS.has(normalizeLabel(c.label)))
      throw new BotError(400, `Choice "${c.label}" is generic. Name the concrete action or answer (for example "10×4×4 poly, 27 oz" or "Send this reply to the customer") or add a description explaining what the tap does.`);
  }
}
export const defaultDecisionChoices = [
  { id: 'approve', label: 'Approve as proposed', action: 'approve' },
  { id: 'reject', label: 'Reject proposal', action: 'reject' },
  { id: 'defer', label: 'Not now', action: 'defer' },
  { id: 'withdraw', label: 'Withdraw request', action: 'withdraw' },
] as const;
/**
 * Evidence the bot brings onto the card so the human decides in one place.
 * Files are fetched/retained by the server at raise time and bound by hash;
 * record excerpts are the bot's own read of a source system and carry the
 * exact ids so they can be re-checked.
 */
// Gmail attachment IDs are opaque: preserve every character. 4096 is a local
// resource bound (not a claimed provider maximum), with headroom above observed ~450-character IDs.
export const evidenceSourceSchema = z.discriminatedUnion('system', [
  // A file already detected in a bot conversation (today's images path).
  z.object({ system: z.literal('chat_file'), conversation_id: z.string().min(1).max(200), path: z.string().min(1).max(4096) }).strict(),
  // A file a human uploaded from the chat composer (DATA_DIR/uploads).
  z.object({ system: z.literal('upload'), path: z.string().min(1).max(4096) }).strict(),
  z.object({ system: z.literal('gmail'), account: z.string().trim().min(1).max(320).optional(), message_id: z.string().trim().min(1).max(200), attachment_id: z.string().min(1).max(4096).optional(), filename: z.string().trim().min(1).max(300).optional() }).strict(),
  z.object({ system: z.literal('orderops'), ticket_id: z.string().trim().min(1).max(200), attachment_id: z.string().trim().min(1).max(200).optional(), message_id: z.string().trim().min(1).max(200).optional() }).strict(),
  z.object({ system: z.literal('shopify'), order_id: z.string().trim().min(1).max(200), order_number: z.string().trim().min(1).max(100).optional(), refund_ids: z.array(z.string().trim().min(1).max(200)).max(20).optional() }).strict(),
]);
export const evidenceItemSchema = z.object({
  kind: z.enum(['image', 'document', 'message', 'record']),
  label: z.string().trim().min(1).max(200),
  source: evidenceSourceSchema,
  /** Excerpt for message/record items (sender, time, quoted text, or the facts read). */
  text: z.string().trim().max(2000).optional(),
  /** Server-set for retained bytes; preserve on revise, omit for new files. */
  sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  /** Server-set: bytes retained and served from the decision. */
  retained: z.boolean().optional(),
  captured_at: z.string().datetime({ offset: true }).optional(),
  added_by: z.enum(['bot', 'human']).optional(),
}).strict();
export type EvidenceItem = z.infer<typeof evidenceItemSchema>;
/** The situation behind a question was settled outside the question, so no human answer is needed any more. */
export const MOOT_REASONS = ['order_fulfilled', 'order_cancelled', 'order_closed', 'ticket_closed'] as const;
export type MootReason = (typeof MOOT_REASONS)[number];
/** Order numbers compare without the leading # and case. */
export function normalizeOrderNumber(value: string): string { return value.trim().replace(/^#+/, '').trim().toLowerCase(); }
interface MootProposal { shopify_order?: { number?: string } | null; as_of?: { orders?: { order_number: string }[]; moot_when?: MootReason[] } }
/** Every order a question is bound to: the declared as_of.orders plus its Shopify order reference. */
export function decisionOrders(proposal: MootProposal): string[] {
  return [...new Set([...(proposal.as_of?.orders ?? []).map((o) => o.order_number), proposal.shopify_order?.number ?? ''].map(normalizeOrderNumber).filter(Boolean))];
}
/** What the world looked like when the question was asked. */
export const asOfSchema = z.object({
  captured_at: z.string().datetime({ offset: true }),
  ticket_id: z.string().trim().min(1).max(200).optional(),
  ticket_status: z.string().trim().min(1).max(80).optional(),
  last_inbound: z.array(z.object({ channel: z.string().trim().min(1).max(40), message_id: z.string().trim().min(1).max(200), at: z.string().datetime({ offset: true }).optional() }).strict()).max(12).default([]),
  evidence_hashes: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(48).default([]),
  /** Other tickets this question depends on (a merge pair's sibling, a related order); events on any of them stale the question. */
  related_ticket_ids: z.array(z.object({ ticket_id: z.string().trim().min(1).max(200), material_revision: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict()).max(12).optional(),
  /** Orders this question depends on. When one is fulfilled, cancelled or closed the question no longer needs a human answer. */
  orders: z.array(z.object({ order_number: z.string().trim().min(1).max(100), order_id: z.string().trim().min(1).max(200).optional() }).strict()).max(12).optional(),
  /** Which outside resolutions make the question moot. Omitted means all of them. */
  moot_when: z.array(z.enum(MOOT_REASONS)).min(1).max(MOOT_REASONS.length).optional(),
}).strict();
/** Binding of a merge question to one registered intent revision and direction (merge-authorization contract §3). */
export const mergeIntentRefSchema = z.object({ pairReceiptId: z.string().uuid(), intentRevision: z.number().int().positive(), direction: z.enum(['a_into_b', 'b_into_a']) }).strict();
export interface StaleMark {
  reason: 'customer_replied' | 'ticket_created' | 'status_changed' | 'evidence_changed' | 'ticket_closed' | 'ticket_merged' | 'duplicate_evidence_changed' | 'order_fulfilled' | 'order_cancelled' | 'order_closed';
  since: string; detail: string; event_id?: string;
  /** The situation was settled elsewhere: the question leaves Open questions at once and is withdrawn unless the bot revises it. */
  resolved?: boolean;
}
export const decisionImageSchema = z.object({
  conversation_id: z.string().min(1).max(200),
  path: z.string().min(1).max(4096),
  label: z.string().trim().min(1).max(200),
  source: z.string().trim().min(1).max(300),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();
export const reviewSummarySchema = z.object({
  action_title: z.string().trim().min(1).max(160),
  request: z.string().trim().min(1).max(600).optional(),
  customer_request: z.string().trim().min(1).max(300).optional(),
  background: z.array(z.string().trim().min(1).max(240)).max(6),
  refund: z.discriminatedUnion('status', [
    z.object({ status: z.literal('not_verified') }).strict(),
    z.object({ status: z.literal('none'), source: z.string().trim().min(1).max(600),
      as_of: z.string().datetime({ offset: true }), scope: z.string().trim().min(1).max(300),
      evidence_kind: z.literal('complete_refund_history') }).strict(),
    z.object({ status: z.enum(['partial', 'full']), source: z.string().trim().min(1).max(600),
      as_of: z.string().datetime({ offset: true }), scope: z.string().trim().min(1).max(300),
      evidence_kind: z.literal('completed_refund'), receipt: z.string().trim().min(1).max(300),
      amount: z.number().positive().finite(), currency: z.string().regex(/^[A-Z]{3}$/) }).strict(),
  ]).optional(),
}).strict();
export const proposalSchema = z
  .object({
    review_summary: reviewSummarySchema.optional(),
    choices: z.array(decisionChoiceSchema).min(2).refine(items => new Set(items.map(item => item.id)).size === items.length, "Choice IDs must be unique").optional(),
    question: text,
    recommendation: text,
    consequence: text,
    assignee_id: z.number().int().positive(),
    team: z.string().max(160).default(''),
    deadline: z.string().datetime({ offset: true }).nullable().default(null),
    message_delivery: approvedMessageSchema.optional(),
    purchase_timing: timingProposalSchema.optional(),
    contact_verification: contactVerificationManifestSchema.optional(),
    images: z.array(decisionImageSchema).max(12).optional(),
    evidence_items: z.array(evidenceItemSchema).max(24).optional(),
    as_of: asOfSchema.optional(),
    merge_intent: mergeIntentRefSchema.optional(),
    evidence: z.array(evidenceSchema).max(30).default([]),
    blocked_action: text,
    blocks_scope: z.enum(['task', 'workload']).default('task'),
    shopify_order: shopifyOrderSchema.nullable().optional(),
    case_timeline: z.array(caseTimelineEntrySchema).max(12).optional(),
  })
  .strict();
/**
 * AutoShip package decisions (docs/autoship-answer-bridge.md, option A): the
 * server-owned proposal variant the verifier can validate. Every binding field
 * is explicit so a consumer can match its own expected order, lines, material,
 * composition and package versions byte-for-byte. `binding_hash` must equal the
 * canonical SHA-256 of `autoshipBinding(proposal)`; `scope: 'order'` requires
 * `allow_solo_templates: false`, so an order approval can never widen into a
 * shared-template write.
 */
export const autoshipLineSchema = z
  .object({ line_id: z.string().trim().min(1).max(200), sku: z.string().trim().min(1).max(200), quantity: z.number().int().positive() })
  .strict();
export const autoshipProposalSchema = proposalSchema
  .extend({
    kind: z.literal('autoship_package'),
    scope: z.enum(['order', 'shared_template']),
    allow_solo_templates: z.boolean(),
    order_id: z.string().trim().min(1).max(200),
    merchant_order_number: z.string().trim().min(1).max(200),
    orderops_id: z.string().trim().min(1).max(200),
    shopify_order_id: z.string().trim().min(1).max(200),
    lines: z.array(autoshipLineSchema).min(1).max(200),
    material_version: z.string().trim().min(1).max(200),
    composition_key: z.string().trim().min(1).max(200),
    composition_version: z.string().trim().min(1).max(200),
    composition_source_hash: z.string().trim().regex(/^[0-9a-f]{64}$/),
    package_version: z.number().int().nonnegative(),
    package_teaching_key: z.string().trim().min(1).max(200),
    binding_hash: z.string().trim().regex(/^[0-9a-f]{64}$/),
  })
  .strict()
  .superRefine((p, ctx) => {
    if (p.scope === 'order' && p.allow_solo_templates)
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['allow_solo_templates'], message: 'order scope cannot allow solo template writes' });
    if (p.binding_hash !== canonicalSha256(autoshipBinding(p)))
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['binding_hash'], message: 'binding_hash does not match the canonical binding' });
  });
export type AutoshipProposal = z.infer<typeof autoshipProposalSchema>;
/** Accepted on raise/revise: the AutoShip variant, else the generic proposal. */
export const proposalInputSchema = z.union([autoshipProposalSchema, proposalSchema]);
export type Proposal = z.infer<typeof proposalInputSchema>;
export function isAutoshipProposal(p: unknown): p is AutoshipProposal {
  return Boolean(p && typeof p === 'object' && (p as { kind?: unknown }).kind === 'autoship_package');
}
/** The exact binding fields a consumer must match (permission fields included). */
export function autoshipBinding(p: Omit<AutoshipProposal, 'binding_hash'>) {
  return {
    kind: p.kind,
    scope: p.scope,
    allow_solo_templates: p.allow_solo_templates,
    order_id: p.order_id,
    merchant_order_number: p.merchant_order_number,
    orderops_id: p.orderops_id,
    shopify_order_id: p.shopify_order_id,
    lines: p.lines.map((l) => ({ line_id: l.line_id, sku: l.sku, quantity: l.quantity })),
    material_version: p.material_version,
    composition_key: p.composition_key,
    composition_version: p.composition_version,
    composition_source_hash: p.composition_source_hash,
    package_version: p.package_version,
    package_teaching_key: p.package_teaching_key,
  };
}
export type Decision = {
  id: string;
  conversation_id: string;
  source_key: string;
  proposal_key: string;
  version: number;
  state: string;
  proposal_json: string;
  assignee_id: number;
  handler_id: number | null;
  handling_revision: number;
  stale_json: string | null;
  answer_json: string | null;
  result_json: string | null;
  parked_json: string | null;
  created_at: string;
  updated_at: string;
};
export type Actor = { user: UserRow; conversationId?: string };
export class BotError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export function createBotService(db: Database.Database) {
  const conversation = (id: string) =>
    db.prepare('SELECT * FROM conversations WHERE id=?').get(id) as
      | ConversationRow
      | undefined;
  function chat(actor: Actor, id: string) {
    const c = conversation(id);
    if (!c || !canViewConversation(actor.user, c, db) || !sameBusiness(db, actor.conversationId, c))
      throw new BotError(404, 'Bot or decision not found');
    return c;
  }
  function evidenceAllowed(actor: Actor, p: Proposal, botId?: string) {
    if (p.images?.some(image => !image.sha256)) throw new BotError(400, 'Image evidence must be bound to its verified bytes');
    for (const e of [...p.evidence, ...(p.images ?? [])]) {
      const c = chat(actor, e.conversation_id);
      if (!sameBusiness(db, botId, c)) throw new BotError(403, 'Cross-business evidence is not allowed');
    }
  }
  function decisionEvidenceAllowed(actor: Actor, p: Proposal, d: Decision) {
    // Only an already-eligible human in the explicit CS queue may read the
    // proposal's own context without access to every referenced source chat.
    // This does not grant source history, links, images or file access.
    if (!nonexclusive(d) || !eligible(actor,d)) return evidenceAllowed(actor,p,d.conversation_id);
    if (p.images?.some(image => !image.sha256)) throw new BotError(400, 'Image evidence must be bound to its verified bytes');
    const target=conversation(d.conversation_id)!;
    for(const e of [...p.evidence,...(p.images ?? [])]) {
      const source=conversation(e.conversation_id);
      try { const accessible=chat(actor,e.conversation_id); if (!sameBusiness(db,d.conversation_id,accessible)) throw new BotError(403,'Cross-business evidence is not allowed'); continue; } catch { /* scoped fallback only below */ }
      if(!source || source.business_team_id!==target.business_team_id || source.user_id!==target.user_id || source.visibility!=='team')
        throw new BotError(404,'Decision evidence is outside shared business scope');
    }
  }
  function read(actor: Actor, id: string) {
    const d = db.prepare('SELECT * FROM bot_decisions WHERE id=?').get(id) as
      | Decision
      | undefined;
    if (!d) throw new BotError(404, 'Decision not found');
    chat(actor, d.conversation_id);
    decisionEvidenceAllowed(actor, JSON.parse(d.proposal_json), d);
    // Reading or changing another decision means the response turn has switched
    // scope. Human browsing must never affect the bot's activity.
    if (actor.conversationId) {
      db.prepare(`UPDATE pending_turns SET discussion_message_id=NULL WHERE conversation_id=?
        AND discussion_message_id IN (SELECT id FROM bot_decision_events WHERE decision_id<>?)`).run(actor.conversationId, d.id);
    }
    return d;
  }
  function owner(actor: Actor, d: Decision) {
    if (actor.conversationId !== d.conversation_id)
      throw new BotError(403, 'Only the owning bot may perform this action');
    if (
      !db
        .prepare(
          'SELECT 1 FROM bot_registrations WHERE conversation_id=? AND active=1',
        )
        .get(d.conversation_id)
    )
      throw new BotError(409, 'Bot registration is inactive');
  }
  function human(actor: Actor) {
    if (actor.conversationId)
      throw new BotError(403, 'A human answer is required');
  }
  function shared(d: Decision) {
    if (!db.prepare('SELECT 1 FROM shared_bot_queues WHERE conversation_id=?').get(d.conversation_id)) return false;
    const c = conversation(d.conversation_id)!;
    // An opt-in queue shares only decisions addressed to its owner or its
    // explicitly authorized staff, never unrelated approvers' authority.
    return d.assignee_id === c.user_id || Boolean(db.prepare('SELECT 1 FROM employee_bot_access WHERE user_id=? AND conversation_id=?').get(d.assignee_id, c.id));
  }
  function nonexclusive(d: Decision) {
    return shared(d) && Boolean(db.prepare('SELECT 1 FROM nonexclusive_bot_queues q JOIN conversations c ON c.id=q.conversation_id WHERE q.conversation_id=? AND q.business_id=c.business_team_id').get(d.conversation_id));
  }
  function eligible(actor: Actor, d: Decision) {
    if (actor.conversationId) return false;
    const c = conversation(d.conversation_id)!;
    if (!canSendToConversation(actor.user, c, db)) return false;
    if (!shared(d)) return actor.user.id === d.assignee_id;
    return actor.user.id === c.user_id || Boolean(db.prepare('SELECT 1 FROM employee_bot_access WHERE user_id=? AND conversation_id=?').get(actor.user.id, c.id));
  }
  function approver(actor: Actor, d: Decision) {
    human(actor);
    if (!eligible(actor, d)) throw new BotError(403, shared(d) ? 'Only an authorized teammate may answer' : 'Only the assigned approver may answer');
  }
  function handlingCas(d: Decision, revision: number | undefined) {
    if (revision !== d.handling_revision) throw new BotError(409, 'Handling changed. Reload before continuing.');
  }
  function reconcileDiscussionHandling(
    actor: Actor, d: Decision, messageId: string,
    source: { actor_id: number; handling_revision: number }, key: string,
  ) {
    if (source.handling_revision === d.handling_revision) return;
    const reject = () => { throw new BotError(409, 'Handling changed. This instruction cannot be safely reconciled; request a new current instruction.'); };
    if (!shared(d) || d.handler_id !== null || d.answer_json !== null || d.state !== 'needs_input' ||
      source.handling_revision >= d.handling_revision) reject();
    // Immutable event order, not timestamps, must account for EVERY revision
    // after the instruction. Only same-author claim/release transitions ending
    // unowned qualify. A leading release also needs proof of the original claim.
    const history = db.prepare(`SELECT id,kind,version,actor_id,actor_conversation_id,payload_json
      FROM bot_decision_events WHERE decision_id=? AND rowid >
      (SELECT rowid FROM bot_decision_events WHERE id=?)
      AND kind IN ('handling','answered','revised') ORDER BY rowid`).all(d.id, messageId) as {
        id: string; kind: string; version: number; actor_id: number;
        actor_conversation_id: string | null; payload_json: string;
      }[];
    if (history.length === 0 ||
      history.length !== d.handling_revision - source.handling_revision) reject();
    const initiallyOwned = history.length % 2 !== 0;
    let originalClaimId: string | null = null;
    if (initiallyOwned) {
      const prior = db.prepare(`SELECT id,version,actor_id,actor_conversation_id,payload_json
        FROM bot_decision_events WHERE decision_id=? AND kind='handling' AND rowid <
        (SELECT rowid FROM bot_decision_events WHERE id=?) ORDER BY rowid DESC LIMIT 1`)
        .get(d.id, messageId) as (typeof history)[number] | undefined;
      let claim: { action?: unknown; revision?: unknown; version?: unknown } | null = null;
      try { if (prior) claim = JSON.parse(prior.payload_json); } catch { reject(); }
      if (!prior || prior.version !== d.version || prior.actor_id !== source.actor_id ||
        prior.actor_conversation_id !== null || claim?.action !== 'claim' ||
        claim.revision !== source.handling_revision - 1 || claim.version !== d.version) reject();
      originalClaimId = prior!.id;
    }
    const transitions = history.map((e, index) => {
      let payload: { action?: unknown; revision?: unknown; version?: unknown } | null;
      try { payload = JSON.parse(e.payload_json); } catch { return reject(); }
      const revision = source.handling_revision + index;
      const action = (index + Number(initiallyOwned)) % 2 === 0 ? 'claim' : 'release';
      if (e.kind !== 'handling' || e.version !== d.version || e.actor_id !== source.actor_id ||
        e.actor_conversation_id !== null || payload?.action !== action ||
        payload.revision !== revision || payload.version !== d.version) return reject();
      return { event_id: e.id, actor_id: e.actor_id, action, from_revision: revision, to_revision: revision + 1 };
    });
    event(actor, d, 'discussion_handling_reconciled', {
      message_id: messageId, author_id: source.actor_id, version: d.version,
      original_handling_revision: source.handling_revision,
      original_handler_claim_event_id: originalClaimId,
      reconciled_handling_revision: d.handling_revision, transitions,
    }, key + ':handling-reconciliation');
  }
  function validateProposal(actor: Actor, p: Proposal, botId: string, existing?: Decision) {
    evidenceAllowed(actor, p, botId);
    const user = db
      .prepare("SELECT * FROM users WHERE id=? AND status='active'")
      .get(p.assignee_id) as UserRow | undefined;
    const c = conversation(botId)!;
    if (!user || !canViewConversation(user, c, db))
      throw new BotError(400, 'Approver must have access to the bot');
    if(existing) decisionEvidenceAllowed({user},p,{...existing,assignee_id:p.assignee_id});
    else evidenceAllowed({ user }, p);
    // Evidence must also be accessible to the permanent owner at execution time.
    const botOwner = db
      .prepare('SELECT * FROM users WHERE id=?')
      .get(c.user_id) as UserRow;
    evidenceAllowed({ user: botOwner }, p);
    if(p.purchase_timing){
      const timing=p.purchase_timing;
      const source=db.prepare(`SELECT c.request_json,c.received_at,t.executor_id,t.business_id,t.owner_id,
        EXISTS(SELECT 1 FROM purchase_timing_revocations r WHERE r.trust_id=t.id) AS revoked
        FROM purchase_timing_captures c JOIN purchase_timing_trust t ON t.id=c.trust_id WHERE c.id=?`).get(timing.capture_id) as {request_json:string;received_at:string;executor_id:string;business_id:string;owner_id:number;revoked:number}|undefined;
      if(!source || source.revoked || source.executor_id!==botId || source.business_id!==c.business_team_id || source.owner_id!==c.user_id || canonicalSha256(JSON.parse(source.request_json).scope)!==canonicalSha256(timing.scope))
        throw new BotError(409,'Purchase timing requires unchanged authenticated source evidence for this executor');
      const prior=existing?JSON.parse(existing.proposal_json).purchase_timing:null;
      if(!prior || canonicalSha256(prior)!==canonicalSha256(timing)){
        if(Date.now()-Date.parse(source.received_at)>30000 || Date.parse(timing.scope.authorization_expires_at)<=Date.now())
          throw new BotError(409,'Fresh purchase timing source evidence required before raising or revising scope');
      }
    }

  }
  function event(
    actor: Actor,
    d: Decision,
    kind: string,
    payload: unknown,
    key: string,
  ) {
    const id = crypto.randomUUID();
    db.prepare(
      'INSERT INTO bot_decision_events(id,decision_id,version,kind,actor_id,actor_conversation_id,payload_json,request_key) VALUES(?,?,?,?,?,?,?,?)',
    ).run(
      id,
      d.id,
      d.version,
      kind,
      actor.user.id,
      actor.conversationId ?? null,
      JSON.stringify(payload),
      key,
    );
    return id;
  }
  function replay(
    actor: Actor,
    d: Decision,
    key: string,
    kind: string,
    payload: unknown,
  ) {
    const e = db
      .prepare(
        'SELECT * FROM bot_decision_events WHERE decision_id=? AND request_key=?',
      )
      .get(d.id, key) as
      | {
          actor_id: number;
          actor_conversation_id: string | null;
          kind: string;
          payload_json: string;
        }
      | undefined;
    if (!e) return false;
    if (
      e.actor_id !== actor.user.id ||
      e.actor_conversation_id !== (actor.conversationId ?? null) ||
      e.kind !== kind ||
      e.payload_json !== JSON.stringify(payload)
    )
      throw new BotError(
        409,
        'Idempotency key already used for a different action',
      );
    return true;
  }
  /** A stale version is not answerable: the bot must revise, answer the customer, or withdraw. */
  function staleGuard(d: Decision) {
    if (!d.stale_json) return;
    const stale = JSON.parse(d.stale_json) as StaleMark;
    throw new BotError(409, `This question is stale (${stale.detail}). The bot has been asked to re-check the case and revise it; answer the revised version.`);
  }
  function cas(d: Decision, version: number) {
    if (d.version !== version)
      throw new BotError(
        409,
        'Proposal changed. Reload and review the current version.',
      );
  }
  type StaleProposal = MootProposal & { message_delivery?: { canonical_case: string; payload: { ticket: string } }; as_of?: { ticket_id?: string; related_ticket_ids?: { ticket_id: string }[] } };
  /** Mark every matching open question stale once per event and wake its bot. */
  function markStale(input: Omit<StaleMark, 'since'> & { since?: string }, matches: (d: Decision, proposal: StaleProposal) => boolean): string[] {
    const marked: string[] = [];
    db.transaction(() => {
      for (const d of db.prepare("SELECT * FROM bot_decisions WHERE state='needs_input'").all() as Decision[]) {
        const proposal = JSON.parse(d.proposal_json) as StaleProposal;
        if (!matches(d, proposal)) continue;
        const moot = (MOOT_REASONS as readonly string[]).includes(input.reason);
        if (moot && proposal.as_of?.moot_when && !proposal.as_of.moot_when.includes(input.reason as MootReason)) continue;
        const key = `stale:${input.event_id ?? `${input.reason}:${input.since ?? 'now'}`}`;
        if (db.prepare('SELECT 1 FROM bot_decision_events WHERE decision_id=? AND request_key=?').get(d.id, key)) continue;
        const stale: StaleMark = { ...input, since: input.since ?? new Date().toISOString(), ...(moot ? { resolved: true } : {}) };
        db.prepare("UPDATE bot_decisions SET stale_json=?,updated_at=datetime('now') WHERE id=? AND version=?").run(JSON.stringify(stale), d.id, d.version);
        const c = conversation(d.conversation_id)!;
        const actor: Actor = { user: db.prepare('SELECT * FROM users WHERE id=?').get(c.user_id) as UserRow };
        const ev = event(actor, d, 'stale', stale, key);
        if (!c.archived) db.prepare('INSERT INTO conversation_wakeups(id,conversation_id,actor_user_id,wake_key,reason,scheduled_for) VALUES(?,?,?,?,?,?)').run(
          ev, c.id, c.user_id, `bot-decision:${ev}`,
          stale.resolved
            ? `VeneerBots question settled elsewhere. Decision ${d.id}, proposal version ${d.version}. ${stale.detail}\nThe human appears to have handled this already, so the question has left their Open questions and can no longer be answered. Confirm the current state in your own source, then do exactly one of: withdraw_decision with the reason and the evidence you read if the answer is no longer needed; or, only if the question genuinely still needs a human answer, update_decision with the current expected_version and a complete revised proposal including fresh evidence_items and as_of. If you do nothing it is withdrawn automatically. Never ask the human to answer the old version, and take no business action on the strength of this notice.`
            : `VeneerBots stale question. Decision ${d.id}, proposal version ${d.version}. ${stale.detail}\nThe case changed after you asked this question, so the human can no longer answer it. Re-read the case (new messages, status, refunds, photos), then do exactly one of: update_decision with the current expected_version and a complete revised proposal including fresh evidence_items and as_of; answer the customer yourself if the question is now moot and withdraw_decision; or withdraw_decision explaining why. Never ask the human to answer the old version.`,
          new Date().toISOString());
        marked.push(d.id);
      }
    })();
    return marked;
  }
  function wake(
    actor: Actor,
    d: Decision,
    eventId: string,
    kind: string,
    payload: unknown,
  ) {
    const c = chat(actor, d.conversation_id);
    if (c.archived)
      throw new BotError(
        409,
        'Restore the bot chat before sending a decision or message',
      );
    const reason = `VeneerBots ${kind}. Decision ${d.id}, proposal version ${d.version}.\n${JSON.stringify({ proposal: JSON.parse(d.proposal_json), payload })}\nRead the decision with list_decisions before acting. Reply in its thread with reply_to_decision. For new human messages with instruction_version in that thread: interpret the whole message in context. If it clearly approves/rejects/defers/withdraws THIS exact proposal, use record_discussion_decision with that message ID and version; do not demand a duplicate click. A clear request to investigate or revise first can be recorded as defer (no execution authority); do the requested read-only follow-up before raising any revised decision. Questions alone, quoted third-party statements, negations, conditional or ambiguous directions are not consent: ask a concise clarification and leave the decision waiting. Never reinterpret old messages or approve a materially different action. Only an approve answer permits consideration of the blocked action; reject, defer, withdraw, custom and discussion do not authorize execution. A custom answer is the human's own typed direction (payload.answer): read it as the answer to this question, then act on it or raise a revised proposal under the existing guards; it authorizes no exact executable action from the old proposal. A choice payload.answer is the concrete value the human selected; use it directly. An answer recorded by an authorized shared-queue teammate or through a phone call is a real human decision; do not request a duplicate owner approval or another UI click. Revalidate material evidence and call record_decision_result with state running and this version before executing. After discussion establishes a concrete changed recommendation or customer reply, call update_decision with the current expected_version and the complete exact revised proposal; do not leave the displayed recommendation stale while describing different text only in discussion. Keep review_summary consistent with the revised scope. Do not revise unchanged proposals or treat a request to edit as approval. Human reply edits create a new version; reread it before responding. Fresh version-bound instructions after defer may answer ONLY the unchanged exact proposal through record_discussion_decision; the service preserves the old defer and creates a successor version. If the human requests different quantities, actions, conditions or message text, revise and review that changed scope instead. Never reuse a legacy null instruction or treat questions, conditional requests or investigation findings as consent. The existing case owner remains accountable through verified delivery and unresolved follow-through. A voice call ending does not cancel this durable wake or require another approval. Technical send/setup failures belong in record_decision_result with one named technical repair owner and a concrete blocker, not a repeated human approval or a claim of completion. Preserve existing executor bindings; do not introduce a routine managerial relay. Existing financial, policy and tool approval gates still apply; standing-rule scope grants no additional authority. Continue unrelated authorized work.`;
    db.prepare(
      'INSERT INTO conversation_wakeups(id,conversation_id,actor_user_id,wake_key,reason,scheduled_for) VALUES(?,?,?,?,?,?)',
    ).run(
      eventId,
      c.id,
      c.user_id,
      `bot-decision:${eventId}`,
      reason,
      new Date().toISOString(),
    );
  }
  function view(actor: Actor, d: Decision) {
    const c = chat(actor, d.conversation_id);
    const dismissed = Boolean(
      db
        .prepare(
          'SELECT 1 FROM bot_decision_dismissals WHERE decision_id=? AND user_id=? AND version=?',
        )
        .get(d.id, actor.user.id, d.version),
    );
    const parse = (s: string | null) => (s ? JSON.parse(s) : null);
    // Answer-bridge readback (docs/autoship-answer-bridge.md, v1): the highest
    // version whose human answer finished native delivery, and the current
    // version's raw answer with its actor attribution and request key. Read
    // only; parsing the answer into shipping facts belongs to the consumer.
    const delivered = db
      .prepare(
        `SELECT max(e.version) AS version FROM bot_decision_events e
         JOIN conversation_wakeups w ON w.id=e.id
         WHERE e.decision_id=? AND e.kind='answered' AND w.status='delivered'`,
      )
      .get(d.id) as { version: number | null };
    const answered = db
      .prepare(
        `SELECT actor_id, actor_conversation_id, created_at, request_key, payload_json
         FROM bot_decision_events WHERE decision_id=? AND version=? AND kind='answered'
         ORDER BY rowid DESC LIMIT 1`,
      )
      .get(d.id, d.version) as
      | { actor_id: number; actor_conversation_id: string | null; created_at: string; request_key: string; payload_json: string }
      | undefined;
    const answerBridge = {
      contract: 'autoship-answer-bridge/v1',
      current_version: d.version,
      delivered_version: delivered.version ?? null,
      answer: answered
        ? {
            raw: (parse(answered.payload_json) as { text?: string; action?: string; scope?: string }),
            actor_id: answered.actor_id,
            actor_conversation_id: answered.actor_conversation_id,
            answered_at: answered.created_at,
            request_key: answered.request_key,
          }
        : null,
    };
    const proposal = parse(d.proposal_json);
    const botReplies = db.prepare(`SELECT t.text FROM bot_decision_threads t JOIN bot_decision_events e ON e.id=t.id
      WHERE t.decision_id=? AND e.version=? AND t.actor_conversation_id=? ORDER BY t.rowid`)
      .all(d.id, d.version, d.conversation_id) as { text: string }[];
    const store = c.business_team_id ? (db.prepare('SELECT shopify_store FROM business_teams WHERE id=?').get(c.business_team_id) as { shopify_store: string | null } | undefined)?.shopify_store : null;
    const latestDiscussion = db.prepare(`SELECT w.status,
      EXISTS (SELECT 1 FROM pending_turns p WHERE p.conversation_id=w.conversation_id
        AND p.discussion_message_id=e.id AND p.status='pending') AS responding,
      EXISTS (SELECT 1 FROM queued_messages q
        WHERE q.conversation_id=w.conversation_id AND q.discussion_message_id=e.id) AS queued,
      EXISTS (SELECT 1 FROM bot_decision_events delivery
        WHERE delivery.request_key='discussion-delivery:' || e.id || ':cancelled') AS cancelled
      FROM bot_decision_events e
      LEFT JOIN conversation_wakeups w ON w.id=e.id WHERE e.decision_id=? AND e.version=? AND e.kind='message'
      AND e.actor_conversation_id IS NULL AND NOT EXISTS (
        SELECT 1 FROM bot_decision_threads t WHERE t.decision_id=e.decision_id AND t.actor_conversation_id IS NOT NULL
        AND t.rowid > (SELECT rowid FROM bot_decision_threads WHERE id=e.id)) ORDER BY e.rowid DESC LIMIT 1`)
      .get(d.id, d.version) as { status: string | null; responding: number; queued: number; cancelled: number } | undefined;
    return {
      ...d,
      answer_bridge: answerBridge,
      proposal,
      image_access: (proposal.images ?? []).map((e: {conversation_id:string}) => { try { chat(actor,e.conversation_id); return 'source_access'; } catch { return 'decision_context_only'; } }),
      evidence_access: proposal.evidence.map((e: {conversation_id:string}) => {
        try { chat(actor,e.conversation_id); return 'source_access'; }
        catch { return 'decision_context_only'; }
      }),
      order_reference: orderReference(proposal, [proposal.question, proposal.recommendation, proposal.consequence, proposal.blocked_action, ...botReplies.map(r => r.text)], store),
      reply_status: latestDiscussion
        ? latestDiscussion.status === 'cancelled' || latestDiscussion.cancelled ? 'not_delivered'
          : latestDiscussion.responding ? 'responding'
            : latestDiscussion.status === 'pending' || latestDiscussion.queued ? 'queued' : 'awaiting_reply'
        : null,
      answer: parse(d.answer_json),
      result: parse(d.result_json),
      parked: parse(d.parked_json),
      stale: parse(d.stale_json) as StaleMark | null,
      // Evidence humans attached to this version (uploads on an answer or reply).
      human_evidence: db.prepare("SELECT payload_json FROM bot_decision_events WHERE decision_id=? AND version=? AND kind='evidence_added' ORDER BY rowid").all(d.id, d.version).map((row) => JSON.parse((row as { payload_json: string }).payload_json)),
      proposal_json: undefined,
      stale_json: undefined,
      answer_json: undefined,
      result_json: undefined,
      parked_json: undefined,
      answered_by: answered ? (db.prepare('SELECT display_name FROM users WHERE id=?').get(answered.actor_id) as { display_name: string } | undefined)?.display_name ?? null : null,
      shared_queue: shared(d),
      collaborative_answers: nonexclusive(d),
      handler_name: d.handler_id ? (db.prepare('SELECT display_name FROM users WHERE id=?').get(d.handler_id) as { display_name: string } | undefined)?.display_name ?? null : null,
      can_handle: eligible(actor, d) && shared(d) && d.state === 'needs_input',
      can_release: eligible(actor, d) && shared(d) && d.handler_id !== null && (d.handler_id === actor.user.id || c.user_id === actor.user.id),
      handling_mine: d.handler_id === actor.user.id,
      can_answer: eligible(actor, d) && (!shared(d) || nonexclusive(d) || d.handler_id === actor.user.id),
      can_edit_reply: eligible(actor,d) && (!shared(d) || nonexclusive(d) || d.handler_id===actor.user.id) && !['running','verified_completed'].includes(d.state),
      can_amend: eligible(actor, d) && actor.user.id === c.user_id && (!shared(d) || d.handler_id === actor.user.id),
      can_manage: !actor.conversationId && actor.user.id === c.user_id,
      dismissed,
      bot_name: (
        db
          .prepare('SELECT name FROM bot_registrations WHERE conversation_id=?')
          .get(c.id) as { name: string }
      ).name,
      assignee_name: (
        db
          .prepare('SELECT display_name FROM users WHERE id=?')
          .get(d.assignee_id) as { display_name: string }
      ).display_name,
    };
  }
  return {
    read,
    view,
    chat,
    register(actor: Actor, id: string, name: string, active: boolean) {
      human(actor);
      const c = chat(actor, id);
      if (c.business_team_id) throw new BotError(409, 'Use business membership management for enrolled bots');
      if (c.user_id !== actor.user.id)
        throw new BotError(
          403,
          'Only the chat owner may change bot registration',
        );
      if (c.archived && active)
        throw new BotError(409, 'Restore the chat before registering it');
      db.prepare(
        'INSERT INTO bot_registrations(conversation_id,name,active,registered_by) VALUES(?,?,?,?) ON CONFLICT(conversation_id) DO UPDATE SET name=excluded.name,active=excluded.active',
      ).run(id, name, Number(active), actor.user.id);
    },
    list(actor: Actor, filter = 'all') {
      return (
        db
          .prepare('SELECT * FROM bot_decisions ORDER BY created_at DESC,id')
          .all() as Decision[]
      ).flatMap((d) => {
        try {
          read(actor, d.id);
          if (
            actor.conversationId &&
            d.conversation_id !== actor.conversationId
          )
            return [];
          if (filter === 'me' && d.assignee_id !== actor.user.id && !(shared(d) && eligible(actor, d))) return [];
          if (
            filter === 'team' &&
            chat(actor, d.conversation_id).visibility !== 'team'
          )
            return [];
          return [view(actor, d)];
        } catch (e) {
          if (e instanceof BotError && e.status === 404) return [];
          throw e;
        }
      });
    },
    raise(
      actor: Actor,
      input: { source_key: string; proposal_key: string; proposal: Proposal },
    ) {
      if (!actor.conversationId)
        throw new BotError(403, 'Only a registered bot can raise a decision');
      const c = chat(actor, actor.conversationId);
      owner(actor, { conversation_id: c.id } as Decision);
      validateProposal(actor, input.proposal, c.id);
      return db.transaction(() => {
        const existing = db
          .prepare(
            'SELECT * FROM bot_decisions WHERE conversation_id=? AND source_key=? AND proposal_key=?',
          )
          .get(c.id, input.source_key, input.proposal_key) as
          | Decision
          | undefined;
        if (existing) return view(actor, read(actor, existing.id));
        const id = crypto.randomUUID();
        db.prepare(
          'INSERT INTO bot_decisions(id,conversation_id,source_key,proposal_key,proposal_json,assignee_id) VALUES(?,?,?,?,?,?)',
        ).run(
          id,
          c.id,
          input.source_key,
          input.proposal_key,
          JSON.stringify(input.proposal),
          input.proposal.assignee_id,
        );
        const d = read(actor, id);
        event(actor, d, 'raised', input, 'raise');
        return view(actor, d);
      })();
    },
    editReply(actor:Actor,id:string,version:number,key:string,body:string,handlingRevision?:number):ReturnType<typeof view> {
      return db.transaction(()=>{
        if(actor.conversationId)throw new BotError(403,'Use update_decision for bot proposal revisions');
        const d=read(actor,id);
        // Bind editor retries to their exact immutable edit event, not the current payload.
        const previous=db.prepare("SELECT payload_json FROM bot_decision_events WHERE decision_id=? AND request_key=? AND kind='reply_edited'").get(id,key) as {payload_json:string}|undefined;
        if(previous){const p=JSON.parse(previous.payload_json);if(p.expected_version!==version || p.body!==body || p.actor_id!==actor.user.id)throw new BotError(409,'Reply edit request conflict');approver(actor,d);return view(actor,d);}
        approver(actor,d);
        if(shared(d) && !nonexclusive(d) && d.handler_id!==actor.user.id)throw new BotError(403,'Only the current handler can edit this reply');
        if(['running','verified_completed'].includes(d.state))throw new BotError(409,'Executing or completed work cannot be edited');
        cas(d,version);
        if(shared(d))handlingCas(d,handlingRevision);
        const p=withEditedReply(JSON.parse(d.proposal_json),body);
        // Body-only edit: evidence and assignee are immutable here. Retain the
        // existing decision-bound context ACL without granting source access.
        decisionEvidenceAllowed(actor,p,d);
        const assigned=db.prepare("SELECT * FROM users WHERE id=? AND status='active'").get(d.assignee_id) as UserRow|undefined;
        if(!assigned || !canViewConversation(assigned,conversation(d.conversation_id)!,db))throw new BotError(400,'Approver must have access to the bot');
        decisionEvidenceAllowed({user:assigned},p,d);
        const permanentOwner=db.prepare('SELECT * FROM users WHERE id=?').get(conversation(d.conversation_id)!.user_id) as UserRow;
        evidenceAllowed({user:permanentOwner},p,d.conversation_id);
        db.prepare("UPDATE bot_decisions SET version=version+1,handler_id=NULL,handling_revision=handling_revision+1,state='needs_input',proposal_json=?,answer_json=NULL,result_json=NULL,parked_json=NULL,stale_json=NULL,updated_at=datetime('now') WHERE id=?").run(JSON.stringify(p),id);
        event(actor,read(actor,id),'revised',p,key+':revision');
        const result=view(actor,read(actor,id));
        event(actor,read(actor,id),'reply_edited',{expected_version:version,body,actor_id:actor.user.id},key);
        return result;
      })();
    },
    revise(
      actor: Actor,
      id: string,
      version: number,
      key: string,
      p: Proposal,
    ) {
      return db.transaction(() => {
        const d = read(actor, id);
        if (actor.conversationId) owner(actor, d);
        else {
          approver(actor, d);
          if (shared(d) && (actor.user.id !== d.assignee_id || d.handler_id !== actor.user.id)) throw new BotError(403, 'Only the assigned handler can amend this proposal');
        }
        if (replay(actor, d, key, 'revised', p)) return view(actor, d);
        cas(d, version);
        if (d.state === 'running')
          throw new BotError(
            409,
            'Running work cannot be revised; record blocked or failed first',
          );
        if (!actor.conversationId && p.assignee_id !== d.assignee_id)
          throw new BotError(
            403,
            'A proposal amendment cannot transfer approval authority',
          );
        validateProposal(actor, p, d.conversation_id, d);
        db.prepare(
          "UPDATE bot_decisions SET version=version+1,handler_id=NULL,handling_revision=handling_revision+1,state='needs_input',proposal_json=?,assignee_id=?,answer_json=NULL,result_json=NULL,parked_json=NULL,stale_json=NULL,updated_at=datetime('now') WHERE id=?",
        ).run(JSON.stringify(p), p.assignee_id, id);
        const revised = read(actor, id);
        event(actor, revised, 'revised', p, key);
        return view(actor, revised);
      })();
    },
    handle(actor: Actor, id: string, version: number, key: string, action: 'claim' | 'release', revision: number) {
      return db.transaction(() => {
        const d = read(actor, id);
        approver(actor, d);
        if (!shared(d)) throw new BotError(403, 'This decision is not in a shared queue');
        const payload = { action, revision, version };
        if (replay(actor, d, key, 'handling', payload)) return view(actor, d);
        cas(d, version);
        handlingCas(d, revision);
        if (d.state !== 'needs_input') throw new BotError(409, 'This question has already been answered');
        if (action === 'claim' && d.handler_id !== null) throw new BotError(409, 'This question is already being handled');
        if (action === 'release' && (d.handler_id === null || (d.handler_id !== actor.user.id && conversation(d.conversation_id)!.user_id !== actor.user.id)))
          throw new BotError(403, 'Only the handler or owner can release this question');
        db.prepare("UPDATE bot_decisions SET handler_id=?,handling_revision=handling_revision+1,updated_at=datetime('now') WHERE id=?")
          .run(action === 'claim' ? actor.user.id : null, id);
        event(actor, d, 'handling', payload, key);
        return view(actor, read(actor, id));
      })();
    },
    choose(actor: Actor, id: string, version: number, key: string, choiceId: string, note: string, scope: string, handlingRevision?: number): ReturnType<typeof view> {
      return db.transaction(() => {
        const d = read(actor, id);
        cas(d, version);
        const proposal = proposalInputSchema.parse(JSON.parse(d.proposal_json));
        const choice = (proposal.choices ?? defaultDecisionChoices).find(item => item.id === choiceId);
        if (!choice) throw new BotError(409, 'This choice is no longer available. Review the current proposal.');
        return createBotService(db).answer(actor, id, version, key, {
          action: choice.action, text: note.trim() || choice.label, scope,
          choice_id: choice.id, choice_label: choice.label,
          ...('answer' in choice && choice.answer ? { answer: choice.answer } : {}),
        }, handlingRevision);
      })();
    },
    /**
     * The human's own typed direction ("Something else"). It resolves the
     * question on the same version and wakes the bot with the text, but it is
     * recorded as `custom`, never `approve`: nothing in the proposal becomes
     * executable from it. The bot reads it and revises or acts under the
     * existing guards.
     */
    answerCustom(actor: Actor, id: string, version: number, key: string, text: string, handlingRevision?: number): ReturnType<typeof view> {
      const answer = text.trim();
      if (!answer) throw new BotError(400, 'Type what you want to happen before submitting');
      return createBotService(db).answer(actor, id, version, key, {
        action: 'custom', text: answer, scope: 'this_case',
        choice_id: CUSTOM_CHOICE_ID, choice_label: CUSTOM_CHOICE_LABEL, answer,
      }, handlingRevision);
    },
    answer(
      actor: Actor,
      id: string,
      version: number,
      key: string,
      payload: { action: string; text: string; scope: string; choice_id?: string; choice_label?: string; answer?: string },
      handlingRevision?: number,
    ) {
      return db.transaction(() => {
        const d = read(actor, id);
        approver(actor, d);
        if (replay(actor, d, key, 'answered', payload)) return view(actor, d);
        cas(d, version);
        if (shared(d)) {
          handlingCas(d, handlingRevision);
          if (!nonexclusive(d) && d.handler_id !== actor.user.id) throw new BotError(409, 'Claim this question before answering');
        }
        if (d.state !== 'needs_input')
          throw new BotError(409, 'This proposal already has an answer');
        staleGuard(d);
        db.prepare(
          "UPDATE bot_decisions SET state='decided',answer_json=?,updated_at=datetime('now') WHERE id=? AND version=? AND state='needs_input'",
        ).run(
          JSON.stringify({ ...payload, actor_id: actor.user.id }),
          id,
          version,
        );
        const ev = event(actor, d, 'answered', payload, key);
        if(JSON.parse(d.proposal_json).purchase_timing) event(actor,d,'purchase_timing_context',{answer_event_id:ev,context:timingHumanContext(db,d.conversation_id,d.id)},key+':timing-context');
        wake(actor, d, ev, 'answer', payload);
        return view(actor, read(actor, id));
      })();
    },
    inspectConversationalDecision(actor: Actor, id: string, version: number, kind: 'result_reply' | 'direct_message', sourceId?: string) {
      const d=read(actor,id); owner(actor,d); cas(d,version);
      const service=createBotService(db);
      const recentDirect=db.prepare('SELECT id,actor_id,text,created_at,proposals_json FROM bot_human_messages WHERE conversation_id=? ORDER BY rowid DESC LIMIT 30').all(d.conversation_id) as {id:string;actor_id:number;text:string;created_at:string;proposals_json:string}[];
      if (!sourceId) return { sources: kind==='direct_message' ? recentDirect : db.prepare(`SELECT r.id,r.thread_id,r.actor_id,r.text,r.created_at FROM bot_message_replies r JOIN bot_message_threads t ON t.id=r.thread_id WHERE t.conversation_id=? AND r.actor_conversation_id IS NULL ORDER BY r.seq DESC LIMIT 30`).all(d.conversation_id), note:'Discovery only. Inspect an exact source_id before recording; read the full conversation and all source context. No approval inferred.' };
      let source: {id:string;actor_id:number;text:string;created_at:string};
      let context: unknown;
      let sourceHandlingRevision: number | undefined;
      const proposal=JSON.parse(d.proposal_json);
      const proposalHash=canonicalSha256(proposal);
      if(kind==='result_reply') {
        const row=db.prepare(`SELECT r.*,t.source_text,t.anchor,t.conversation_id FROM bot_message_replies r JOIN bot_message_threads t ON t.id=r.thread_id WHERE r.id=? AND r.actor_conversation_id IS NULL`).get(sourceId) as {id:string;actor_id:number;text:string;created_at:string;conversation_id:string;thread_id:string;source_text:string;anchor:string}|undefined;
        if(!row || row.conversation_id!==d.conversation_id) throw new BotError(404,'Authenticated human source not found in this owning conversation');
        source={id:row.id,actor_id:row.actor_id,text:row.text,created_at:row.created_at};
        const replies=db.prepare('SELECT id,actor_id,actor_conversation_id,text,created_at FROM bot_message_replies WHERE thread_id=? ORDER BY seq').all(row.thread_id) as {id:string;actor_conversation_id:string|null}[];
        if(replies.filter(r=>r.actor_conversation_id===null).at(-1)?.id!==sourceId) throw new BotError(409,'A newer human reply supersedes this source; inspect the current instruction');
        // Existing result replies are usable only against an independently retained
        // proposal event predating the human message. Never manufacture a binding
        // from quoted prose or a proposal created after the instruction.
        const prior=db.prepare("SELECT version,kind,payload_json FROM bot_decision_events WHERE decision_id=? AND kind IN ('raised','revised') AND CAST(strftime('%s',created_at) AS INTEGER)<CAST(strftime('%s',?) AS INTEGER) ORDER BY rowid DESC LIMIT 1").get(id,source.created_at) as {version:number;kind:string;payload_json:string}|undefined;
        const original=prior && JSON.parse(prior.payload_json);
        if(!prior || prior.version!==version || canonicalSha256(prior.kind==='raised'?original.proposal:original)!==proposalHash) throw new BotError(409,'No unchanged proposal existed at this human instruction; do not retrofit consent');
        context={thread_id:row.thread_id,anchor:row.anchor,original_result:row.source_text,replies};
      } else {
        const row=db.prepare('SELECT * FROM bot_human_messages WHERE id=? AND conversation_id=?').get(sourceId,d.conversation_id) as {id:string;actor_id:number;text:string;created_at:string;proposals_json:string}|undefined;
        if(!row) throw new BotError(404,'Authenticated composer source not found; legacy transcripts cannot establish authorship');
        source={id:row.id,actor_id:row.actor_id,text:row.text,created_at:row.created_at};
        const binding=JSON.parse(row.proposals_json).find((p:{id:string})=>p.id===id);
        if(!binding || binding.version!==version || binding.proposal_hash!==proposalHash) throw new BotError(409,'Proposal was not unchanged at message submission');
        if(recentDirect[0]?.id!==sourceId) throw new BotError(409,'A newer direct human message supersedes this instruction');
        sourceHandlingRevision=binding.handling_revision;
        context={direct_messages:recentDirect};
      }
      const user=db.prepare("SELECT * FROM users WHERE id=? AND status='active'").get(source.actor_id) as UserRow|undefined;
      if(!user) throw new BotError(403,'Human author is no longer active');
      approver({user},d); decisionEvidenceAllowed({user},proposal,d);
      if(JSON.stringify(context).length>120000) throw new BotError(409,'Source context exceeds the bounded review limit; do not record from excerpts');
      const sourceHash=canonicalSha256({kind,source,anchor:kind==='result_reply' ? {original_result:(context as {original_result:string}).original_result,anchor:(context as {anchor:string}).anchor} : null});
      const receipt=db.prepare('SELECT * FROM bot_conversational_answers WHERE source_kind=? AND source_id=?').get(kind,sourceId) as {decision_id:string;version:number;source_hash:string;action:string}|undefined;
      if(receipt && (receipt.decision_id!==id || receipt.version!==version || receipt.source_hash!==sourceHash)) throw new BotError(409,'Source already used or source context changed');
      if(!receipt && sourceHandlingRevision!==undefined && sourceHandlingRevision!==d.handling_revision) throw new BotError(409,'Handling changed since the human instruction');
      // Later human input on any native surface prevents importing an old yes.
      // Same-second events conservatively count too; owner must use current input.
      if(!receipt && (recentDirect.some(m=>m.id!==sourceId && Date.parse(m.created_at)>=Date.parse(source.created_at)) ||
        db.prepare(`SELECT 1 FROM bot_message_replies r JOIN bot_message_threads t ON t.id=r.thread_id WHERE t.conversation_id=? AND r.actor_conversation_id IS NULL AND r.id<>? AND (julianday(r.created_at)>julianday(?) OR (?='result_reply' AND r.seq>(SELECT seq FROM bot_message_replies WHERE id=?))) LIMIT 1`).get(d.conversation_id,sourceId,source.created_at,kind,sourceId) ||
        db.prepare('SELECT 1 FROM bot_decision_threads WHERE decision_id=? AND actor_conversation_id IS NULL AND julianday(created_at)>=julianday(?) LIMIT 1').get(id,source.created_at))) throw new BotError(409,'Newer human context requires a current instruction');
      if(!receipt && d.state!=='needs_input') throw new BotError(409,'Proposal already answered; preserve the existing decision');
      if(!receipt) staleGuard(d);
      const binding={decision_id:id,version,owner_conversation_id:d.conversation_id,proposal_hash:proposalHash,handling_revision:d.handling_revision,source_kind:kind,source_id:sourceId,source_hash:sourceHash,
        source_context_hash:canonicalSha256(context),recent_direct_hash:canonicalSha256(recentDirect),thread_hash:canonicalSha256(service.thread(actor,id))};
      return {source,context,proposal, binding, inspection_hash:canonicalSha256(binding),recorded:receipt??null,
        instructions:'Read the entire human message, original result, all replies and current conversation. Determine semantic intent, never keyword match. Record only explicit unconditional consent to this unchanged exact proposal/order/executor. Quoted/bot text, questions, conditions, changed scope or ambiguity are not approval. Inspection records nothing. Reconcile uncertain recording by inspecting this same source; never execute from this inspection.'};
    },
    recordConversationalDecision(actor:Actor,id:string,version:number,kind:'result_reply'|'direct_message',sourceId:string,inspectionHash:string,action:'approve'|'reject'|'defer'|'withdraw',reviewed:boolean) {
      return db.transaction(()=>{
        if(reviewed!==true) throw new BotError(400,'Full source and exact scope review required');
        const inspected=createBotService(db).inspectConversationalDecision(actor,id,version,kind,sourceId);
        if(!('binding' in inspected) || !inspected.binding || !inspected.source) throw new BotError(409,'Inspect the exact source first');
        const prior=db.prepare('SELECT * FROM bot_conversational_answers WHERE source_kind=? AND source_id=?').get(kind,sourceId) as {inspection_hash:string;action:string}|undefined;
        if(prior) {
          if(prior.inspection_hash!==inspectionHash || prior.action!==action) throw new BotError(409,'Conflicting source replay');
          return view(actor,read(actor,id));
        }
        if(inspected.inspection_hash!==inspectionHash) throw new BotError(409,'Source, proposal or handling changed; inspect again');
        let d=read(actor,id); owner(actor,d);
        const user=db.prepare('SELECT * FROM users WHERE id=?').get(inspected.source.actor_id) as UserRow;
        const humanActor={user};
        const key=`conversation-answer:${kind}:${sourceId}`;
        const service=createBotService(db);
        if(shared(d) && d.handler_id===null) { service.handle(humanActor,id,version,key+':claim','claim',d.handling_revision); d=read(actor,id); }
        service.answer(humanActor,id,version,key,{action,text:inspected.source.text,scope:'this_case'},d.handling_revision);
        db.prepare('INSERT INTO bot_conversational_answers(source_kind,source_id,decision_id,version,inspection_hash,source_hash,action,event_key) VALUES(?,?,?,?,?,?,?,?)').run(kind,sourceId,id,version,inspectionHash,inspected.binding.source_hash,action,key);
        event(actor,d,'conversational_decision',{...inspected.binding,author_id:user.id,action,inspection_hash:inspectionHash,reviewed_full_context:true},key+':source');
        service.reply(actor,id,key+':receipt',`Recorded ${user.display_name}’s conversational ${action} for proposal v${version}. Source ${kind} ${sourceId}. Execution and external system checks remain separate.`);
        return view(actor,read(actor,id));
      }).immediate();
    },
    recordDiscussionDecision(actor: Actor, id: string, messageId: string, version: number, action: 'approve' | 'reject' | 'defer' | 'withdraw'): ReturnType<typeof view> {
      return db.transaction(() => {
        let d = read(actor, id);
        owner(actor, d);
        const source = db.prepare(`SELECT t.*,i.version,i.handling_revision FROM bot_discussion_instructions i
          JOIN bot_decision_threads t ON t.id=i.message_id WHERE t.id=? AND t.decision_id=? AND t.actor_conversation_id IS NULL`)
          .get(messageId, id) as { actor_id: number; text: string; version: number; handling_revision: number } | undefined;
        if (!source || source.version !== version) throw new BotError(409, 'A new version-bound human discussion message is required. Ask for clarification in this thread.');
        const user = db.prepare('SELECT * FROM users WHERE id=?').get(source.actor_id) as UserRow | undefined;
        if (!user || user.status !== 'active') throw new BotError(403, 'The message author is no longer authorized');
        const humanActor: Actor = { user };
        approver(humanActor, d);
        const key = `discussion-answer:${messageId}`;
        const payload = { action, text: source.text, scope: 'this_case' };
        if (replay(humanActor, d, key, 'answered', payload)) return view(actor, d);
        cas(d, version);
        const latest = db.prepare('SELECT id FROM bot_decision_threads WHERE decision_id=? AND actor_conversation_id IS NULL ORDER BY rowid DESC LIMIT 1').get(id) as { id: string };
        if (latest.id !== messageId) throw new BotError(409, 'A newer human message supersedes this instruction. Read the thread again.');
        const service = createBotService(db);
        if(d.state==='decided' && JSON.parse(d.answer_json || '{}').action==='defer') {
          const followup=db.prepare('SELECT * FROM bot_deferred_followups WHERE message_id=?').get(messageId) as {deferred_answer_event_id:string;proposal_hash:string}|undefined;
          const deferred=db.prepare("SELECT id FROM bot_decision_events WHERE decision_id=? AND version=? AND kind='answered' ORDER BY rowid DESC LIMIT 1").get(id,version) as {id:string}|undefined;
          if(!followup || followup.deferred_answer_event_id!==deferred?.id || followup.proposal_hash!==canonicalSha256(JSON.parse(d.proposal_json)))
            throw new BotError(409,'A fresh instruction bound to this deferred proposal is required');
          if(source.handling_revision!==d.handling_revision || (shared(d) && !nonexclusive(d) && d.handler_id!==null && d.handler_id!==user.id))
            throw new BotError(409,'Handling changed. Review the current question before continuing.');
          // Copy the exact proposal, never a bot-supplied replacement. Preserve
          // the deferred answer in its original version's immutable events.
          db.prepare("UPDATE bot_decisions SET version=version+1,state='needs_input',answer_json=NULL,result_json=NULL,parked_json=NULL,handler_id=NULL,handling_revision=handling_revision+1,updated_at=datetime('now') WHERE id=?").run(id);
          d=read(actor,id);
          event(humanActor,d,'revised',JSON.parse(d.proposal_json),key+':revision');
          event(humanActor,d,'deferred_followup',{message_id:messageId,from_version:version,to_version:d.version,proposal_hash:followup.proposal_hash,deferred_answer_event_id:deferred!.id},key+':followup');
        } else {
          if (d.state !== 'needs_input') throw new BotError(409, 'This proposal already has an answer');
          reconcileDiscussionHandling(actor, d, messageId, source, key);
        }
        // Reuse the same human authorization, shared-queue claim and answer flow as the UI.
        const answerVersion=d.version;
        if (shared(d) && d.handler_id === null) {
          service.handle(humanActor, id, answerVersion, key + ':claim', 'claim', d.handling_revision);
          d = read(actor, id);
        }
        service.answer(humanActor, id, answerVersion, key, payload, d.handling_revision);
        const label = { approve: 'Approved · Queued for required checks and execution. Not completed.', reject: 'Rejected · No execution authorized.', defer: 'Deferred · Follow-up needed. No execution authorized.', withdraw: 'Withdrawn · No execution authorized.' }[action];
        service.reply(actor, id, key + ':receipt', `Decision recorded from ${user.display_name}’s discussion message (proposal v${answerVersion}): ${label}`);
        event(actor, d, 'discussion_decision', { message_id: messageId, action, author_id: user.id, version:answerVersion, instruction_version:version }, key + ':source');
        return view(actor, read(actor, id));
      }).immediate();
    },
    thread(actor: Actor, id: string) {
      const d = read(actor, id);
      // Old proposal evidence is checked too: audit history must not leak revoked links.
      const events = db
        .prepare(
          'SELECT * FROM bot_decision_events WHERE decision_id=? ORDER BY rowid',
        )
        .all(id) as { payload_json: string; kind: string }[];
      for (const e of events) {
        const p = JSON.parse(e.payload_json);
        try {
          if (e.kind === 'raised') decisionEvidenceAllowed(actor, p.proposal, d);
          if (e.kind === 'revised') decisionEvidenceAllowed(actor, p, d);
        } catch (error) {
          if (!(error instanceof BotError) || ![403, 404].includes(error.status)) throw error;
          e.payload_json = JSON.stringify({
            text: 'Historical proposal context is no longer accessible.',
          });
        }
      }
      return {
        messages: db
          .prepare(
            'SELECT t.*,u.display_name AS actor_name,i.version AS instruction_version FROM bot_decision_threads t JOIN users u ON u.id=t.actor_id LEFT JOIN bot_discussion_instructions i ON i.message_id=t.id WHERE decision_id=? ORDER BY t.rowid',
          )
          .all(id),
        events,
      };
    },
    reply(actor: Actor, id: string, key: string, message: string, expectedVersion?: number) {
      return db.transaction(() => {
        const d = read(actor, id);
        if (actor.conversationId) owner(actor, d);
        else if (!canSendToConversation(actor.user, conversation(d.conversation_id)!, db)) throw new BotError(403, 'Read-only access');
        if (replay(actor, d, key, 'message', message)) return view(actor, d);
        if (expectedVersion !== undefined) cas(d, expectedVersion);
        const ev = event(actor, d, 'message', message, key);
        db.prepare(
          'INSERT INTO bot_decision_threads(id,decision_id,actor_id,actor_conversation_id,text) VALUES(?,?,?,?,?)',
        ).run(ev, id, actor.user.id, actor.conversationId ?? null, message);
        const deferred=d.state==='decided' && JSON.parse(d.answer_json || '{}').action==='defer';
        if (!actor.conversationId && expectedVersion !== undefined && (d.state === 'needs_input' || deferred) && eligible(actor, d)) {
          db.prepare('INSERT INTO bot_discussion_instructions(message_id,version,handling_revision) VALUES(?,?,?)').run(ev, d.version, d.handling_revision);
          if(deferred){
            const answer=db.prepare("SELECT id FROM bot_decision_events WHERE decision_id=? AND version=? AND kind='answered' ORDER BY rowid DESC LIMIT 1").get(id,d.version) as {id:string}|undefined;
            if(!answer)throw new BotError(409,'Deferred answer provenance is missing');
            db.prepare('INSERT INTO bot_deferred_followups(message_id,deferred_answer_event_id,proposal_hash) VALUES(?,?,?)').run(ev,answer.id,canonicalSha256(JSON.parse(d.proposal_json)));
          }
        }
        if (!actor.conversationId)
          wake(actor, d, ev, 'discussion (not an approval)', message);
        return view(actor, d);
      })();
    },
    result(
      actor: Actor,
      id: string,
      version: number,
      key: string,
      payload: {
        state: string;
        evidence: string;
        material_evidence_unchanged?: boolean;
      },
    ) {
      return db.transaction(() => {
        const d = read(actor, id);
        owner(actor, d);
        if (replay(actor, d, key, 'result', payload)) return view(actor, d);
        cas(d, version);
        const action = d.answer_json ? JSON.parse(d.answer_json).action : null;
        if (payload.state === 'running') {
          validateProposal(
            actor,
            JSON.parse(d.proposal_json),
            d.conversation_id,
            d,
          );
          const delivered = db
            .prepare(
              `SELECT 1 FROM bot_decision_events e
            JOIN conversation_wakeups w ON w.id=e.id
            WHERE e.decision_id=? AND e.version=? AND e.kind='answered' AND w.status='delivered'`,
            )
            .get(id, version);
          if (!delivered)
            throw new BotError(
              409,
              'Decision delivery must finish before execution',
            );
        }
        const allowed =
          payload.state === 'running'
            ? ['action_pending', 'blocked'].includes(d.state) &&
              action === 'approve' &&
              payload.material_evidence_unchanged === true
            : payload.state === 'verified_completed'
              ? d.state === 'running'
              : ['decided', 'action_pending', 'running', 'blocked'].includes(
                  d.state,
                );
        if (!allowed)
          throw new BotError(
            409,
            'Invalid execution transition; approval, delivery and current evidence are required',
          );
        db.prepare(
          "UPDATE bot_decisions SET state=?,result_json=?,updated_at=datetime('now') WHERE id=?",
        ).run(payload.state, JSON.stringify(payload), id);
        event(actor, d, 'result', payload, key);
        return view(actor, read(actor, id));
      })();
    },
    park(
      actor: Actor,
      id: string,
      version: number,
      key: string,
      payload: { released_leases: string[]; evidence: string },
    ) {
      return db.transaction(() => {
        const d = read(actor, id);
        owner(actor, d);
        if (replay(actor, d, key, 'parked', payload)) return view(actor, d);
        cas(d, version);
        if (!['needs_input', 'decided', 'blocked'].includes(d.state))
          throw new BotError(409, 'Work can only be parked while waiting');
        db.prepare(
          "UPDATE bot_decisions SET parked_json=?,updated_at=datetime('now') WHERE id=?",
        ).run(JSON.stringify(payload), id);
        event(actor, d, 'parked', payload, key);
        return view(actor, read(actor, id));
      })();
    },
    /**
     * The case moved on (customer replied, ticket changed). Every open question
     * on that case is marked stale and its bot is woken to re-read and revise,
     * answer the customer, or withdraw. Idempotent per (decision, event).
     */
    markStaleForCase(caseIds: string[], mark: Omit<StaleMark, 'since'> & { since?: string }): string[] {
      // Alias resolution (merge contract §6): a merged-away ticket and its
      // survivor name the same case for staling, in both directions and along chains.
      const ids = new Set(caseIds.map((c) => c.trim()).filter(Boolean));
      let grew = ids.size > 0;
      while (grew) {
        grew = false;
        for (const t of [...ids]) for (const row of db.prepare('SELECT from_ticket,into_ticket FROM case_merges WHERE from_ticket=? OR into_ticket=?').all(t, t) as { from_ticket: string; into_ticket: string }[])
          for (const x of [row.from_ticket, row.into_ticket]) if (!ids.has(x)) { ids.add(x); grew = true; }
      }
      if (!ids.size) return [];
      return markStale(mark, (_d, proposal) => {
        const cases = [proposal.message_delivery?.canonical_case, proposal.message_delivery?.payload.ticket, proposal.as_of?.ticket_id, ...(proposal.as_of?.related_ticket_ids ?? []).map((r) => r.ticket_id)].filter((x): x is string => !!x);
        return cases.some((c) => ids.has(c));
      });
    },
    /**
     * An authenticated source reported that an order was fulfilled, cancelled
     * or closed. Open questions bound to that order in the source's own
     * business are settled elsewhere: they leave Open questions at once and
     * their bot is woken to confirm and withdraw. Idempotent per (decision, event).
     */
    markStaleForOrder(teamId: string, orderNumbers: string[], mark: Omit<StaleMark, 'since' | 'resolved'> & { since?: string }): string[] {
      const numbers = new Set(orderNumbers.map(normalizeOrderNumber).filter(Boolean));
      if (!numbers.size) return [];
      return markStale({ ...mark, resolved: true }, (d, proposal) =>
        conversation(d.conversation_id)?.business_team_id === teamId && decisionOrders(proposal).some((n) => numbers.has(n)));
    },
    /**
     * The owning bot found its own open question no longer needs an answer
     * (the order shipped, the ticket closed, the human handled it elsewhere).
     * Withdrawing authorizes nothing and keeps the question in history.
     */
    withdraw(actor: Actor, id: string, version: number, key: string, payload: { reason: string; evidence: string }) {
      return db.transaction(() => {
        const d = read(actor, id);
        owner(actor, d);
        const answer = { action: 'withdraw', text: `Withdrawn by the bot: ${payload.reason}`, evidence: payload.evidence, scope: 'this_case', actor_id: actor.user.id, by_bot: true };
        if (replay(actor, d, key, 'answered', answer)) return view(actor, d);
        cas(d, version);
        if (d.state !== 'needs_input') throw new BotError(409, 'Only a question still waiting for an answer can be withdrawn');
        db.prepare("UPDATE bot_decisions SET state='decided',answer_json=?,updated_at=datetime('now') WHERE id=?").run(JSON.stringify(answer), id);
        event(actor, d, 'answered', answer, key);
        return view(actor, read(actor, id));
      })();
    },
    /**
     * Periodic re-verification for open questions bound to an order: no source
     * event is needed. Each owning bot gets at most one wake per interval naming
     * its order-bound questions older than the interval; it re-reads the orders
     * in its own source and withdraws the settled ones.
     */
    queueQuestionRechecks(intervalMs: number, now = Date.now()): string[] {
      const byBot = new Map<string, { d: Decision; orders: string[] }[]>();
      for (const d of db.prepare("SELECT * FROM bot_decisions WHERE state='needs_input' AND stale_json IS NULL").all() as Decision[]) {
        if (now - Date.parse(d.updated_at.replace(' ', 'T') + (/[zZ]$/.test(d.updated_at) ? '' : 'Z')) < intervalMs) continue;
        const orders = decisionOrders(JSON.parse(d.proposal_json) as MootProposal);
        if (orders.length) byBot.set(d.conversation_id, [...(byBot.get(d.conversation_id) ?? []), { d, orders }]);
      }
      const woken: string[] = [];
      const bucket = Math.floor(now / intervalMs);
      for (const [conversationId, items] of byBot) {
        const c = conversation(conversationId);
        if (!c || c.archived) continue;
        // One wake per bot per interval, and never a second while one is still pending.
        if (db.prepare("SELECT 1 FROM conversation_wakeups WHERE conversation_id=? AND (wake_key=? OR (status='pending' AND wake_key LIKE 'question-recheck:%'))").get(conversationId, `question-recheck:${bucket}`)) continue;
        db.prepare('INSERT INTO conversation_wakeups(id,conversation_id,actor_user_id,wake_key,reason,scheduled_for) VALUES(?,?,?,?,?,?)').run(
          crypto.randomUUID(), c.id, c.user_id, `question-recheck:${bucket}`,
          `VeneerBots open question re-check. You have ${items.length} open question(s) tied to an order:\n${items.map(({ d, orders }) => `- Decision ${d.id}, proposal version ${d.version}, order ${orders.map((o) => `#${o}`).join(', ')}`).join('\n')}\nThe human may already have handled the situation somewhere else. For each one, read the order's current state in your own source. If the order is fulfilled, cancelled or closed, or the answer is otherwise no longer needed, call withdraw_decision with the reason and the evidence you read. If the question is still needed, leave it exactly as it is: do not revise it, reply to it or message the human. This re-check grants no authority and is not an answer.`,
          new Date(now).toISOString());
        woken.push(conversationId);
      }
      return woken;
    },
    /** A human attaches a file to a question (uploaded from the composer). Recorded as an event on this version and shown to the bot. */
    addHumanEvidence(actor: Actor, id: string, version: number, key: string, item: EvidenceItem) {
      return db.transaction(() => {
        const d = read(actor, id);
        human(actor);
        approver(actor, d);
        cas(d, version);
        const payload = { ...item, added_by: 'human' as const, actor_id: actor.user.id, captured_at: item.captured_at ?? new Date().toISOString() };
        if (replay(actor, d, key, 'evidence_added', payload)) return view(actor, d);
        event(actor, d, 'evidence_added', payload, key);
        return view(actor, read(actor, id));
      })();
    },
    /**
     * Questions left stale for longer than `maxAgeMs` without a revision are
     * withdrawn with an audit note: the bot never refreshed them, so the human
     * must not be shown an answerable card for a case that moved on.
     */
    withdrawStaleQuestions(maxAgeMs: number, now = Date.now(), resolvedMaxAgeMs = maxAgeMs): string[] {
      const withdrawn: string[] = [];
      for (const d of db.prepare("SELECT * FROM bot_decisions WHERE state='needs_input' AND stale_json IS NOT NULL").all() as Decision[]) {
        const stale = JSON.parse(d.stale_json!) as StaleMark;
        // Measured from when Veneer learned of it: a source may report an old event late.
        const marked = stale.resolved ? Date.parse(d.updated_at.replace(' ', 'T') + (/[zZ]$/.test(d.updated_at) ? '' : 'Z')) : Date.parse(stale.since);
        if (now - marked < (stale.resolved ? resolvedMaxAgeMs : maxAgeMs)) continue;
        const c = conversation(d.conversation_id)!;
        const actor: Actor = { user: db.prepare('SELECT * FROM users WHERE id=?').get(c.user_id) as UserRow };
        const payload = { action: 'withdraw', text: stale.resolved ? `Withdrawn automatically: ${stale.detail}, so the answer is no longer needed.` : `Withdrawn automatically: stale since ${stale.since} (${stale.detail}) and never revised.`, scope: 'this_case', actor_id: actor.user.id, automatic: true };
        const changed = db.prepare("UPDATE bot_decisions SET state='decided',answer_json=?,updated_at=datetime('now') WHERE id=? AND version=? AND state='needs_input'").run(JSON.stringify(payload), d.id, d.version).changes;
        if (!changed) continue;
        event(actor, d, 'answered', payload, `stale-withdraw:${d.id}:${d.version}`);
        withdrawn.push(d.id);
      }
      return withdrawn;
    },
    dismiss(actor: Actor, id: string, version: number) {
      const d = read(actor, id);
      human(actor);
      cas(d, version);
      if (d.state === 'needs_input')
        throw new BotError(409, 'Answer the question before dismissing it');
      db.prepare(
        'INSERT INTO bot_decision_dismissals VALUES(?,?,?) ON CONFLICT(decision_id,user_id) DO UPDATE SET version=excluded.version',
      ).run(id, actor.user.id, version);
    },
  };
}
