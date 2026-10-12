import crypto from 'node:crypto';
import express, { type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import type Database from 'better-sqlite3';
import { getThread, listThreads, resolveThreadId, threadMessages, setFollowed, STARTED_BY, THREAD_STATUSES } from './registry.js';
import type { JamesLink } from './service.js';
import { JAMES_API_DOCS } from './docs.js';
import { idempotency } from './idempotency.js';

/**
 * James's API at /api/james on the public hostname. Its own Cloudflare Access
 * application bypasses the owner login for this path only; every request is
 * authenticated here with the bearer key whose value lives only in Doppler
 * (VENEER_JAMES_API_KEY). Only its SHA-256 is compared in memory.
 */

export const JAMES_API_KEY_NAME = 'VENEER_JAMES_API_KEY';

const sha = (value: string) => crypto.createHash('sha256').update(value).digest();

export function jamesAuth(getSecret: (name: string) => string | null) {
  const failures: number[] = [];
  return (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    while (failures.length && failures[0]! < now - 60_000) failures.shift();
    if (failures.length >= 30) { res.status(429).json({ ok: false, error: 'too_many_failed_attempts' }); return; }
    const expected = getSecret(JAMES_API_KEY_NAME);
    if (!expected) { res.status(503).json({ ok: false, error: 'james_api_not_configured' }); return; }
    const presented = /^Bearer\s+(.+)$/i.exec(req.get('authorization') ?? '')?.[1]?.trim() ?? '';
    if (!presented || !crypto.timingSafeEqual(sha(presented), sha(expected))) {
      failures.push(now);
      res.status(401).json({ ok: false, error: 'unauthorized' });
      return;
    }
    next();
  };
}

const ListQuery = z.object({
  started_by: z.enum(STARTED_BY).optional(),
  status: z.string().optional(),
  waiting_on_james: z.enum(['1', 'true']).optional(),
  waiting_on: z.enum(['james', 'veneer']).optional(),
  followed: z.enum(['0', '1', 'true', 'false']).optional(),
  james: z.enum(['1', 'true']).optional(),
  q: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});
const MessagesQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  before: z.string().datetime({ offset: true }).transform((v) => new Date(v).toISOString()).optional(),
});
const ReplyBody = z.object({ expected_turn: z.number().int().min(0), text: z.string().trim().min(1).max(20_000) });
const NewThreadBody = z.object({
  project_id: z.string().trim().min(1).nullable().optional(),
  title: z.string().trim().min(1).max(200),
  text: z.string().trim().min(1).max(20_000),
});
const BotMessageBody = z.object({ text: z.string().trim().min(1).max(20_000), expected_turn: z.number().int().min(0).optional() });
const StatusBody = z.object({ expected_turn: z.number().int().min(0).optional() }).optional();
const FollowBody = z.object({ follow: z.boolean() });
const TestBody = z.object({ thread_id: z.string().min(8), simulate_webhook_failure: z.boolean().optional() });

