import type Database from 'better-sqlite3';
import { z } from 'zod';
import { BotError, type Actor } from './service.js';
import { csStandingPolicy } from './csStandingPolicy.js';

// Presentation only. A readiness state reports recorded facts; it never grants
// authority, enables a capability, or substitutes for a guard at execution time.

export const readinessStates = ['draft', 'tested', 'blocked_on_integration', 'awaiting_owner', 'live_for_pilot', 'live', 'paused'] as const;
export type ReadinessState = typeof readinessStates[number];
export type Blocker = { owner: string; dependency: string };
export type Capability = {
  id: string; title: string; summary: string; state: ReadinessState; state_label: string;
  authority: string; blockers: Blocker[]; evidence: string[]; tests: string[]; execute: false;
};

const labels: Record<ReadinessState, string> = {
  draft: 'Draft', tested: 'Tested, not live', blocked_on_integration: 'Blocked on integration', awaiting_owner: 'Waiting for owner authorization',
  live_for_pilot: 'Live for pilot', live: 'Live', paused: 'Paused',
};
const querySchema = z.object({ business_id: z.string().trim().min(1).max(200) }).strict();
const stuckAfterHours = 24, windowDays = 30;

// Categories with an envelope in policy text but no source contract or adapter.
const unbuilt = [
  { id: 'routine-factual-tracking', title: 'Answer order tracking questions', summary: 'Reply with the current carrier status for the exact paid order.' },
  { id: 'routine-acknowledgment-close', title: 'Close after a thank-you', summary: 'Close a resolved case when the customer only acknowledges, without another email.' },
  { id: 'routine-catalog-answer', title: 'Answer published product questions', summary: 'Answer from current catalog facts without a fit guarantee.' },
  { id: 'routine-status-restatement', title: 'Restate an existing return or claim status', summary: 'Report the verified current status and next step of an approved return or claim.' },
] as const;

