import express from 'express';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { resolveAgentTokenContext } from '../runtime/agentTokens.js';
import { canSendToConversation } from '../conversations/access.js';
import type { UserRow, ConversationRow } from '../db/db.js';
import { BotError } from '../bots/service.js';
import { qboBoundary, unavailableFacts, type QboFactResolver } from './boundary.js';
import { inspectResponseSchema, responseSchema, readResponseSchema, reconcileResponseSchema, errorResponseSchema, type Caller } from './contract.js';

export function authenticatedQboCaller(ctx: Pick<AppContext, 'db'>, req: express.Request): Caller {
  const token = req.get('X-VP-Agent-Token');
  // Existing native session authentication, never use body/caller labels or a
  // human CF identity alone as a substitute for the original bot invocation.
  const session = token ? resolveAgentTokenContext(ctx.db, token) : null;
  const tokenRow = token ? ctx.db.prepare('SELECT expires_at FROM agent_tokens WHERE token=?').get(token) as {expires_at:number}|undefined : undefined;
  if (!tokenRow || tokenRow.expires_at <= Date.now() || !session?.conversationId) throw new BotError(403, 'QBO_NATIVE_AGENT_SESSION_REQUIRED');
  const user = ctx.db.prepare("SELECT * FROM users WHERE email=? AND status='active'").get(session.email) as UserRow | undefined;
  const conversation = ctx.db.prepare('SELECT * FROM conversations WHERE id=? AND archived=0').get(session.conversationId) as ConversationRow | undefined;
  if (!user || !conversation || !canSendToConversation(user, conversation, ctx.db) || !ctx.db.prepare('SELECT 1 FROM bot_registrations WHERE conversation_id=? AND active=1').get(conversation.id)) throw new BotError(403, 'QBO_NATIVE_CALLER_REVOKED');
  return { userId: user.id, conversationId: conversation.id, executionConversationId: session.executionConversationId ?? null, sessionExpiresAt: new Date(tokenRow.expires_at).toISOString() };
}
export function qboRoutes(ctx: AppContext, resolver: QboFactResolver = unavailableFacts) {
  const router = express.Router(), boundary = qboBoundary(ctx.db, resolver);
  router.use(express.json({ limit: '16kb' }));
  router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  const schemas = { inspect: inspectResponseSchema, admit: responseSchema, read: readResponseSchema, reconcile: reconcileResponseSchema };
  for (const operation of ['inspect', 'admit', 'read', 'reconcile'] as const) {
    router.post('/qbo/' + operation, (req, res, next) => {
      void Promise.resolve().then(() => {
        z.object({}).strict().parse(req.query);
        return boundary[operation](() => authenticatedQboCaller(ctx, req), req.body);
      }).then(value => res.json(schemas[operation].parse(value))).catch(next);
    });
  }
  router.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error instanceof BotError ? error.status : error instanceof z.ZodError ? 400 : 503)
      .json(errorResponseSchema.parse({ error: error instanceof BotError ? error.message : 'QBO_BOUNDARY_INVALID_OR_UNAVAILABLE' }));
  });
  return router;
}
