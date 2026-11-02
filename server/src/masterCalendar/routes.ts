import express from 'express';
import { ZodError } from 'zod';
import { CalendarToolError } from './google.js';
import { CalendarInputError, type MasterCalendar } from './service.js';

/** The signed-in person's own calendars. Agent sessions never reach this surface. */
export function createMasterCalendarRouter(calendar: MasterCalendar) {
  const router = express.Router();
  router.use(express.json({ limit: '64kb' }));
  router.use((req, res, next) => {
    res.set('Cache-Control', 'private, no-cache');
    if (req.agentConversationId || !req.user || req.user.status !== 'active') {
      res.status(403).json({ error: 'Sign in to use your calendar.' });
      return;
    }
    next();
  });
  const run =
    (fn: (req: express.Request, res: express.Response) => Promise<unknown> | unknown) =>
    async (req: express.Request, res: express.Response) => {
      try {
        const result = await fn(req, res);
        if (!res.headersSent) res.json(result);
      } catch (e) {
        if (e instanceof ZodError) res.status(400).json({ error: e.issues[0]?.message ?? 'Invalid request.' });
        else if (e instanceof CalendarInputError) res.status(400).json({ error: e.message });
        else if (e instanceof CalendarToolError)
          res.status(502).json({
            error: e.uncertain ? `${e.message} The change may or may not have been saved. Check the calendar before trying again.` : e.message,
            uncertain: e.uncertain,
          });
        else res.status(500).json({ error: 'Calendar request failed.' });
      }
    };
  const uid = (req: express.Request) => req.user!.id;
  const eventPath = '/events/:connectorId/:calendarId/:eventId';
  const ids = (req: express.Request) => {
    const connectorId = Number(req.params.connectorId);
    if (!Number.isInteger(connectorId) || connectorId <= 0) throw new CalendarInputError('Unknown calendar account.');
    return [connectorId, String(req.params.calendarId), String(req.params.eventId)] as const;
  };

  router.get('/settings', run((req) => calendar.settings(uid(req))));
  router.put('/settings', run((req) => calendar.updateSettings(uid(req), req.body)));
  router.get('/accounts', run(async (req) => ({ accounts: await calendar.accounts(uid(req)) })));
  router.get(
    '/events',
    run((req) => {
      const from = Date.parse(String(req.query.from ?? ''));
      const to = Date.parse(String(req.query.to ?? ''));
      if (!Number.isFinite(from) || !Number.isFinite(to)) throw new CalendarInputError('Choose a date range.');
      return calendar.events(uid(req), from, to, req.query.fresh === '1');
    }),
  );
  router.get('/upcoming', run((req) => calendar.upcoming(uid(req), req.query.fresh === '1')));
  router.post('/events', run(async (req) => ({ event: await calendar.create(uid(req), req.body) })));
  router.patch(eventPath, run(async (req) => ({ event: await calendar.update(uid(req), ...ids(req), req.body) })));
  router.post(`${eventPath}/rsvp`, run(async (req) => ({ event: await calendar.respond(uid(req), ...ids(req), req.body) })));
  router.delete(eventPath, run((req) => calendar.remove(uid(req), ...ids(req), req.query.notify === '1')));
  router.put('/event-lead', run((req) => (calendar.setEventLead(uid(req), req.body), { ok: true })));
  router.post('/reminders', run((req) => calendar.setReminderState(uid(req), req.body)));
  return router;
}
