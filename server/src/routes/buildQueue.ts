import express, { type Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { canManageConversation, canTrainBusinessBot, canViewConversation, sameBusiness } from '../conversations/access.js';
import { createConversationReactivator } from './conversationActivity.js';

const EnqueueSchema = z.object({
  sourceConversationId: z.string().trim().min(1).max(100),
  title: z.string().trim().min(1).max(200),
  brief: z.string().trim().min(1).max(100_000),
});
const ResolveSchema = z.object({ action: z.enum(['retry', 'skip']) });

export function createBuildQueueRouter(ctx: AppContext): Router {
  const router = express.Router();
  const reactivateConversation = createConversationReactivator(ctx.db);
  const conversationContext = ctx.db.prepare(
    `SELECT c.title AS conversation_title, c.project_id, c.provider,
            p.name AS project_name, a.name AS assistant_name
     FROM conversations c
     JOIN assistants a ON a.id = c.assistant_id
     LEFT JOIN projects p ON p.id = c.project_id
     WHERE c.id = ?`,
  );
  const queueConversation = ctx.db.prepare(
    `SELECT c.id, c.user_id, c.visibility, c.business_team_id
     FROM build_queue b JOIN conversations c ON c.id = b.conversation_id
     WHERE b.id = ?`,
  );

  function jobView(
    job: Awaited<ReturnType<typeof ctx.manager.listBuildQueue>>[number],
    conversationStatus: Awaited<ReturnType<typeof ctx.manager.statusOf>>,
  ): Record<string, unknown> {
    const context = conversationContext.get(job.conversation_id) as
      | {
          conversation_title: string | null;
          project_id: string | null;
          project_name: string | null;
          assistant_name: string;
          provider: string;
        }
      | undefined;
    return {
      id: job.id,
      conversationId: job.conversation_id,
      conversationTitle: context?.conversation_title ?? null,
      assistantName: context?.assistant_name ?? 'Agent',
      provider: context?.provider ?? null,
      projectId: context?.project_id ?? null,
      projectName: context?.project_name ?? null,
      scopeKey: job.scope_key,
      title: job.title,
      status: job.status,
      conversationStatus,
      error: job.error,
      createdAt: job.created_at,
      startedAt: job.started_at,
    };
  }

  router.get('/', (req, res) => {
    void ctx.manager
      .listBuildQueue()
      .then((jobs) => {
        const positions = new Map<string, number>();
        const positioned = jobs.map((job) => {
          const position = (positions.get(job.scope_key) ?? 0) + 1;
          positions.set(job.scope_key, position);
          return { job, position };
        });
        const visible = positioned.filter(({ job }) => {
          const conversation = queueConversation.get(job.id) as
            | { user_id: number; visibility: 'team' | 'private' }
            | undefined;
          return Boolean(conversation && canViewConversation(req.user!, conversation, ctx.db));
        });
        return Promise.all(visible.map(async ({ job, position }) => ({
          ...jobView(job, await ctx.manager.statusOf(job.conversation_id)),
          position,
        })));
      })
      .then((jobs) => {
        res.json({ ok: true, jobs });
      })
      .catch((err: Error) => res.status(503).json({ ok: false, error: err.message }));
  });

  router.post('/', (req, res) => {
    const body = EnqueueSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ ok: false, error: 'Invalid build queue request' });
      return;
    }
    const conv = ctx.db
      .prepare('SELECT id, user_id, visibility, business_team_id, project_id FROM conversations WHERE id = ?')
      .get(body.data.sourceConversationId) as
      | { id: string; user_id: number; visibility: 'team' | 'private'; business_team_id: string | null; project_id: string | null }
      | undefined;
    if (!conv || !sameBusiness(ctx.db, req.agentConversationId, conv) || !(canManageConversation(req.user!, conv, ctx.db) || canTrainBusinessBot(req.user!, conv, ctx.db))) {
      res.status(404).json({ ok: false, error: 'Conversation not found' });
      return;
    }
    // enqueue_build is fresh activity just like a prompt. Reactivate first so
    // the coordinator's active-conversation guard can reserve the workspace.
    reactivateConversation(conv.id);
    void ctx.manager
      .enqueueBuild(conv.id, body.data.title, body.data.brief, req.user!.id)
      .then((result) => {
        if (!result.ok) {
          res.status(result.error === 'not_queueable' ? 400 : 404).json({
            ok: false,
            error: result.error === 'not_queueable'
              ? 'This chat needs a project workspace before it can join a build queue'
              : result.error,
          });
          return;
        }
        if (conv.business_team_id) ctx.db.prepare('INSERT INTO business_audit(team_id,actor_id,actor_chat,action,payload_json) VALUES(?,?,?,?,?)').run(
          conv.business_team_id, req.user!.id, req.agentConversationId ?? null, 'build.enqueued',
          JSON.stringify({ jobId: result.job.id, conversationId: conv.id, disposition: result.disposition }),
        );
        res.status(result.disposition === 'enqueued' ? 201 : 200).json({
          ok: true,
          job: result.job,
          position: result.position,
          disposition: result.disposition,
        });
      })
      .catch((err: Error) => res.status(503).json({ ok: false, error: err.message }));
  });

  router.post('/:id/resolve', (req, res) => {
    const body = ResolveSchema.safeParse(req.body);
    const jobId = Number(req.params.id);
    if (!body.success || !Number.isSafeInteger(jobId) || jobId <= 0) {
      res.status(400).json({ ok: false, error: 'Invalid build queue action' });
      return;
    }
    const conversation = queueConversation.get(jobId) as
      | { user_id: number; visibility: 'team' | 'private' }
      | undefined;
    if (!conversation || !canManageConversation(req.user!, conversation, ctx.db)) {
      res.status(404).json({ ok: false, error: 'not_found' });
      return;
    }
    void ctx.manager
      .resolveBuild(jobId, body.data.action)
      .then((result) => {
        if (!result.ok) {
          res.status(result.error === 'not_found' ? 404 : 409).json({ ok: false, error: result.error });
          return;
        }
        res.json({ ok: true, job: result.job });
      })
      .catch((err: Error) => res.status(503).json({ ok: false, error: err.message }));
  });

  return router;
}
