import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { BotError, type Actor } from './service.js';
import { canonicalSha256 } from './canonical.js';
import { missingInformationBody } from './routineExecution.js';
import type { DraftPayload } from './draftPayload.js';

// Standing authority for one fixed request on the ordinary send path. It decides
// only whether a draft may be queued without a per-message approval. Claiming,
// sending once and recording the receipt stay with the ordinary draft lifecycle.

export const labelPhotoTemplate = {
  key: 'product-label-photo-v1',
  title: 'Product-label photo request',
  channel: 'email' as const,
  body: missingInformationBody(['product_label_photo']),
};
export const standingLimits = [
  'Only the exact message shown, by email, with no subject line of its own and no attachments.',
  'One recipient, on the ticket named in the draft. The source system sends ticket replies to the customer on that ticket.',
  'One request per ticket.',
  'Only the bots named here. Any other bot, wording or channel still needs a person to approve.',
  'No refund, replacement, tracking reply, fit promise or other commitment.',
  'A recorded reject, defer or withdrawal on the case stops the request.',
  'Sending the request does not resolve the case.',
];
const key = z.string().trim().min(1).max(200);
const enrollSchema = z.object({
  business_id: key, expected_version: z.number().int().nonnegative(), request_key: key,
  executor_ids: z.array(key).min(1).max(20), daily_cap: z.number().int().min(1).max(200).default(20),
  review_hash: z.string().regex(/^[a-f0-9]{64}$/), confirm: z.literal(true),
}).strict();
const revokeSchema = z.object({ policy_id: key, reason: z.string().trim().min(1).max(2000) }).strict();

type Policy = { id: string; business_id: string; template_key: string; version: number; issuer_id: number; request_key: string; daily_cap: number; snapshot_json: string; snapshot_hash: string; created_at: string };
type Snapshot = { template_key: string; channel: string; body: string; executor_ids: string[]; daily_cap: number; limits: string[] };
export type StandingAuthorization = { draft_id: string; policy_id: string; policy_version: number; business_id: string; executor_id: string; ticket: string; draft_version: number; payload_hash: string; created_at: string };
export type StandingOutcome = { applied: boolean; policy_id: string | null; policy_version: number | null; reasons: string[] };
type DraftRow = { id: string; conversation_id: string; decision_id: string | null; version: number; state: string; payload_json: string; authorized_by: number | null; delegation_id?: string | null };

