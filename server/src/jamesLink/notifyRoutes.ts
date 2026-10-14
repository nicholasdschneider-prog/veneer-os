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
  /**
   * Set by the caller only for a money-moving or customer-facing matter Nick
   * must see today, with needs_nick_today, reason, evidence and needed_on (ET
   * date); then a failed webhook emails it at once. Never inferred.
   */
  urgent_for_nick: z.enum(URGENT_FOR_NICK).optional(),
  needs_nick_today: z.literal(true).optional(),
  reason: z.string().trim().min(1).max(500).optional(),
  evidence: z.union([z.string().trim().min(1), z.array(z.string().trim().min(1)).min(1)])
    .refine((value) => JSON.stringify(value).length <= 2000, 'evidence is longer than 2000 characters').optional(),
  needed_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
}).superRefine((body, ctx) => {
  const fields = ['needs_nick_today', 'reason', 'evidence', 'needed_on'] as const;
  for (const f of fields) {
    if (body.urgent_for_nick && body[f] === undefined) ctx.addIssue({ code: 'custom', path: [f], message: `urgent_for_nick requires ${f}` });
    if (!body.urgent_for_nick && body[f] !== undefined) ctx.addIssue({ code: 'custom', path: [f], message: `${f} is only for urgent_for_nick` });
  }
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
    if (!body.success) {
      res.status(400).json({
        ok: false,
        error: 'text and idempotency_key (8-200 printable characters) are required; authority_turn is optional; urgent_for_nick (money or customer) needs needs_nick_today true, reason, evidence and needed_on (YYYY-MM-DD)',
        detail: body.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      });
      return;
    }
    void getLink()!.notifyJames({
      conversationId: req.agentConversationId!,
      text: body.data.text,
      authorityTurn: body.data.authority_turn,
      idempotencyKey: body.data.idempotency_key,
      urgent: body.data.urgent_for_nick ? {
        kind: body.data.urgent_for_nick, needsNickToday: true, reason: body.data.reason!, evidence: body.data.evidence!, neededOn: body.data.needed_on!,
      } : undefined,
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
