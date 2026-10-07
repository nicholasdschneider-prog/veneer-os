import express from 'express';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { botCalls, startPhoneCall } from '../bots/botCalls.js';
import { archerOwner, ARCHER_CHAT } from '../bots/outboundCalls.js';

const decision = z.object({ decisionId: z.string().min(1).max(200) }).strict();
/** Personal ring state and call preferences. Nothing here answers or changes a decision. */
export function createBotCallsRouter(ctx: AppContext) {
  const router = express.Router();
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (req.agentConversationId) { res.status(403).json({ error: 'Human session required.' }); return; }
    next();
  });
  const run = (handler: (req: express.Request) => unknown): express.RequestHandler => (req, res) => {
    try { res.json(handler(req)); }
    catch (e) { res.status(e instanceof z.ZodError ? 400 : 409).json({ error: e instanceof z.ZodError ? 'Invalid request.' : e instanceof Error ? e.message : 'Could not update calls.' }); }
  };
  router.get('/settings', run(req => botCalls(ctx, req.user!).settings()));
  router.post('/settings', run(req => botCalls(ctx, req.user!).update(req.body)));
  router.get('/outbound-policy', run(req => {
    archerOwner(ctx,req.user!);
    return {conversationId:ARCHER_CHAT, enabled:!!(ctx.db.prepare('SELECT enabled FROM bot_outbound_policy WHERE user_id=? AND conversation_id=?').get(req.user!.id,ARCHER_CHAT) as {enabled:number}|undefined)?.enabled};
  }));
  router.post('/outbound-policy', run(req => {
    archerOwner(ctx,req.user!); const {enabled}=z.object({enabled:z.boolean()}).strict().parse(req.body);
    ctx.db.prepare('INSERT INTO bot_outbound_policy VALUES(?,?,?) ON CONFLICT(user_id,conversation_id) DO UPDATE SET enabled=excluded.enabled').run(req.user!.id,ARCHER_CHAT,Number(enabled));
    return {enabled,conversationId:ARCHER_CHAT, note:'Archer can call about his authorized work. Calls remain normal conversations; they grant no business approval.'};
  }));
  router.post('/poll', run(req => botCalls(ctx, req.user!).poll(z.object({ active: z.boolean() }).strict().parse(req.body).active)));
  router.post('/answer', run(req => botCalls(ctx, req.user!).answer(decision.parse(req.body).decisionId)));
  router.post('/decline', run(req => { botCalls(ctx, req.user!).decline(decision.parse(req.body).decisionId); return { ok: true }; }));
  router.post('/ring', run(req => ({ ring: botCalls(ctx, req.user!).ring(decision.parse(req.body).decisionId) })));
  // The person asked to be phoned now, to try it out. Counts toward the hourly cap.
  router.post('/test-phone', (req, res) => {
    let call;
    try { call = botCalls(ctx, req.user!).testPhone(); }
    catch (e) { res.status(409).json({ error: e instanceof Error ? e.message : 'Could not start the call.' }); return; }
    void startPhoneCall(ctx, call).then((ok) => ok ? res.json({ ok: true }) : res.status(502).json({ error: 'The call was not confirmed. An uncertain phone attempt must be reconciled before another call.' }));
  });
  return router;
}