export function csStandingPolicy(db: Database.Database, now: () => number = Date.now) {
  function owner(actor: Actor, business: string) {
    if (actor.conversationId) throw new BotError(403, 'Standing authority requires the signed-in business owner; a bot cannot enroll or revoke it');
    if (!db.prepare("SELECT 1 FROM users u JOIN business_teams b ON b.owner_id=u.id WHERE u.id=? AND u.status='active' AND b.id=?").get(actor.user.id, business))
      throw new BotError(403, 'Current business owner required');
  }
  const revoked = (id: string) => db.prepare('SELECT reason,created_at FROM cs_standing_policy_revocations WHERE policy_id=?').get(id) as { reason: string; created_at: string } | undefined;
  const latest = (business: string) => db.prepare('SELECT * FROM cs_standing_policies WHERE business_id=? AND template_key=? ORDER BY version DESC LIMIT 1').get(business, labelPhotoTemplate.key) as Policy | undefined;
  // Current means the newest version, unrevoked, whose issuer still owns the business.
  function current(business: string) {
    const policy = latest(business);
    if (!policy || revoked(policy.id)) return null;
    if (!db.prepare("SELECT 1 FROM users u JOIN business_teams b ON b.owner_id=u.id WHERE u.id=? AND u.status='active' AND b.id=?").get(policy.issuer_id, business)) return null;
    return { ...policy, snapshot: JSON.parse(policy.snapshot_json) as Snapshot };
  }
  function candidates(business: string) {
    return db.prepare(`SELECT c.id conversation_id, r.name, COALESCE(m.subteam,'') subteam FROM conversations c
      JOIN bot_registrations r ON r.conversation_id=c.id AND r.active=1
      LEFT JOIN business_bot_members m ON m.conversation_id=c.id
      JOIN users u ON u.id=c.user_id AND u.status='active'
      WHERE c.business_team_id=? AND c.archived=0 ORDER BY r.name`).all(business) as Array<{ conversation_id: string; name: string; subteam: string }>;
  }
  const dayStart = () => new Date(now()).toISOString().slice(0, 10) + ' 00:00:00';
  const usedToday = (business: string) => (db.prepare('SELECT count(*) n FROM cs_standing_authorizations WHERE business_id=? AND created_at>=?').get(business, dayStart()) as { n: number }).n;
  const stamp = () => new Date(now()).toISOString().slice(0, 19).replace('T', ' ');

  function view(business: string) {
    const policy = latest(business), live = current(business);
    const bots = candidates(business);
    const review = { business_id: business, template: labelPhotoTemplate, limits: standingLimits, next_version: (policy?.version ?? 0) + 1 };
    const revocation = policy ? revoked(policy.id) : undefined;
    return {
      business_id: business, status: live ? 'enrolled' as const : revocation ? 'revoked' as const : policy ? 'inactive' as const : 'not_enrolled' as const,
      review_hash: canonicalSha256(review), expected_version: policy?.version ?? 0,
      template: labelPhotoTemplate, limits: standingLimits, candidates: bots, default_daily_cap: 20,
      policy: policy ? {
        id: policy.id, version: policy.version, daily_cap: policy.daily_cap, created_at: policy.created_at,
        executors: (JSON.parse(policy.snapshot_json) as Snapshot).executor_ids.map(id => ({ conversation_id: id, name: bots.find(b => b.conversation_id === id)?.name ?? 'Unavailable bot' })),
        revoked: revocation ?? null,
      } : null,
      sent_with_receipt: (db.prepare(`SELECT count(*) n FROM cs_standing_authorizations a JOIN bot_message_drafts d ON d.id=a.draft_id
        WHERE a.business_id=? AND d.state='sent' AND d.receipt IS NOT NULL`).get(business) as { n: number }).n,
      used_today: usedToday(business),
    };
  }

  function evaluate(actor: Actor, draft: DraftRow, payload: DraftPayload): StandingOutcome {
    const none = (reasons: string[], policy?: Policy | null): StandingOutcome => ({ applied: false, policy_id: policy?.id ?? null, policy_version: policy?.version ?? null, reasons });
    const chat = db.prepare('SELECT business_team_id,archived FROM conversations WHERE id=?').get(draft.conversation_id) as { business_team_id: string | null; archived: number } | undefined;
    if (!chat?.business_team_id) return none(['This chat does not belong to a business.']);
    // Exact comparison only. Near matches are ordinary messages that need a person.
    if (payload.body !== labelPhotoTemplate.body) return none(['Not the fixed product-label photo request. A person must approve this message.']);
    const policy = current(chat.business_team_id);
    if (!policy) return none(['No current standing policy is enrolled for the product-label photo request.'], latest(chat.business_team_id));
    const reasons: string[] = [];
    if (!actor.conversationId || actor.conversationId !== draft.conversation_id) reasons.push('Only the named bot can queue its own draft.');
    if (!policy.snapshot.executor_ids.includes(draft.conversation_id)) reasons.push('This bot is not named in the standing policy.');
    if (chat.archived || !db.prepare('SELECT 1 FROM bot_registrations WHERE conversation_id=? AND active=1').get(draft.conversation_id)) reasons.push('The bot is not active.');
    if (payload.channel !== labelPhotoTemplate.channel) reasons.push('The standing policy covers email only.');
    if (payload.subject !== '') reasons.push('Leave the subject empty; the reply is sent on the existing ticket thread.');
    if (payload.attachments.length) reasons.push('Attachments are not covered.');
    if (payload.recipients.length !== 1 || !z.string().email().safeParse(payload.recipients[0]).success) reasons.push('Exactly one customer email recipient is required.');
    if (draft.delegation_id) reasons.push('Delegated drafts keep their own approval.');
    if (draft.state !== 'draft' || draft.authorized_by !== null) reasons.push('The draft is already authorized or closed.');
    // Recorded human direction on this ticket, read from structured fields only.
    const directed = db.prepare(`SELECT json_extract(d.answer_json,'$.action') action FROM bot_decisions d JOIN conversations o ON o.id=d.conversation_id
      WHERE o.business_team_id=? AND d.answer_json IS NOT NULL AND json_extract(d.answer_json,'$.action') IN ('reject','defer','withdraw')
      AND (d.id=? OR json_extract(d.proposal_json,'$.message_delivery.payload.ticket')=? COLLATE NOCASE
        OR d.id IN (SELECT m.decision_id FROM bot_message_drafts m WHERE m.decision_id IS NOT NULL AND json_extract(m.payload_json,'$.ticket')=? COLLATE NOCASE))
      LIMIT 1`).get(chat.business_team_id, draft.decision_id ?? '', payload.ticket, payload.ticket) as { action: string } | undefined;
    if (directed) reasons.push(`A person recorded ${directed.action} on this ticket. Send nothing under the standing policy.`);
    if (db.prepare('SELECT 1 FROM cs_standing_authorizations WHERE business_id=? AND template_key=? AND ticket=?').get(chat.business_team_id, labelPhotoTemplate.key, payload.ticket))
      reasons.push('A product-label photo request was already queued for this ticket. Reconcile it; do not send another.');
    if (usedToday(chat.business_team_id) >= policy.daily_cap) reasons.push(`The daily limit of ${policy.daily_cap} standing requests is reached. A person must approve further messages today.`);
    return reasons.length ? none(reasons, policy) : { applied: true, policy_id: policy.id, policy_version: policy.version, reasons: [] };
  }

  return {
    template: labelPhotoTemplate,
    status(actor: Actor, business: string) { owner(actor, business); return view(business); },
    enroll(actor: Actor, raw: unknown) {
      const p = enrollSchema.parse(raw);
      return db.transaction(() => {
        owner(actor, p.business_id);
        const before = view(p.business_id);
        const executors = [...new Set(p.executor_ids)].sort();
        if (executors.length !== p.executor_ids.length) throw new BotError(400, 'Duplicate bot');
        const snapshot: Snapshot = { template_key: labelPhotoTemplate.key, channel: labelPhotoTemplate.channel, body: labelPhotoTemplate.body, executor_ids: executors, daily_cap: p.daily_cap, limits: standingLimits };
        const hash = canonicalSha256(snapshot);
        const prior = db.prepare('SELECT * FROM cs_standing_policies WHERE business_id=? AND request_key=?').get(p.business_id, p.request_key) as Policy | undefined;
        if (prior) {
          if (prior.snapshot_hash !== hash || prior.issuer_id !== actor.user.id || prior.version !== p.expected_version + 1) throw new BotError(409, 'Enrollment request key conflict');
          return view(p.business_id);
        }
        if (p.review_hash !== before.review_hash) throw new BotError(409, 'The setup changed. Reload and review it before confirming.');
        if (before.expected_version !== p.expected_version) throw new BotError(409, 'Policy version changed; refresh before enrolling');
        if (before.status === 'enrolled') throw new BotError(409, 'A standing policy is already active. Revoke it before enrolling a new version.');
        for (const id of executors) if (!before.candidates.some(c => c.conversation_id === id)) throw new BotError(403, 'Each named bot must be active in this exact business');
        db.prepare('INSERT INTO cs_standing_policies(id,business_id,template_key,version,issuer_id,request_key,daily_cap,snapshot_json,snapshot_hash,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
          .run(crypto.randomUUID(), p.business_id, labelPhotoTemplate.key, p.expected_version + 1, actor.user.id, p.request_key, p.daily_cap, JSON.stringify(snapshot), hash, stamp());
        return view(p.business_id);
      }).immediate();
    },
    revoke(actor: Actor, raw: unknown) {
      const p = revokeSchema.parse(raw);
      return db.transaction(() => {
        const policy = db.prepare('SELECT * FROM cs_standing_policies WHERE id=?').get(p.policy_id) as Policy | undefined;
        if (!policy) throw new BotError(404, 'Policy not found');
        owner(actor, policy.business_id);
        const prior = revoked(policy.id);
        if (prior && prior.reason !== p.reason) throw new BotError(409, 'Revocation already recorded');
        db.prepare('INSERT OR IGNORE INTO cs_standing_policy_revocations(policy_id,actor_id,reason,created_at) VALUES(?,?,?,?)').run(policy.id, actor.user.id, p.reason, stamp());
        return view(policy.business_id);
      }).immediate();
    },
    /** Queue the bot's own exact-template draft. Call inside the caller's transaction. */
    apply(actor: Actor, draft: DraftRow): StandingOutcome {
      const payload = JSON.parse(draft.payload_json) as DraftPayload;
      const outcome = evaluate(actor, draft, payload);
      if (!outcome.applied) return outcome;
      const business = (db.prepare('SELECT business_team_id FROM conversations WHERE id=?').get(draft.conversation_id) as { business_team_id: string }).business_team_id;
      try {
        db.prepare('INSERT INTO cs_standing_authorizations(draft_id,policy_id,policy_version,business_id,template_key,executor_id,ticket,draft_version,payload_hash,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
          .run(draft.id, outcome.policy_id, outcome.policy_version, business, labelPhotoTemplate.key, draft.conversation_id, payload.ticket, draft.version, canonicalSha256(payload), stamp());
      } catch (e) {
        // The unique constraint, not the earlier read, decides a race for the same ticket.
        if (e instanceof Error && /UNIQUE/.test(e.message)) return { ...outcome, applied: false, reasons: ['A product-label photo request was already queued for this ticket. Reconcile it; do not send another.'] };
        throw e;
      }
      db.prepare("UPDATE bot_message_drafts SET state='queued',updated_at=datetime('now') WHERE id=? AND state='draft' AND authorized_by IS NULL").run(draft.id);
      return outcome;
    },
    authorization(draftId: string) {
      return db.prepare('SELECT * FROM cs_standing_authorizations WHERE draft_id=?').get(draftId) as StandingAuthorization | undefined;
    },
    /** Recheck at claim time. Throws when the standing authority no longer covers this draft. */
    checkClaim(draft: DraftRow) {
      const auth = this.authorization(draft.id);
      if (!auth) throw new BotError(409, 'No standing authorization is recorded for this draft');
      const policy = current(auth.business_id);
      if (!policy || policy.id !== auth.policy_id) throw new BotError(409, 'The standing policy was revoked or replaced. This message must not be sent; retire the draft or ask a person.');
      if (!policy.snapshot.executor_ids.includes(draft.conversation_id) || !db.prepare('SELECT 1 FROM bot_registrations WHERE conversation_id=? AND active=1').get(draft.conversation_id))
        throw new BotError(403, 'This bot is no longer named in the standing policy');
      if (draft.version !== auth.draft_version || canonicalSha256(JSON.parse(draft.payload_json)) !== auth.payload_hash)
        throw new BotError(409, 'The message changed after it was queued under the standing policy');
      const issuer = db.prepare('SELECT display_name FROM users WHERE id=?').get(policy.issuer_id) as { display_name: string };
      return { policy_id: policy.id, policy_version: policy.version, enrolled_by: issuer.display_name };
    },
    outcome(draft: DraftRow): StandingOutcome | null {
      const auth = this.authorization(draft.id);
      return auth ? { applied: true, policy_id: auth.policy_id, policy_version: auth.policy_version, reasons: [] } : null;
    },
    explain(actor: Actor, draft: DraftRow): StandingOutcome { return evaluate(actor, draft, JSON.parse(draft.payload_json) as DraftPayload); },
  };
}