export function csReadiness(db: Database.Database, now: () => number = Date.now) {
  function access(actor: Actor, business: string) {
    if (!db.prepare("SELECT 1 FROM users WHERE id=? AND status='active'").get(actor.user.id)) throw new BotError(403, 'Active authenticated identity required');
    if (!db.prepare('SELECT 1 FROM business_teams WHERE id=?').get(business)) throw new BotError(404, 'Business not found');
    if (actor.conversationId) {
      const member = db.prepare(`SELECT 1 FROM conversations c JOIN bot_registrations r ON r.conversation_id=c.id
        WHERE c.id=? AND c.user_id=? AND c.business_team_id=? AND c.archived=0 AND r.active=1`).get(actor.conversationId, actor.user.id, business);
      if (!member) throw new BotError(403, 'Readiness is available to active bots in this exact business');
      return;
    }
    if (!db.prepare('SELECT 1 FROM business_teams WHERE id=? AND owner_id=?').get(business, actor.user.id)) throw new BotError(403, 'Current business owner required');
  }
  const capability = (c: Omit<Capability, 'state_label' | 'execute'>): Capability => ({ ...c, state_label: labels[c.state], execute: false });

  function approvedReply(business: string) {
    const since = new Date(now() - windowDays * 86_400_000).toISOString().slice(0, 19).replace('T', ' ');
    const stuckBefore = new Date(now() - stuckAfterHours * 3_600_000).toISOString().slice(0, 19).replace('T', ' ');
    const rows = db.prepare(`SELECT r.name, d.state, d.receipt, d.claim_key, d.authorized_by, d.updated_at,
      EXISTS(SELECT 1 FROM bot_message_retirements x WHERE x.draft_id=d.id) retired
      FROM bot_message_drafts d JOIN conversations c ON c.id=d.conversation_id JOIN bot_registrations r ON r.conversation_id=d.conversation_id
      WHERE c.business_team_id=? AND d.created_at>=?`).all(business, since) as Array<{ name: string; state: string; receipt: string | null; claim_key: string | null; authorized_by: number | null; updated_at: string; retired: number }>;
    const open = rows.filter(d => !d.retired && d.state !== 'discarded');
    const sent = open.filter(d => d.state === 'sent' && d.receipt);
    const unknown = open.filter(d => !(d.state === 'sent' && d.receipt) && d.state !== 'failed' && (['sending', 'uncertain', 'sent'].includes(d.state) || d.claim_key));
    const unsent = open.filter(d => d.state === 'queued' && d.authorized_by !== null && !d.claim_key && d.updated_at < stuckBefore);
    const names = (list: typeof open) => [...new Set(list.map(d => d.name))].sort().join(', ');
    const blockers: Blocker[] = [];
    if (unknown.length) blockers.push({ owner: names(unknown), dependency: `${unknown.length} claimed send${unknown.length === 1 ? '' : 's'} with no recorded receipt. The claiming bot must reconcile the source receipt read-only; it must not send again.` });
    if (unsent.length) blockers.push({ owner: names(unsent), dependency: `${unsent.length} authorized message${unsent.length === 1 ? '' : 's'} still unsent more than ${stuckAfterHours} hours after authorization. The named executor must claim and send, or record the exact technical failure.` });
    return capability({
      id: 'approved-customer-reply', title: 'Send an approved customer reply',
      summary: 'A bot prepares the exact message, a person approves it once, and the owning bot sends it once and records the receipt.',
      authority: 'One human send authorization for the exact message. No standing authority.',
      state: blockers.length ? 'blocked_on_integration' : sent.length ? 'live' : 'tested',
      blockers,
      evidence: [`Last ${windowDays} days: ${sent.length} sent with receipt, ${unknown.length} with unknown outcome, ${unsent.length} authorized and overdue, ${open.filter(d => d.authorized_by === null && d.state === 'draft').length} drafts never authorized.`],
      tests: ['server/test/botCommunication.test.ts', 'server/test/csPilotDelivery.test.ts'],
    });
  }

  function photoRequest(business: string) {
    const policies = csStandingPolicy(db, now);
    const policy = db.prepare("SELECT id,version,daily_cap FROM cs_standing_policies WHERE business_id=? AND template_key=? ORDER BY version DESC LIMIT 1")
      .get(business, policies.template.key) as { id: string; version: number; daily_cap: number } | undefined;
    const revoked = Boolean(policy && db.prepare('SELECT 1 FROM cs_standing_policy_revocations WHERE policy_id=?').get(policy.id));
    const issuerCurrent = Boolean(policy && db.prepare(`SELECT 1 FROM cs_standing_policies p JOIN business_teams b ON b.id=p.business_id AND b.owner_id=p.issuer_id
      JOIN users u ON u.id=p.issuer_id AND u.status='active' WHERE p.id=?`).get(policy.id));
    const rows = db.prepare(`SELECT r.name, d.state, d.receipt, d.claim_key FROM cs_standing_authorizations a JOIN bot_message_drafts d ON d.id=a.draft_id
      JOIN bot_registrations r ON r.conversation_id=a.executor_id WHERE a.business_id=?`).all(business) as Array<{ name: string; state: string; receipt: string | null; claim_key: string | null }>;
    const sent = rows.filter(d => d.state === 'sent' && d.receipt);
    const unknown = rows.filter(d => !(d.state === 'sent' && d.receipt) && d.state !== 'failed' && d.state !== 'discarded' && (['sending', 'uncertain', 'sent'].includes(d.state) || d.claim_key));
    const blockers: Blocker[] = [];
    if (!policy) blockers.push({ owner: 'Business owner', dependency: 'Review and authorize the product-label photo request at /#/routine-reply-setup. Nothing else is required first.' });
    else if (revoked || !issuerCurrent) blockers.push({ owner: 'Business owner', dependency: 'The standing policy was revoked or its issuer no longer owns the business. Enroll a new version at /#/routine-reply-setup to resume.' });
    if (unknown.length) blockers.push({ owner: [...new Set(unknown.map(d => d.name))].sort().join(', '), dependency: `${unknown.length} claimed request${unknown.length === 1 ? '' : 's'} with no recorded receipt. The claiming bot must reconcile read-only; it must not send again.` });
    // Promotion from pilot to live is a human decision, so this view never reports it by itself.
    const state: ReadinessState = !policy ? 'awaiting_owner' : revoked || !issuerCurrent ? 'paused' : unknown.length ? 'blocked_on_integration' : sent.length ? 'live_for_pilot' : 'tested';
    return capability({
      id: 'routine-product-label-photo', title: 'Request a product-label photo without per-message approval',
      summary: 'A named bot sends the fixed product-label photo request on the ticket, once, under the owner\u2019s standing policy.',
      authority: 'Standing policy enrolled by the business owner, limited to the exact fixed message by email, one per ticket, with a daily limit. No refund, replacement, tracking reply or remedy promise.',
      state, blockers,
      evidence: [
        policy ? `Standing policy version ${policy.version} enrolled; daily limit ${policy.daily_cap}.` : 'No standing policy is enrolled. Policy text in bot training is not an enrollment.',
        `${rows.length} request${rows.length === 1 ? '' : 's'} queued under the policy; ${sent.length} sent with receipt; ${unknown.length} with unknown outcome.`,
      ],
      tests: ['server/test/csStandingPolicy.test.ts', 'server/test/csPilotDelivery.test.ts'],
    });
  }

  return {
    read(actor: Actor, raw: unknown) {
      const { business_id } = querySchema.parse(raw);
      access(actor, business_id);
      const capabilities = [approvedReply(business_id), photoRequest(business_id),
        ...unbuilt.map(c => capability({ ...c, state: 'draft', authority: 'None. Each case needs its own human approval.',
          blockers: [{ owner: 'Platform Dev', dependency: 'No standing policy template exists for this case type. It is not scheduled until the photo request completes end to end.' }],
          evidence: ['Described in training only.'], tests: [] }))];
      return {
        business_id, as_of: new Date(now()).toISOString(), capabilities,
        autonomous: capabilities.filter(c => c.state === 'live' || c.state === 'live_for_pilot').filter(c => c.id !== 'approved-customer-reply').map(c => c.id),
        notice: 'Readiness reports recorded facts. It does not grant authority or permit a send; every execution guard still applies.',
      };
    },
  };
}
export type CsReadinessView = ReturnType<ReturnType<typeof csReadiness>['read']>;
