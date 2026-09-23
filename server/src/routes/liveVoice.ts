import { listVoiceSessions } from '../voice/sessions.js';
import express, { type Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { VoiceWorkspace } from '../voice/workspace.js';

const id = z.string().min(1).max(100);
export function createLiveVoiceRouter(ctx: AppContext): Router {
  const router = express.Router();
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    // Calls are interactive human sessions, never accessible through agent tokens.
    if (req.agentConversationId) {
      res.status(403).json({ ok: false, error: 'Live voice requires a human signed in directly.' }); return;
    }
    next();
  });
  router.get('/', (req, res) => {
    const query = z.object({ bot: id.optional(), decision: id.optional() }).safeParse(req.query);
    if (!query.success) { res.status(400).json({ ok: false, error: 'Invalid bot.' }); return; }
    if (req.user?.role === 'member' && !query.data.bot) { res.status(403).json({ error: 'Open voice from an accessible conversation.' }); return; }
    const workspace = new VoiceWorkspace(ctx, req.user!.id, query.data.bot ?? null);
    let bot: ReturnType<VoiceWorkspace['bot']> | null = null;
    let decision: ReturnType<VoiceWorkspace['readDecision']> | null = null;
    if (query.data.bot) {
      try { bot = workspace.bot(); } catch { res.status(404).json({ ok: false, error: 'Bot not found.' }); return; }
      if (query.data.decision) { try { decision = workspace.readDecision(query.data.decision); } catch { decision = null; } }
    }
    res.json({ ok: true, configuration: ctx.liveVoice?.configuration() ?? { ready: false, missing: ['LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET', 'OPENAI_API_KEY'], invalidUrl: false },
      callerName: req.user!.display_name,
      call: ctx.liveVoice?.status(req.user!.id) ?? null, bot, decision, decisions: bot ? workspace.decisions() : [],
      blockers: workspace.blockers(), chats: bot ? [] : workspace.chats(), history: workspace.history(80) });
  });
  router.get('/sessions', (req, res) => {
    const q = z.object({bot:id,before_ms:z.coerce.number().int().nonnegative().optional(),before_id:id.optional()}).refine(q=>(q.before_ms===undefined)===(q.before_id===undefined)).safeParse(req.query);
    if (!q.success) { res.status(400).json({error:'A conversation is required.'}); return; }
    try { new VoiceWorkspace(ctx, req.user!.id, q.data.bot).bot(); }
    catch { res.status(404).json({error:'Conversation not found.'}); return; }
    res.json({sessions:listVoiceSessions(ctx.db, req.user!.id, q.data.bot,q.data.before_ms===undefined?undefined:{time:q.data.before_ms,id:q.data.before_id!})});
  });
  router.get('/sessions/:id', (req, res) => {
    const q = z.object({after:z.coerce.number().int().nonnegative().default(0)}).safeParse(req.query);
    if (!q.success) { res.status(400).json({error:'Invalid transcript position.'}); return; }
    const session = ctx.db.prepare('SELECT conversation_id FROM voice_sessions WHERE id=? AND user_id=?')
      .get(req.params.id, req.user!.id) as {conversation_id:string|null}|undefined;
    if (!session?.conversation_id) { res.status(404).json({error:'Voice session not found.'}); return; }
    try { new VoiceWorkspace(ctx, req.user!.id, session.conversation_id).bot(); }
    catch { res.status(404).json({error:'Conversation not found.'}); return; }
    const rows = ctx.db.prepare('SELECT id,role,text,created_at AS createdAt FROM voice_entries WHERE user_id=? AND session_id=? AND id>? ORDER BY id LIMIT 201')
      .all(req.user!.id,req.params.id,q.data.after) as {id:number;role:string;text:string;createdAt:string}[];
    res.json({entries:rows.slice(0,200),next:rows.length>200?rows[199]!.id:null});
  });
  router.post('/calls/:id/connected', (req,res) => {
    if(!ctx.liveVoice?.connected(req.user!.id,String(req.params.id))) {res.status(410).json({error:'Call ended.'});return;}
    res.json({ok:true});
  });
  router.post('/calls', (req, res) => {
    const body = z.object({ contextConversationId: id.optional(), botConversationId: id.optional(), decisionId: id.optional() }).safeParse(req.body);
    if (!body.success) { res.status(400).json({ ok: false, error: 'Invalid call request.' }); return; }
    if (req.user?.role === 'member' && !body.data.botConversationId) { res.status(403).json({ error: 'Open voice from an accessible conversation.' }); return; }
    if (!ctx.liveVoice) { res.status(503).json({ ok: false, error: 'Live voice is not available.' }); return; }
    void ctx.liveVoice.start(req.user!.id, body.data)
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
