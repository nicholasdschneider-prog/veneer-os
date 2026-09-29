import type Database from 'better-sqlite3';
import { z } from 'zod';
import { BotError, type Actor } from './service.js';
import type { RoutineIdentity } from './routineExecution.js';
import type { RoutineSetupPacket } from './routineOwnerSetup.js';

// Presentation only. A readiness state reports recorded facts; it never grants
// authority, enables a capability, or substitutes for a guard at execution time.

export const readinessStates = ['draft', 'tested', 'blocked_on_integration', 'live_for_pilot', 'live', 'paused'] as const;
export type ReadinessState = typeof readinessStates[number];
export type Blocker = { owner: string; dependency: string };
export type Capability = {
  id: string; title: string; summary: string; state: ReadinessState; state_label: string;
  authority: string; blockers: Blocker[]; evidence: string[]; tests: string[]; execute: false;
};

const labels: Record<ReadinessState, string> = {
  draft: 'Draft', tested: 'Tested, not live', blocked_on_integration: 'Blocked on integration',
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

export function csReadiness(db: Database.Database, identity: RoutineIdentity | null, packet: RoutineSetupPacket, now: () => number = Date.now) {
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
    const blockers: Blocker[] = [], evidence: string[] = [];
    const applies = packet.business_id === business;
    const policy = applies ? db.prepare('SELECT id FROM bot_routine_policies WHERE business_id=? AND policy_key=? ORDER BY version DESC LIMIT 1').get(business, packet.policy_key) as { id: string } | undefined : undefined;
    const trust = policy ? db.prepare('SELECT id FROM routine_source_trust WHERE policy_id=? ORDER BY created_at DESC LIMIT 1').get(policy.id) as { id: string } | undefined : undefined;
    const revoked = Boolean((policy && db.prepare('SELECT 1 FROM bot_routine_policy_revocations WHERE policy_id=?').get(policy.id))
      || (trust && db.prepare('SELECT 1 FROM routine_source_revocations WHERE trust_id=?').get(trust.id)));
    const proofs = trust ? (db.prepare('SELECT count(*) n FROM routine_source_proofs WHERE trust_id=?').get(trust.id) as { n: number }).n : 0;
    const readbacks = trust ? (db.prepare(`SELECT count(*) n FROM routine_delivery_readbacks b JOIN routine_draft_claims c ON c.draft_id=b.draft_id
      JOIN routine_draft_authorizations a ON a.draft_id=c.draft_id WHERE a.trust_id=?`).get(trust.id) as { n: number }).n : 0;

    if (!applies) blockers.push({ owner: 'Platform Dev', dependency: 'No routine photo-request setup has been prepared for this business.' });
    else {
      if (!identity || identity.clientId !== packet.client_id || identity.audience !== packet.audience)
        blockers.push({ owner: 'Platform Dev', dependency: 'Configure and verify the dedicated routine service connection.' });
      if (!packet.source)
        blockers.push({ owner: 'OrderOps source owner', dependency: 'Deploy the routine source adapter and return its reviewed deployment, runtime and sending-bot identity receipts. None has been supplied.' });
      if (!policy) blockers.push({ owner: 'Business owner', dependency: `Authorize the photo-request policy at /#/routine-reply-setup. This step opens only after the technical prerequisites above are complete; no approval is needed yet.` });
      else if (!trust) blockers.push({ owner: 'Business owner', dependency: 'Confirm the source connection at /#/routine-reply-setup.' });
    }
    evidence.push(policy ? 'Standing policy enrolled by the business owner.' : 'No standing policy is enrolled. Policy text in bot training is not an enrollment.');
    evidence.push(`${proofs} source proof${proofs === 1 ? '' : 's'} received; ${readbacks} send${readbacks === 1 ? '' : 's'} confirmed by source readback.`);
    // Promotion from pilot to live is a human decision, so this view never reports it by itself.
    const state: ReadinessState = revoked ? 'paused' : blockers.length ? 'blocked_on_integration' : proofs ? 'live_for_pilot' : 'tested';
    if (revoked) blockers.unshift({ owner: 'Business owner', dependency: 'The policy or its source connection was revoked. It cannot be reactivated; a new version must be enrolled.' });
    return capability({
      id: 'routine-product-label-photo', title: 'Request a product-label photo without per-message approval',
      summary: 'When the label photo is missing and needed for the current question, the named bot sends the fixed request under standing authority.',
      authority: 'Standing policy enrolled by the business owner, limited to the fixed product-label photo request. No refund, replacement, tracking reply or remedy promise.',
      state, blockers, evidence, tests: ['server/test/routineExecution.test.ts', 'server/test/routineOwnerSetup.test.ts'],
    });
  }

  return {
    read(actor: Actor, raw: unknown) {
      const { business_id } = querySchema.parse(raw);
      access(actor, business_id);
      const capabilities = [approvedReply(business_id), photoRequest(business_id),
        ...unbuilt.map(c => capability({ ...c, state: 'draft', authority: 'None. Each case needs its own human approval.',
          blockers: [{ owner: 'Platform Dev', dependency: 'No source contract or adapter exists for this case type. It is not scheduled until the photo request completes end to end.' }],
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
