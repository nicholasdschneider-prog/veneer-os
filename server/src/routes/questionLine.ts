import express from 'express';
import type { AppContext } from '../context.js';
import { questionLine } from '../bots/questionLine.js';
export function createQuestionLineRouter(ctx: AppContext) {
  const router = express.Router();
  router.use((req,res,next) => { res.set('Cache-Control','no-store'); if (req.agentConversationId) { res.status(403).json({error:'Human session required.'}); return; } next(); });
  router.get('/', (req,res) => { res.json(questionLine(ctx,req.user!).snapshot()); });
  router.post('/', (req,res) => { try { res.json(questionLine(ctx,req.user!).mutate(req.body)); } catch(e) { res.status(409).json({error:e instanceof Error ? e.message : 'Could not update question line.'}); } });
  return router;
}
