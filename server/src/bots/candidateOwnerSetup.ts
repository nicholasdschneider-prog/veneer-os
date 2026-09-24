import type Database from 'better-sqlite3';
import { z } from 'zod';
import { BotError, createBotService, type Actor } from './service.js';
import { canonicalSha256 } from './canonical.js';
import { autoshipCandidates } from '../botWorkflows/autoshipCandidates.js';
import { preparedCandidateManifest as manifest, preparedCandidatePayload as payload } from './preparedCandidateRegistration.js';

export function candidateOwnerSetup(db: Database.Database, config: { autoshipCandidateCfAud?: string | null; autoshipCandidateClientId?: string | null }) {
  const bridge = autoshipCandidates(db);
  const reviewHash = canonicalSha256({ manifest, payload });
  function check(actor: Actor) {
    if (actor.conversationId || !db.prepare("SELECT 1 FROM users u JOIN business_teams b ON b.owner_id=u.id WHERE u.id=? AND u.status='active' AND b.id=?").get(actor.user.id, payload.business_id))
      throw new BotError(403, 'Sign in as the current Elkhart RV Parts business owner to review this setup.');
    if (config.autoshipCandidateCfAud !== payload.audience || config.autoshipCandidateClientId !== payload.client_id)
      throw new BotError(409, 'The dedicated candidate service configuration changed. Platform Dev must review it before confirmation.');
    const executor = createBotService(db).chat(actor, payload.recipient_id);
    if (executor.user_id !== actor.user.id || executor.business_team_id !== payload.business_id || executor.archived ||
      !db.prepare('SELECT 1 FROM bot_registrations WHERE conversation_id=? AND active=1').get(payload.recipient_id))
      throw new BotError(409, 'AutoShip’s current owner/business registration must be verified before confirmation.');
  }
  function status(actor: Actor) {
    check(actor);
    const rows = db.prepare('SELECT * FROM autoship_candidate_sources WHERE request_key=? OR (business_id=? AND account_id=? AND recipient_id=?)').all(payload.request_key, payload.business_id, payload.account_id, payload.recipient_id) as Array<Record<string, unknown>>;
    if (rows.length > 1 || rows.some(row => row.owner_id !== actor.user.id || Object.entries(payload).some(([k,v]) => row[k] !== v)))
      throw new BotError(409, 'A conflicting registration already exists. Stop and ask Platform Dev to reconcile it.');
    const row = rows[0];
    const revoked = row && !!db.prepare('SELECT 1 FROM autoship_candidate_revocations WHERE source_id=?').get(row.id);
    return { review_hash: reviewHash, manifest, payload, status: revoked ? 'revoked' : row ? 'registered' : 'ready',
      receipt: row ? { source_id: row.id as string, owner_id: row.owner_id as number, account_id: row.account_id as string, request_key: row.request_key as string, created_at: row.created_at as string } : null };
  }
  return {
    status,
    confirm(actor: Actor, raw: unknown) {
      const input = z.object({ review_hash: z.string(), confirm: z.literal(true) }).strict().parse(raw);
      return db.transaction(() => {
        const current = status(actor);
        if (input.review_hash !== reviewHash) throw new BotError(409, 'The prepared setup changed. Reload and review it before confirming.');
        if (current.status === 'revoked') throw new BotError(409, 'This registration was revoked. It cannot be reactivated here.');
        if (current.status === 'ready') bridge.enroll(actor, payload, {audience: payload.audience, clientId: payload.client_id});
        return status(actor);
      }).immediate();
    },
  };
}
