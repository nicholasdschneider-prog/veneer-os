import express, { type Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { VoiceWorkspace } from '../voice/workspace.js';

export function createLiveVoiceRouter(ctx: AppContext): Router {
  const router = express.Router();
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    // Calls are interactive human sessions, never accessible through agent tokens.
    if (req.agentConversationId || req.user?.role === 'member') {
      res.status(403).json({ ok: false, error: 'Live voice requires an owner or consultant signed in directly.' }); return;
    }
    next();
  });
  router.get('/', (req, res) => {
    const workspace = new VoiceWorkspace(ctx, req.user!.id);
    res.json({ ok: true, configuration: ctx.liveVoice?.configuration() ?? { ready: false, missing: ['LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET', 'OPENAI_API_KEY'], invalidUrl: false },
      call: ctx.liveVoice?.status(req.user!.id) ?? null, blockers: workspace.blockers(), chats: workspace.chats(), history: workspace.history(80) });
  });
  router.post('/calls', (req, res) => {
    const body = z.object({ contextConversationId: z.string().min(1).max(100).optional() }).safeParse(req.body);
    if (!body.success) { res.status(400).json({ ok: false, error: 'Invalid context chat.' }); return; }
    if (!ctx.liveVoice) { res.status(503).json({ ok: false, error: 'Live voice is not available.' }); return; }
    void ctx.liveVoice.start(req.user!.id, body.data.contextConversationId)
      .then(call => res.json({ ok: true, ...call }))
      .catch((error: Error) => res.status(503).json({ ok: false, error: error.message }));
  });
  router.post('/calls/:id/heartbeat', (req, res) => {
    const call = ctx.liveVoice?.heartbeat(req.user!.id, String(req.params.id));
    if (!call) { res.status(410).json({ ok: false, error: 'Call ended. Reconnect to continue.' }); return; }
    res.json({ ok: true, call });
  });
  router.post('/calls/:id/end', (req, res) => {
    ctx.liveVoice?.end(req.user!.id, String(req.params.id));
    res.json({ ok: true });
  });
  return router;
}
