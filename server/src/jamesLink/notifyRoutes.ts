import express from 'express';
import { z } from 'zod';
import type { JamesLink } from './service.js';

/**
 * Agent-only routes behind notify_james / read_james_notification. The chat is
 * always the calling agent's own conversation, taken from its token, never
 * from the request.
 */

const NotifyBody = z.object({
  text: z.string().trim().min(1).max(8_000),
  authority_turn: z.number().int().min(1).optional(),
  idempotency_key: z.string().trim().regex(/^[\x21-\x7e]{8,200}$/),
});

export function createJamesNotifyRouter(getLink: () => JamesLink | null) {
  const router = express.Router();
  router.use((req, res, next) => {
    if (!req.agentConversationId) { res.status(403).json({ ok: false, error: 'notify_james is a bot tool for the calling chat only' }); return; }
    if (!getLink()) { res.status(503).json({ ok: false, error: 'james_link_unavailable' }); return; }
    next();
  });
  router.post('/', (req, res) => {
    const body = NotifyBody.safeParse(req.body);
    if (!body.success) { res.status(400).json({ ok: false, error: 'text and idempotency_key (authority_turn optional) (8-200 printable characters) are required' }); return; }
    void getLink()!.notifyJames({
      conversationId: req.agentConversationId!,
      text: body.data.text,
      authorityTurn: body.data.authority_turn,
      idempotencyKey: body.data.idempotency_key,
    }).then((result) => {
      if (!result.ok) { const { status, ...rest } = result; res.status(status).json(rest); return; }
      res.json(result);
    }).catch((err: Error) => res.status(500).json({ ok: false, error: err.message }));
  });
  router.get('/:key', (req, res) => {
    const result = getLink()!.notification(req.agentConversationId!, req.params.key);
    if (!result.ok) { const { status, ...rest } = result; res.status(status).json(rest); return; }
    res.json(result);
  });
  return router;
}
