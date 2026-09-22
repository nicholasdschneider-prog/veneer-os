import crypto from 'node:crypto';
import express from 'express';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { BotError } from '../bots/service.js';
import {
  canViewConversation,
  canTrainBusinessBot,
  sameBusiness,
} from '../conversations/access.js';
import type { ConversationRow } from '../db/db.js';
import {
  RoutineInput,
  routineChat,
  saveRoutine,
  acceptEvent,
} from './routines.js';
import {
  NotificationPreference,
  pushKeys,
  subscribeDevice,
} from './notifications.js';
import { searchWork } from './search.js';
import {
  templateDraft,
  saveTemplate,
  instantiateTemplate,
  templateVisible,
  type Template,
} from './templates.js';
import {
  startTeaching,
  teachingSession,
  finishTeaching,
  saveTeaching,
} from './teaching.js';
const name = z.string().trim().min(1).max(100),
  text = z.string().trim().min(1).max(20000);
export function createBotWorkflowsRouter(ctx: AppContext) {
  const router = express.Router();
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  const run =
    (
      fn: (req: express.Request, res: express.Response) => unknown,
    ): express.RequestHandler =>
    (req, res, next) => {
      Promise.resolve()
        .then(() => fn(req, res))
        .catch((e) => {
          if (e instanceof BotError)
            res.status(e.status).json({ error: e.message });
          else if (e instanceof z.ZodError)
            res
              .status(400)
              .json({ error: e.issues.map((i) => i.message).join('; ') });
          else next(e);
        });
    };
  router.get(
    '/search',
    run((req, res) => {
      const q = z.string().trim().min(2).max(200).parse(req.query.q);
      const offset = z.coerce
        .number()
        .int()
        .min(0)
        .max(10000)
        .default(0)
        .parse(req.query.offset);
      res.json(searchWork(ctx, req.user!, q, offset, req.agentConversationId));
    }),
  );
  router.get(
    '/current/routines',
    run((req, res) => {
      if (!req.agentConversationId)
        throw new BotError(400, 'Bot conversation required');
      const c = routineChat(ctx.db, req.user!, req.agentConversationId);
      res.json({
        routines: ctx.db
          .prepare('SELECT * FROM bot_routines WHERE conversation_id=?')
          .all(c.id),
      });
    }),
  );
  router.post(
    '/current/routines',
    run((req, res) => {
      if (!req.agentConversationId)
        throw new BotError(400, 'Bot conversation required');
      const p = z
        .object({ routine_id: z.string().optional(), routine: RoutineInput })
        .strict()
        .parse(req.body);
      res.json({
        routine: saveRoutine(
          ctx.db,
          req.user!,
          req.agentConversationId,
          p.routine,
          p.routine_id,
        ),
      });
    }),
  );
  // Device settings and bot configuration must come from a human session.
  router.use((req, res, next) => {
    if (req.agentConversationId) {
      res
        .status(403)
        .json({ error: 'Open bot settings to configure this feature' });
      return;
    }
    next();
  });
  const visible = (req: express.Request) => {
    const c = ctx.db
      .prepare('SELECT * FROM conversations WHERE id=?')
      .get(req.params.id) as ConversationRow | undefined;
    if (!c || !canViewConversation(req.user!, c, ctx.db))
      throw new BotError(404, 'Bot not found');
    return c;
  };
  router.get(
    '/bots/:id',
    run((req, res) => {
      const c = visible(req);
      const preference =
        ctx.db
          .prepare(
            'SELECT input,blocked,completed,quiet_start,quiet_end,timezone FROM bot_notification_preferences WHERE user_id=? AND conversation_id=?',
          )
          .get(req.user!.id, c.id) ?? null;
      const routines = ctx.db
        .prepare(
          'SELECT * FROM bot_routines WHERE conversation_id=? ORDER BY created_at DESC',
        )
        .all(c.id);
      const deliveries = ctx.db
        .prepare(
          'SELECT d.*,w.status,w.scheduled_for FROM bot_routine_deliveries d JOIN bot_routines r ON r.id=d.routine_id JOIN conversation_wakeups w ON w.id=d.wakeup_id WHERE r.conversation_id=? ORDER BY d.created_at DESC LIMIT 30',
        )
        .all(c.id);
      const teaching =
        ctx.db
          .prepare(
            "SELECT * FROM bot_teaching_sessions WHERE conversation_id=? AND user_id=? AND state<>'discarded' ORDER BY started_at DESC LIMIT 1",
          )
          .get(c.id, req.user!.id) ?? null;
      let canManage = false;
      try {
        routineChat(ctx.db, req.user!, c.id, true);
        canManage = true;
      } catch {}
      const sources = ctx.db
        .prepare(
          'SELECT id,name,enabled,last_event_at FROM bot_event_sources WHERE team_id=?',
        )
        .all(c.business_team_id ?? '');
      res.json({
        preference,
        routines,
        deliveries,
        teaching,
        sources,
        canManage,
        canTeach: canManage || canTrainBusinessBot(req.user!, c, ctx.db),
      });
    }),
  );
  router.put(
    '/bots/:id/notifications',
    run((req, res) => {
      const c = visible(req),
        p = NotificationPreference.parse(req.body);
      ctx.db
        .prepare(
          `INSERT INTO bot_notification_preferences(user_id,conversation_id,input,blocked,completed,quiet_start,quiet_end,timezone) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(user_id,conversation_id) DO UPDATE SET input=excluded.input,blocked=excluded.blocked,completed=excluded.completed,quiet_start=excluded.quiet_start,quiet_end=excluded.quiet_end,timezone=excluded.timezone`,
        )
        .run(
          req.user!.id,
          c.id,
          Number(p.input),
          Number(p.blocked),
          Number(p.completed),
          p.quiet_start,
          p.quiet_end,
          p.timezone,
        );
      res.json({ ok: true });
    }),
  );
  router.get(
    '/push',
    run((req, res) =>
      res.json({
        publicKey: pushKeys(ctx).publicKey,
        devices: ctx.db
          .prepare('SELECT id,created_at FROM bot_push_devices WHERE user_id=?')
          .all(req.user!.id),
      }),
    ),
  );
  router.post(
    '/push',
    run((req, res) =>
      res.json({ id: subscribeDevice(ctx, req.user!, req.body) }),
    ),
  );
  router.delete(
    '/push/:id',
    run((req, res) => {
      const r = ctx.db
        .prepare('DELETE FROM bot_push_devices WHERE id=? AND user_id=?')
        .run(req.params.id, req.user!.id);
      if (r.changes)
        ctx.secrets.clearApiKeyOverride(`bot-push-device-${req.params.id}`);
      res.json({ ok: true });
    }),
  );
  router.post(
    '/bots/:id/routines',
    run((req, res) =>
      res.json({
        routine: saveRoutine(ctx.db, req.user!, req.params.id!, req.body),
      }),
    ),
  );
  router.put(
    '/bots/:id/routines/:routine',
    run((req, res) => {
      if (
        !ctx.db
          .prepare(
            'SELECT 1 FROM bot_routines WHERE id=? AND conversation_id=?',
          )
          .get(req.params.routine, req.params.id)
      )
        throw new BotError(404, 'Routine not found');
      res.json({
        routine: saveRoutine(
          ctx.db,
          req.user!,
          req.params.id!,
          req.body,
          req.params.routine!,
        ),
      });
    }),
  );
  router.post(
    '/bots/:id/sources',
    run((req, res) => {
      const c = routineChat(ctx.db, req.user!, req.params.id!, true);
      if (!c.business_team_id)
        throw new BotError(400, 'Event sources require a business');
      const p = z.object({ name }).strict().parse(req.body),
        id = crypto.randomUUID();
      ctx.secrets.setApiKeyOverride(
        `bot-event-source-${id}`,
        crypto.randomBytes(32).toString('base64url'),
      );
      ctx.db
        .prepare(
          'INSERT INTO bot_event_sources(id,team_id,created_by,name) VALUES(?,?,?,?)',
        )
        .run(id, c.business_team_id, req.user!.id, p.name);
      res.json({ id, path: `/webhooks/bot-events/${id}`, configured: false });
    }),
  );
  router.delete(
    '/bots/:id/sources/:source',
    run((req, res) => {
      const c = routineChat(ctx.db, req.user!, req.params.id!, true);
      const result = ctx.db
        .prepare(
          'UPDATE bot_event_sources SET enabled=0 WHERE id=? AND team_id=?',
        )
        .run(req.params.source, c.business_team_id ?? '');
      if (!result.changes) throw new BotError(404, 'Source not found');
      ctx.secrets.clearApiKeyOverride(`bot-event-source-${req.params.source}`);
      ctx.db
        .prepare(
          `UPDATE conversation_wakeups SET status='cancelled' WHERE status='pending' AND id IN (SELECT d.wakeup_id FROM bot_routine_deliveries d JOIN bot_routines r ON r.id=d.routine_id WHERE r.source=?)`,
        )
        .run(req.params.source);
      res.json({ ok: true });
    }),
  );
  router.get(
    '/bots/:id/template',
    run((req, res) =>
      res.json({ config: templateDraft(ctx, req.user!, req.params.id!) }),
    ),
  );
  router.post(
    '/bots/:id/templates',
    run((req, res) => {
      const p = z
        .object({ name, config: z.unknown() })
        .strict()
        .parse(req.body);
      res.json({
        id: saveTemplate(ctx, req.user!, req.params.id!, p.name, p.config),
      });
    }),
  );
  router.get(
    '/templates',
    run((req, res) =>
      res.json({
        templates: (
          ctx.db
            .prepare('SELECT * FROM bot_templates ORDER BY created_at DESC')
            .all() as Template[]
        )
          .filter((t) => templateVisible(ctx, req.user!, t))
          .map((t) => ({
            ...t,
            config: JSON.parse(t.config_json),
            config_json: undefined,
          })),
      }),
    ),
  );
  router.post(
    '/templates/:template/instantiate',
    run((req, res) => {
      const t = ctx.db
        .prepare('SELECT * FROM bot_templates WHERE id=?')
        .get(req.params.template) as Template | undefined;
      if (!t) throw new BotError(404, 'Template unavailable');
      const p = z.object({ name, scope: text }).strict().parse(req.body);
      res.json({
        conversationId: instantiateTemplate(ctx, req.user!, t, p.name, p.scope),
      });
    }),
  );
  router.post(
    '/bots/:id/teach',
    run(async (req, res) => {
      visible(req);
      if ((await ctx.manager.statusOf(req.params.id!)) === 'working')
        throw new BotError(
          409,
          'Stop the bot’s current work before demonstrating a task in its browser',
        );
      const p = z.object({ name, outcome: text }).strict().parse(req.body);
      await ctx.manager.veneerBrowserConversationTicket(
        req.user!.id,
        req.params.id!,
      );
      res.json({
        session: startTeaching(
          ctx,
          req.user!,
          req.params.id!,
          p.name,
          p.outcome,
        ),
      });
    }),
  );
  router.post(
    '/teaching/:session/:action',
    run(async (req, res) => {
      const t = teachingSession(ctx, req.user!, req.params.session!),
        action = req.params.action;
      if (action === 'stop') {
        res.json({ session: finishTeaching(ctx, req.user!, t.id) });
        return;
      }
      if (action === 'pause' || action === 'resume') {
        if (
          !['recording', 'paused'].includes(t.state) ||
          Date.parse(t.expires_at) <= Date.now()
        )
          throw new BotError(409, 'Recording ended; review the draft');
        ctx.db
          .prepare('UPDATE bot_teaching_sessions SET state=? WHERE id=?')
          .run(action === 'pause' ? 'paused' : 'recording', t.id);
      } else if (action === 'discard')
        ctx.db
          .prepare(
            "UPDATE bot_teaching_sessions SET state='discarded',steps_json='[]',draft='' WHERE id=?",
          )
          .run(t.id);
      else if (action === 'save') {
        const p = z
          .object({
            skillName: z
              .string()
              .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
              .max(64),
            draft: text,
          })
          .strict()
          .parse(req.body);
        saveTeaching(ctx, req.user!, t.id, p.skillName, p.draft);
      } else if (action === 'test') {
        if (t.state !== 'saved')
          throw new BotError(409, 'Save the reviewed skill first');
        const p = z.object({ example: text }).strict().parse(req.body);
        await ctx.manager.postMessage(
          t.conversation_id,
          `Test the skill ${JSON.stringify(t.skill_name)} on this second example: ${p.example}\nValidate against the expected outcome. Existing permissions and approval rules apply. Do not create or enable a routine as part of this test.`,
          req.user!.id,
        );
        ctx.db
          .prepare(
            'UPDATE bot_teaching_sessions SET test_requested_at=? WHERE id=?',
          )
          .run(new Date().toISOString(), t.id);
      } else throw new BotError(400, 'Unknown teaching action');
      res.json({ session: teachingSession(ctx, req.user!, t.id) });
    }),
  );
  return router;
}
export function createBotEventsWebhook(ctx: AppContext) {
  const router = express.Router();
  router.post(
    '/:source',
    express.raw({ type: 'application/json', limit: '16kb' }),
    (req, res) => {
      const raw = Buffer.isBuffer(req.body) ? req.body : null,
        stamp = String(req.headers['x-veneer-timestamp'] ?? ''),
        signature = String(req.headers['x-veneer-signature'] ?? '');
      if (
        !raw ||
        !/^\d{10}$/.test(stamp) ||
        Math.abs(Date.now() / 1000 - Number(stamp)) > 300 ||
        !/^[a-f0-9]{64}$/.test(signature)
      ) {
        res.sendStatus(401);
        return;
      }
      const key = ctx.secrets.getApiKeyOverride(
        `bot-event-source-${req.params.source}`,
      );
      if (!key) {
        res.sendStatus(401);
        return;
      }
      const expected = crypto
        .createHmac('sha256', key)
        .update(stamp + '.')
        .update(raw)
        .digest();
      if (!crypto.timingSafeEqual(expected, Buffer.from(signature, 'hex'))) {
        res.sendStatus(401);
        return;
      }
      try {
        const queued = acceptEvent(
          ctx.db,
          req.params.source!,
          JSON.parse(raw.toString('utf8')),
        );
        ctx.db
          .prepare('UPDATE bot_event_sources SET last_event_at=? WHERE id=?')
          .run(new Date().toISOString(), req.params.source);
        res.json({ ok: true, queued });
      } catch (e) {
        res
          .status(e instanceof BotError ? e.status : 400)
          .json({ error: 'Event rejected' });
      }
    },
  );
  return router;
}