export function createJamesRouter(db: Database.Database, link: JamesLink, getSecret: (name: string) => string | null) {
  const router = express.Router();
  router.use(express.json({ limit: '128kb' }));
  router.use(jamesAuth(getSecret));
  router.use(idempotency(db));

  router.get('/docs', (_req, res) => { res.json(JAMES_API_DOCS); });

  router.get('/projects', (_req, res) => {
    const projects = db.prepare(
      `SELECT p.id AS project_id, p.name, p.slug, a.slug AS default_agent,
              (SELECT COUNT(*) FROM conversations c WHERE c.project_id = p.id AND c.archived = 0 AND c.side_chat_of IS NULL) AS open_threads,
              (SELECT MAX(c.last_active_at) FROM conversations c WHERE c.project_id = p.id) AS last_activity
         FROM projects p LEFT JOIN assistants a ON a.id = p.default_assistant_id AND a.deleted_at IS NULL
        ORDER BY p.sort_order IS NULL, p.sort_order, p.name COLLATE NOCASE`,
    ).all();
    res.json({ ok: true, projects });
  });

  router.post('/threads', (req, res) => {
    const body = NewThreadBody.safeParse(req.body);
    if (!body.success) { res.status(400).json({ ok: false, error: 'title and text are required; project_id is optional' }); return; }
    void link.createThread({ projectId: body.data.project_id ?? null, title: body.data.title, text: body.data.text }).then((result) => {
      if (!result.ok) { const { status, ...rest } = result; res.status(status).json(rest); return; }
      const { status_code, ...rest } = result;
      res.status(status_code).json(rest);
    }).catch((err: Error) => res.status(500).json({ ok: false, error: err.message }));
  });

  router.get('/bots', (_req, res) => { res.json({ ok: true, bots: link.bots() }); });

  router.post('/bots/:bot/message', (req, res) => {
    const body = BotMessageBody.safeParse(req.body);
    if (!body.success) { res.status(400).json({ ok: false, error: 'text is required; expected_turn is optional' }); return; }
    const id = link.resolveBot(req.params.bot);
    if (!id) { res.status(404).json({ ok: false, error: 'bot_not_found', bots: link.bots().map((b) => b.name) }); return; }
    void link.postReply(id, body.data.expected_turn, body.data.text, 'james_api_bot').then((result) => {
      if (!result.ok) { const { status, ...rest } = result; res.status(status).json(rest); return; }
      res.json(result);
    }).catch((err: Error) => res.status(500).json({ ok: false, error: err.message }));
  });

  router.get('/threads', (req, res) => {
    const query = ListQuery.safeParse(req.query);
    if (!query.success) { res.status(400).json({ ok: false, error: query.error.issues[0]?.message }); return; }
    const q = query.data;
    const waitingOn = q.waiting_on ?? (q.waiting_on_james ? 'james' : undefined);
    const statuses = waitingOn ? [`waiting_on_${waitingOn}`] : q.status?.split(',').map((s) => s.trim()).filter(Boolean);
    if (statuses?.some((s) => !THREAD_STATUSES.includes(s as never))) {
      res.status(400).json({ ok: false, error: `status must be one of ${THREAD_STATUSES.join(', ')}` });
      return;
    }
    const result = listThreads(db, {
      startedBy: q.started_by,
      statuses: statuses as never,
      followed: q.followed === undefined ? undefined : q.followed === '1' || q.followed === 'true',
      james: !!q.james,
      q: q.q,
      limit: q.limit,
      offset: q.offset,
    });
    res.json({ ok: true, total: result.total, threads: result.threads.map((t) => link.summary(t)) });
  });

  router.get('/threads/:id', (req, res) => {
    const id = resolveThreadId(db, req.params.id);
    const thread = id ? getThread(db, id) : undefined;
    if (!id || !thread) { res.status(404).json({ ok: false, error: 'thread_not_found' }); return; }
    res.json({ ok: true, thread: link.summary(thread), ...threadMessages(db, id, { limit: 20 }) });
  });

  router.get('/threads/:id/messages', (req, res) => {
    const query = MessagesQuery.safeParse(req.query);
    if (!query.success) { res.status(400).json({ ok: false, error: 'limit must be 1-100 and before an ISO timestamp' }); return; }
    const id = resolveThreadId(db, req.params.id);
    if (!id || !getThread(db, id)) { res.status(404).json({ ok: false, error: 'thread_not_found' }); return; }
    res.json({ ok: true, thread_id: id, ...threadMessages(db, id, { limit: query.data.limit, before: query.data.before }) });
  });

  router.post('/threads/:id/reply', (req, res) => {
    const body = ReplyBody.safeParse(req.body);
    if (!body.success) { res.status(400).json({ ok: false, error: 'expected_turn (integer) and text are required' }); return; }
    void link.postReply(req.params.id, body.data.expected_turn, body.data.text).then((result) => {
      if (!result.ok) { const { status, ...rest } = result; res.status(status).json(rest); return; }
      res.json(result);
    }).catch((err: Error) => res.status(500).json({ ok: false, error: err.message }));
  });

  for (const action of ['close', 'archive', 'reopen'] as const) {
    router.post(`/threads/:id/${action}`, (req, res) => {
      const body = StatusBody.safeParse(req.body && Object.keys(req.body).length ? req.body : undefined);
      if (!body.success) { res.status(400).json({ ok: false, error: 'expected_turn must be an integer' }); return; }
      void link.changeStatus(req.params.id, action, body.data?.expected_turn).then((result) => {
        if (!result.ok) { const { status, ...rest } = result; res.status(status).json(rest); return; }
        res.json(result);
      }).catch((err: Error) => res.status(500).json({ ok: false, error: err.message }));
    });
  }

  router.post('/threads/:id/follow', (req, res) => {
    const body = FollowBody.safeParse(req.body);
    const id = resolveThreadId(db, req.params.id);
    if (!body.success) { res.status(400).json({ ok: false, error: 'follow (boolean) is required' }); return; }
    if (!id || !getThread(db, id)) { res.status(404).json({ ok: false, error: 'thread_not_found' }); return; }
    setFollowed(db, id, body.data.follow);
    res.json({ ok: true, thread: link.summary(getThread(db, id)!) });
  });

  /** Push a test update for one thread now, optionally forcing the webhook-failure email path. */
  router.post('/test-push', (req, res) => {
    const body = TestBody.safeParse(req.body);
    const id = body.success ? resolveThreadId(db, body.data.thread_id) : null;
    const thread = id ? getThread(db, id) : undefined;
    if (!body.success || !id || !thread) { res.status(400).json({ ok: false, error: 'thread_id of an existing thread is required' }); return; }
    link.enqueue(id, 'test', thread.turn, { simulate_webhook_failure: !!body.data.simulate_webhook_failure });
    void link.flush().then(() => {
      const push = db.prepare('SELECT id, status, attempts, emailed_to, last_error FROM james_pushes WHERE conversation_id = ? ORDER BY id DESC LIMIT 1').get(id);
      res.json({ ok: true, push });
    }).catch((err: Error) => res.status(500).json({ ok: false, error: err.message }));
  });

  router.use((_req, res) => res.status(404).json({ ok: false, error: 'not_found' }));
  return router;
}
