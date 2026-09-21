import express from 'express';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { createHuddleService, HuddleError } from './service.js';

/**
 * REST surface for huddles. Authority comes from the request identity only:
 * a bot is whatever `req.agentConversationId` says, a human is `req.user`.
 * The MCP process never touches the DB, so every rule lives here.
 */
export function createHuddlesRouter(ctx: AppContext) {
  const router = express.Router();
  const s = createHuddleService(ctx.db);
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  const run =
    (fn: (req: express.Request, res: express.Response) => unknown) =>
    (req: express.Request, res: express.Response, next: express.NextFunction) => {
      Promise.resolve()
        .then(() => fn(req, res))
        .catch((e) => {
          if (e instanceof HuddleError) res.status(e.status).json({ ok: false, error: e.message });
          else if (e instanceof z.ZodError)
            res.status(400).json({ ok: false, error: e.issues.map((x) => `${x.path.join('.')}: ${x.message}`).join('; ') });
          else next(e);
        });
    };
  const actor = (req: express.Request) => ({ user: req.user!, conversationId: req.agentConversationId });
  const ids = z.object({ conversation_ids: z.array(z.string().min(1)).min(1).max(6) });

  router.get(
    '/',
    run((req, res) => {
      const status = req.query.status === 'closed' || req.query.status === 'all' ? req.query.status : 'open';
      const business = typeof req.query.business === 'string' && req.query.business ? req.query.business : null;
      res.json({ ok: true, huddles: s.list(actor(req), status, business) });
    }),
  );
  router.get(
    '/candidates',
    run((req, res) => {
      const id = typeof req.query.huddle === 'string' && req.query.huddle ? req.query.huddle : undefined;
      res.json({ ok: true, bots: s.candidates(actor(req), id) });
    }),
  );
  router.post(
    '/',
    run((req, res) => {
      const result = s.open(actor(req), req.body);
      res.status(result.created ? 201 : 200).json({ ok: true, ...result });
    }),
  );
  router.get(
    '/:id',
    run((req, res) => {
      const after = Number(req.query.after ?? 0);
      const ack = req.query.ack === '1' && Boolean(req.agentConversationId);
      const huddle = ack ? s.read(actor(req), String(req.params.id), Number.isFinite(after) ? after : 0) : s.get(actor(req), String(req.params.id), Number.isFinite(after) ? after : 0);
      res.json({ ok: true, huddle });
    }),
  );
  router.post(
    '/:id/read',
    run((req, res) => {
      const after = Number(req.body?.after_seq ?? 0);
      res.json({ ok: true, huddle: s.read(actor(req), String(req.params.id), Number.isFinite(after) ? after : 0) });
    }),
  );
  router.post(
    '/:id/messages',
    run((req, res) => {
      const result = s.post(actor(req), String(req.params.id), req.body);
      res.status(result.duplicate ? 200 : 201).json({ ok: true, ...result });
    }),
  );
  router.post(
    '/:id/members',
    run((req, res) => {
      res.json({ ok: true, huddle: s.invite(actor(req), String(req.params.id), ids.parse(req.body).conversation_ids) });
    }),
  );
  router.delete(
    '/:id/members/:conversationId',
    run((req, res) => {
      res.json({ ok: true, huddle: s.removeMember(actor(req), String(req.params.id), String(req.params.conversationId)) });
    }),
  );
  router.patch(
    '/:id',
    run((req, res) => {
      res.json({ ok: true, huddle: s.patch(actor(req), String(req.params.id), req.body) });
    }),
  );
  router.post(
    '/:id/actions',
    run((req, res) => {
      res.status(201).json({ ok: true, huddle: s.addAction(actor(req), String(req.params.id), req.body) });
    }),
  );
  router.patch(
    '/:id/actions/:actionId',
    run((req, res) => {
      res.json({ ok: true, huddle: s.updateAction(actor(req), String(req.params.id), String(req.params.actionId), req.body) });
    }),
  );
  router.post(
    '/:id/close',
    run((req, res) => {
      res.json({ ok: true, huddle: s.close(actor(req), String(req.params.id), String(req.body?.verification ?? '')) });
    }),
  );
  router.post(
    '/:id/reopen',
    run((req, res) => {
      res.json({ ok: true, huddle: s.reopen(actor(req), String(req.params.id), String(req.body?.reason ?? '')) });
    }),
  );
  return router;
}
