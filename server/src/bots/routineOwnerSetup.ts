import type Database from 'better-sqlite3';
import { z } from 'zod';
import { BotError, createBotService, type Actor } from './service.js';
import { canonicalSha256 } from './canonical.js';
import { routinePolicyService } from './routinePolicies.js';
import { routineExecutionService, type RoutineIdentity } from './routineExecution.js';

export type RoutineSetupPacket = {
  business_id: string; account_id: string; source_origin: string; client_id: string; audience: string;
  policy_key: string; policy_request_key: string; trust_request_key: string;
  source_reference: string; policy_text: string;
  source: { executor_id: string; principal_id: string; adapter_digest: string; registration_reference: string;
    deployment_receipt: string; principal_receipt: string; runtime_receipt: string } | null;
};

export function routineOwnerSetup(db: Database.Database, identity: RoutineIdentity | null, packet: RoutineSetupPacket) {
  const policies = routinePolicyService(db);
  const execution = routineExecutionService(db, { identity });
  const reviewHash = canonicalSha256(packet);
  function checkOwner(actor: Actor) {
    if (actor.conversationId || !db.prepare("SELECT 1 FROM users u JOIN business_teams b ON b.owner_id=u.id WHERE u.id=? AND u.status='active' AND b.id=?").get(actor.user.id, packet.business_id))
      throw new BotError(403, 'Sign in as the current Elkhart RV Parts business owner to review routine reply setup.');
  }
  function policyPayload() {
    return { business_id: packet.business_id, policy_key: packet.policy_key, expected_version: 0,
      request_key: packet.policy_request_key, source_reference: packet.source_reference, policy_text: packet.policy_text,
      executor_ids: [packet.source!.executor_id], categories: ['missing_information'], missing_information_fields: ['product_label_photo'] };
  }
  function trustPayload(policyId: string) {
    const source = packet.source!;
    return { policy_id: policyId, executor_id: source.executor_id, request_key: packet.trust_request_key,
      account_id: packet.account_id, principal_id: source.principal_id, client_id: packet.client_id, audience: packet.audience,
      source_origin: packet.source_origin, adapter_digest: source.adapter_digest,
      registration_reference: source.registration_reference, contract: 'routine-missing-information/v1' };
  }
  function status(actor: Actor) {
    checkOwner(actor);
    const blockers: Array<{ owner: string; reason: string }> = [];
    if (!identity || identity.clientId !== packet.client_id || identity.audience !== packet.audience)
      blockers.push({ owner: 'Platform Dev', reason: 'Dedicated routine connection must be configured and verified.' });
    if (!packet.source) blockers.push({ owner: 'OrderOps source owner', reason: 'Reviewed deployed adapter, runtime connection and current sending-bot identity receipts are still required.' });
    else {
      const source = packet.source;
      if (!/^[a-f0-9]{64}$/.test(source.adapter_digest) || [source.executor_id, source.principal_id, source.registration_reference, source.deployment_receipt, source.principal_receipt, source.runtime_receipt].some(value => !value.trim()))
        throw new BotError(409, 'Prepared source evidence is incomplete. Platform Dev must reconcile it.');
      const executor = createBotService(db).chat(actor, source.executor_id);
      if (executor.archived || executor.business_team_id !== packet.business_id || !db.prepare("SELECT 1 FROM users WHERE id=? AND status='active'").get(executor.user_id) ||
        !db.prepare('SELECT 1 FROM bot_registrations WHERE conversation_id=? AND active=1').get(source.executor_id))
        blockers.push({ owner: 'Platform Dev', reason: 'The named sending bot must have current active business membership.' });
    }
    const existing = policies.list(actor, packet.business_id);
    const matching = existing.filter(p => p.policy_key === packet.policy_key || p.request_key === packet.policy_request_key);
    // Do not supersede any live policy or silently create overlapping standing authority.
    if (matching.length > 1 || existing.some(p => !matching.includes(p) && p.status === 'enrolled_setup_required' && p.snapshot.categories.includes('missing_information')))
      throw new BotError(409, 'An existing routine policy needs reconciliation before new authority is enrolled.');
    const policy = matching[0];
    if (policy && (!packet.source || policy.issuer_id !== actor.user.id || policy.version !== 1 || policy.request_key !== packet.policy_request_key || policy.policy_key !== packet.policy_key ||
      policy.snapshot.policy_text !== packet.policy_text || policy.snapshot.source_reference !== packet.source_reference ||
      canonicalSha256(policy.snapshot.executor_ids) !== canonicalSha256([packet.source.executor_id]) ||
      canonicalSha256(policy.snapshot.categories) !== canonicalSha256(['missing_information']) ||
      canonicalSha256(policy.snapshot.missing_information_fields ?? null) !== canonicalSha256(['product_label_photo'])))
      throw new BotError(409, 'A conflicting routine policy exists. Platform Dev must reconcile it.');
    const trusts = db.prepare(`SELECT t.* FROM routine_source_trust t JOIN bot_routine_policies p ON p.id=t.policy_id
      WHERE p.business_id=? AND (t.request_key=? OR json_extract(t.snapshot_json,'$.account_id')=?)`).all(packet.business_id, packet.trust_request_key, packet.account_id) as Array<{id:string;policy_id:string;owner_id:number;snapshot_hash:string;created_at:string}>;
    if (trusts.length > 1 || trusts.some(t => !policy || t.owner_id !== actor.user.id || t.policy_id !== policy.id || t.snapshot_hash !== canonicalSha256(trustPayload(policy.id))))
      throw new BotError(409, 'A conflicting routine connection exists. Platform Dev must reconcile it.');
    const trust = trusts[0];
    const revoked = (policy && policy.status !== 'enrolled_setup_required') || (trust && !!db.prepare('SELECT 1 FROM routine_source_revocations WHERE trust_id=?').get(trust.id));
    return { review_hash: reviewHash, status: revoked ? 'revoked' : blockers.length ? 'blocked' : trust ? 'registered' : 'ready',
      blockers, policy_text: packet.policy_text, source: packet.source,
      connection: { account_id: packet.account_id, source_origin: packet.source_origin },
      receipt: trust && policy ? { policy_id: policy.id, trust_id: trust.id, owner_id: trust.owner_id, account_id: packet.account_id, request_key: packet.trust_request_key, created_at: trust.created_at } : null };
  }
  return {
    status,
    confirm(actor: Actor, raw: unknown) {
      const input = z.object({ review_hash: z.string(), confirm: z.literal(true) }).strict().parse(raw);
      return db.transaction(() => {
        const current = status(actor);
        if (input.review_hash !== reviewHash) throw new BotError(409, 'The prepared setup changed. Reload and review it before confirming.');
        if (current.status === 'blocked' || current.status === 'revoked') throw new BotError(409, 'Routine setup is blocked or revoked. No standing authority was added.');
        if (current.status === 'ready') {
          const policy = policies.enroll(actor, policyPayload());
          execution.enroll(actor, trustPayload(policy.id));
        }
        return status(actor);
      }).immediate();
    },
  };
}
