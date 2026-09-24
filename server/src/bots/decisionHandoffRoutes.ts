import express from 'express';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { BotError } from './service.js';
import { createDecisionHandoffs } from './decisionHandoffs.js';

export function createDecisionHandoffRouter(ctx: AppContext) {
  const router = express.Router();
  const s = createDecisionHandoffs(ctx.db);
  const run = (fn: (req: express.Request) => unknown): express.RequestHandler => (req, res, next) => {
    try { res.json(fn(req)); } catch (e) {
      if (e instanceof BotError) res.status(e.status).json({ error: e.message });
      else if (e instanceof z.ZodError) res.status(400).json({ error: 'Invalid investigation request' });
      else next(e);
    }
  };
  const actor = (req: express.Request) => ({ user: req.user!, conversationId: req.agentConversationId });
  router.get('/decisions/:id/handoff-targets', run(req => ({ targets: s.targets(actor(req), req.params.id!, z.string().max(200).parse(req.query.q ?? '')) })));
  router.get('/decisions/:id/handoffs', run(req => ({ handoffs: s.list(actor(req), req.params.id!) })));
  router.post('/decisions/:id/handoffs', run(req => s.create(actor(req), req.params.id!, req.body)));
  router.get('/handoffs/:id', run(req => s.read(actor(req), req.params.id!)));
  router.post('/handoffs/:id/result', run(req => s.report(actor(req), req.params.id!, req.body)));
  return router;
}
