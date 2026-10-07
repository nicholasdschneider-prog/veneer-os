import express from 'express';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { prepareReminder, NICK_ACCOUNTS } from '../calendarReminders/service.js';

/** Human Nick owner-only preparation. No enable, test-call, dispatch or token-input route. */
export function createCalendarRemindersRouter(ctx: AppContext) {
  const router = express.Router();
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (req.agentConversationId || !req.user || req.user.role !== 'owner' || req.user.status !== 'active' || !NICK_ACCOUNTS.some(a => a === req.user!.email.toLowerCase())) {
      res.status(403).json({ error: 'Nick owner session required.' }); return;
    }
    next();
  });
  router.get('/settings', (req, res) => {
    const prepared = ctx.db.prepare('SELECT manifest_hash,prepared_ms FROM calendar_phone_settings WHERE user_id=?').get(req.user!.id) ?? null;
    res.json({ prepared, enabled: false, ready: false, execute: false, status: 'staged',
      blockers: ['DEPLOYMENT_NOT_AUTHORIZED', 'OWNER_SOURCE_CUSTODY_UNBOUND', 'SHARED_PHONE_SERIALIZATION_UNACCEPTED', 'WORKER_NOT_REGISTERED'] });
  });
  router.post('/prepare', (req, res) => {
    try { res.json(prepareReminder(ctx.db, req.user!, req.body)); }
    catch (e) { res.status(e instanceof z.ZodError ? 400 : 409).json({ error: e instanceof z.ZodError ? 'Invalid disabled reminder manifest.' : 'Reminder preparation refused.' }); }
  });
  router.post('/enable', (_req, res) => { res.status(409).json({ enabled: false, ready: false, execute: false, error: 'Staged only. Deployment and accepted source/phone integration required.' }); });
  return router;
}
