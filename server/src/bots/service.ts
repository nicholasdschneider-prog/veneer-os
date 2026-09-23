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
}).strict();
export const defaultDecisionChoices = [
  { id: 'approve', label: 'Approve as proposed', action: 'approve' },
  { id: 'reject', label: 'Reject proposal', action: 'reject' },
  { id: 'defer', label: 'Not now', action: 'defer' },
  { id: 'withdraw', label: 'Withdraw request', action: 'withdraw' },
] as const;
export const decisionImageSchema = z.object({
  conversation_id: z.string().min(1).max(200),
  path: z.string().min(1).max(4096),
  label: z.string().trim().min(1).max(200),
  source: z.string().trim().min(1).max(300),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();
export const proposalSchema = z
  .object({
    choices: z.array(decisionChoiceSchema).min(2).max(6).refine(items => new Set(items.map(item => item.id)).size === items.length, "Choice IDs must be unique").optional(),
    question: text,
    recommendation: text,
    consequence: text,
    assignee_id: z.number().int().positive(),
    team: z.string().max(160).default(''),
    deadline: z.string().datetime({ offset: true }).nullable().default(null),
    message_delivery: approvedMessageSchema.optional(),
    images: z.array(decisionImageSchema).max(12).optional(),
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
  function validateProposal(actor: Actor, p: Proposal, botId: string) {
    evidenceAllowed(actor, p, botId);
    const user = db
      .prepare("SELECT * FROM users WHERE id=? AND status='active'")
      .get(p.assignee_id) as UserRow | undefined;
    const c = conversation(botId)!;
    if (!user || !canViewConversation(user, c, db))
      throw new BotError(400, 'Approver must have access to the bot');
    evidenceAllowed({ user }, p);
    // Evidence must also be accessible to the permanent owner at execution time.
    const botOwner = db
      .prepare('SELECT * FROM users WHERE id=?')
      .get(c.user_id) as UserRow;
    evidenceAllowed({ user: botOwner }, p);
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
  function cas(d: Decision, version: number) {
    if (d.version !== version)
      throw new BotError(
        409,
        'Proposal changed. Reload and review the current version.',
      );
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
    const reason = `VeneerBots ${kind}. Decision ${d.id}, proposal version ${d.version}.\n${JSON.stringify({ proposal: JSON.parse(d.proposal_json), payload })}\nRead the decision with list_decisions before acting. Reply in its thread with reply_to_decision. For new human messages with instruction_version in that thread: interpret the whole message in context. If it clearly approves/rejects/defers/withdraws THIS exact proposal, use record_discussion_decision with that message ID and version; do not demand a duplicate click. A clear request to investigate or revise first can be recorded as defer (no execution authority); do the requested read-only follow-up before raising any revised decision. Questions alone, quoted third-party statements, negations, conditional or ambiguous directions are not consent: ask a concise clarification and leave the decision waiting. Never reinterpret old messages or approve a materially different action. Only an approve answer permits consideration of the blocked action; reject, defer, withdraw and discussion do not authorize execution. An answer recorded by an authorized shared-queue teammate or through a phone call is a real human decision; do not request a duplicate owner approval or another UI click. Revalidate material evidence and call record_decision_result with state running and this version before executing. Revise changed proposals with update_decision. Existing financial, policy and tool approval gates still apply; standing-rule scope grants no additional authority. Continue unrelated authorized work.`;
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
      proposal_json: undefined,
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
        validateProposal(actor, p, d.conversation_id);
        db.prepare(
          "UPDATE bot_decisions SET version=version+1,handler_id=NULL,handling_revision=handling_revision+1,state='needs_input',proposal_json=?,assignee_id=?,answer_json=NULL,result_json=NULL,parked_json=NULL,updated_at=datetime('now') WHERE id=?",
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
        }, handlingRevision);
      })();
    },
    answer(
      actor: Actor,
      id: string,
      version: number,
      key: string,
      payload: { action: string; text: string; scope: string; choice_id?: string; choice_label?: string },
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
        db.prepare(
          "UPDATE bot_decisions SET state='decided',answer_json=?,updated_at=datetime('now') WHERE id=? AND version=? AND state='needs_input'",
        ).run(
          JSON.stringify({ ...payload, actor_id: actor.user.id }),
          id,
          version,
        );
        const ev = event(actor, d, 'answered', payload, key);
        wake(actor, d, ev, 'answer', payload);
        return view(actor, read(actor, id));
      })();
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
        cas(d, version);
        const key = `discussion-answer:${messageId}`;
        const payload = { action, text: source.text, scope: 'this_case' };
        if (replay(humanActor, d, key, 'answered', payload)) return view(actor, d);
        const latest = db.prepare('SELECT id FROM bot_decision_threads WHERE decision_id=? AND actor_conversation_id IS NULL ORDER BY rowid DESC LIMIT 1').get(id) as { id: string };
        if (latest.id !== messageId) throw new BotError(409, 'A newer human message supersedes this instruction. Read the thread again.');
        if (d.state !== 'needs_input') throw new BotError(409, 'This proposal already has an answer');
        reconcileDiscussionHandling(actor, d, messageId, source, key);
        // Reuse the same human authorization, shared-queue claim and answer flow as the UI.
        const service = createBotService(db);
        if (shared(d) && d.handler_id === null) {
          service.handle(humanActor, id, version, key + ':claim', 'claim', d.handling_revision);
          d = read(actor, id);
        }
        service.answer(humanActor, id, version, key, payload, d.handling_revision);
        const label = { approve: 'Approved · Queued for required checks and execution. Not completed.', reject: 'Rejected · No execution authorized.', defer: 'Deferred · Follow-up needed. No execution authorized.', withdraw: 'Withdrawn · No execution authorized.' }[action];
        service.reply(actor, id, key + ':receipt', `Decision recorded from ${user.display_name}’s discussion message (proposal v${version}): ${label}`);
        event(actor, d, 'discussion_decision', { message_id: messageId, action, author_id: user.id, version }, key + ':source');
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
        if (!actor.conversationId && expectedVersion !== undefined && d.state === 'needs_input' && eligible(actor, d)) {
          db.prepare('INSERT INTO bot_discussion_instructions(message_id,version,handling_revision) VALUES(?,?,?)').run(ev, d.version, d.handling_revision);
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
