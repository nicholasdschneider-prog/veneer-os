import express from 'express';
import { z } from 'zod';
import { URGENT_FOR_NICK, type JamesLink } from './service.js';

/**
 * Agent-only routes behind notify_james / read_james_notification. The chat is
 * always the calling agent's own conversation, taken from its token, never
 * from the request.
 */

const NotifyBody = z.object({
  text: z.string().trim().min(1).max(8_000),
  authority_turn: z.number().int().min(1).optional(),
  idempotency_key: z.string().trim().regex(/^[\x21-\x7e]{8,200}$/),
  /** Set by the caller only for a money-moving or customer-facing matter Nick must see today; emailed at once if the webhook fails. */
  urgent_for_nick: z.enum(URGENT_FOR_NICK).optional(),
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
    if (!body.success) { res.status(400).json({ ok: false, error: 'text and idempotency_key (8-200 printable characters) are required; authority_turn and urgent_for_nick (money or customer) are optional' }); return; }
    void getLink()!.notifyJames({
      conversationId: req.agentConversationId!,
      text: body.data.text,
      authorityTurn: body.data.authority_turn,
      idempotencyKey: body.data.idempotency_key,
      urgentForNick: body.data.urgent_for_nick,
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
