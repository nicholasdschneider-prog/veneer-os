import express, { type Router } from 'express';
import type { AppContext } from '../context.js';
import { readActivity } from '../desktopActivity.js';

export function createDesktopRouter(_ctx: AppContext): Router {
  const router = express.Router();

  router.use((req, res, next) => {
    if (req.user!.role === 'member') {
      res.status(403).json({ ok: false, error: 'Administrator access required' });
      return;
    }
    next();
  });

  // When an agent last drove the shared desktop, so the SPA can auto-pop its
  // live-view thumbnail. null when no heartbeat has been recorded.
  router.get('/activity', (_req, res) => {
    const activity = readActivity();
    res.json({ ok: true, activeAt: activity?.lastAt ?? null, conversationId: activity?.conversationId ?? null });
  });

  return router;
}
