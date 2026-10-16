import express from 'express';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { BotError, createBotService } from '../bots/service.js';
import { createCsTicketService, type TicketActor } from './service.js';

/**
 * /api/cs-tickets: the human Tickets tab for a bot enrolled to own tickets
 * inside Veneer, and the three bot tools (sync_cs_ticket, set_cs_ticket_status,
 * add_cs_ticket_note). Read access follows the owning bot's chat; bot calls
 * need the enrolled bot's own identity. No route sends a customer message.
 */
export function createCsTicketsRouter(ctx: AppContext) {
  const router = express.Router();
  const tickets = createCsTicketService(ctx.db);
  const bots = createBotService(ctx.db);
  router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  const run = (fn: (req: express.Request, res: express.Response) => unknown) => (req: express.Request, res: express.Response, next: express.NextFunction) => {
    Promise.resolve().then(() => fn(req, res)).catch((e) => {
      if (e instanceof BotError) res.status(e.status).json({ error: e.message });
      else if (e instanceof z.ZodError) res.status(400).json({ error: e.issues.map((x) => `${x.path.join('.')}: ${x.message}`).join('; ') });
      else next(e);
    });
  };
  const actor = (req: express.Request): TicketActor => ({ user: req.user!, conversationId: req.agentConversationId, executionConversationId: req.agentExecutionConversationId });
  const humanOnly = (req: express.Request) => { if (req.agentConversationId) throw new BotError(403, 'This is the human ticket view'); };

  router.get('/', run((req, res) => {
    const q = z.object({ owner: z.string().min(1).max(200), filter: z.enum(['needs_you', 'waiting', 'done', 'all']).default('all'), q: z.string().max(200).default('') }).parse(req.query);
    res.json(tickets.list(actor(req), q.owner, q.filter, q.q));
  }));
  router.post('/owners', run((req, res) => { humanOnly(req); res.json(tickets.setOwner(actor(req), req.body)); }));
  // Bot tools. "current" resolves the ticket from the calling ticket chat unless ticket_id names one.
  router.post('/sync', run((req, res) => res.json(tickets.sync(actor(req), req.body))));
  router.post('/current/status', run((req, res) => res.json(tickets.setStatus(actor(req), req.body))));
  router.post('/current/notes', run((req, res) => res.json(tickets.botNote(actor(req), req.body))));
  router.get('/:id', run((req, res) => {
    humanOnly(req);
    const detail = tickets.detail(actor(req), req.params.id!);
    const a = { user: req.user! };
    const decisions = detail.decision_ids.flatMap((id) => { try { return [bots.view(a, bots.read(a, id))]; } catch { return []; } });
    res.json({ ...detail, decisions });
  }));
  router.post('/:id/notes', run((req, res) => { humanOnly(req); res.json(tickets.humanNote(actor(req), req.params.id!, req.body)); }));
  return router;
}
