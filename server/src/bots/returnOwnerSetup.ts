import type Database from 'better-sqlite3';
import { z } from 'zod';
import { BotError, createBotService, type Actor } from './service.js';
import { canonicalSha256 } from './canonical.js';
import { returnExceptionService } from './returnException.js';
import { preparedReturnManifest as manifest, preparedReturnPayload as payload } from './preparedReturnRegistration.js';

export function returnOwnerSetup(db: Database.Database, config: { returnVerifierCfAud?: string | null; returnVerifierClientId?: string | null }) {
  const bridge = returnExceptionService(db);
  const manifestHash = canonicalSha256(manifest);
  const reviewHash = canonicalSha256({ manifest, payload });
  function check(actor: Actor) {
    if (actor.conversationId || !db.prepare("SELECT 1 FROM users u JOIN business_teams b ON b.owner_id=u.id WHERE u.id=? AND u.status='active' AND b.id=?").get(actor.user.id, payload.business_id))
      throw new BotError(403, 'Sign in as the current Elkhart RV Parts business owner to review this setup.');
    if (payload.request_key !== `source-registration-v1:${manifestHash}`) throw new BotError(409, 'Prepared registration integrity check failed.');
    if (config.returnVerifierCfAud !== payload.audience || config.returnVerifierClientId !== payload.client_id)
      throw new BotError(409, 'The dedicated return service configuration changed. Platform Dev must review it before confirmation.');
    const executor = createBotService(db).chat(actor, payload.executor_id);
    if (executor.user_id !== actor.user.id || executor.business_team_id !== payload.business_id || executor.archived ||
      !db.prepare('SELECT 1 FROM bot_registrations WHERE conversation_id=? AND active=1').get(payload.executor_id))
      throw new BotError(409, 'Avery’s current owner/business registration must be verified before confirmation.');
  }
  function status(actor: Actor) {
    check(actor);
    const rows = db.prepare('SELECT * FROM return_bridge_trust WHERE request_key=? OR (business_id=? AND account_id=? AND executor_id=?)').all(payload.request_key, payload.business_id, payload.account_id, payload.executor_id) as Array<Record<string, unknown>>;
    if (rows.length > 1 || rows.some(row => row.owner_id !== actor.user.id || Object.entries(payload).some(([k,v]) => row[k] !== v)))
      throw new BotError(409, 'A conflicting registration already exists. Stop and ask Platform Dev to reconcile it.');
    const row = rows[0];
    const revoked = row && !!db.prepare('SELECT 1 FROM return_bridge_revocations WHERE trust_id=?').get(row.id);
    return { review_hash: reviewHash, manifest, payload, status: revoked ? 'revoked' : row ? 'registered' : 'ready',
      receipt: row ? { trust_id: row.id as string, owner_id: row.owner_id as number, account_id: row.account_id as string, request_key: row.request_key as string, created_at: row.created_at as string } : null };
  }
  return {
    status,
    confirm(actor: Actor, raw: unknown) {
      const input = z.object({ review_hash: z.string(), confirm: z.literal(true) }).strict().parse(raw);
      return db.transaction(() => {
        const current = status(actor);
        if (input.review_hash !== reviewHash) throw new BotError(409, 'The prepared setup changed. Reload and review it before confirming.');
        if (current.status === 'revoked') throw new BotError(409, 'This registration was revoked. It cannot be reactivated here.');
        if (current.status === 'ready') bridge.enroll(actor, payload);
        return status(actor);
      }).immediate();
    },
  };
}
