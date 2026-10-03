import crypto from 'node:crypto';
import { BuildRecoveryInput } from '../buildQueue/recovery.js';
import express, { type Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { canManageConversation, canTrainBusinessBot, canViewConversation, sameBusiness } from '../conversations/access.js';
import { createConversationReactivator } from './conversationActivity.js';
import { coordinationLane } from '../coordination/store.js';
import { ensureConversationInstructionSnapshot } from '../instructions/context.js';
import type { ConversationRow } from '../db/db.js';

const EnqueueSchema = z.object({
  sourceConversationId: z.string().trim().min(1).max(100),
  title: z.string().trim().min(1).max(200),
  brief: z.string().trim().min(1).max(100_000),
  // Only read when another bot's coordination message prompted the build.
  continuesThisChat: z.boolean().optional(),
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

  /** A build that another bot asked for through coordination is not something
   * the human in the receiving chat asked for there. Unless the receiving
   * agent says it continues that chat's own work, it gets a chat of its own,
   * so unrelated work never lands in an existing human thread. A registered
   * bot keeps its one standing chat: its identity and approvals live there. */
  function requesterOfCoordinatedBuild(req: express.Request, ownerId: string): ConversationRow | null {
    if (!req.agentExecutionConversationId) return null;
    const lane = coordinationLane(ctx.db, req.agentExecutionConversationId);
    if (!lane || lane.owner_id !== ownerId) return null;
    if (ctx.db.prepare('SELECT 1 FROM bot_registrations WHERE conversation_id=? AND active=1').get(ownerId)) return null;
    const thread = ctx.db.prepare('SELECT left_id,right_id FROM coordination_threads WHERE id=?').get(lane.thread_id) as
      | { left_id: string; right_id: string }
      | undefined;
    if (!thread) return null;
    const requesterId = thread.left_id === ownerId ? thread.right_id : thread.left_id;
    return (ctx.db.prepare('SELECT * FROM conversations WHERE id=?').get(requesterId) as ConversationRow | undefined) ?? null;
  }

  function createBuildChat(owner: ConversationRow, requester: ConversationRow, title: string): ConversationRow {
    const id = crypto.randomUUID();
    ctx.db.transaction(() => {
      ctx.db.prepare(
        `INSERT INTO conversations
           (id, assistant_id, user_id, visibility, project_id, title, provider, model, effort, approval_mode, native_session_id, channel, origin_conversation_id, business_team_id, last_user_activity_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'web', ?, ?, datetime('now'))`,
      ).run(
        id, owner.assistant_id, owner.user_id, owner.visibility, owner.project_id, title.slice(0, 120),
        owner.provider, owner.model, owner.effort, owner.approval_mode ?? null, crypto.randomUUID(),
        requester.id, owner.business_team_id ?? null,
      );
      ensureConversationInstructionSnapshot(ctx.db, id);
    })();
    return ctx.db.prepare('SELECT * FROM conversations WHERE id=?').get(id) as ConversationRow;
  }

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
      .prepare('SELECT * FROM conversations WHERE id = ?')
      .get(body.data.sourceConversationId) as ConversationRow | undefined;
    if (!conv || !sameBusiness(ctx.db, req.agentConversationId, conv) || !(canManageConversation(req.user!, conv, ctx.db) || canTrainBusinessBot(req.user!, conv, ctx.db))) {
      res.status(404).json({ ok: false, error: 'Conversation not found' });
      return;
    }
    // enqueue_build is fresh activity just like a prompt. Reactivate first so
    // the coordinator's active-conversation guard can reserve the workspace.
    const requester = body.data.continuesThisChat ? null : requesterOfCoordinatedBuild(req, conv.id);
    const buildChat = requester ? createBuildChat(conv, requester, body.data.title) : conv;
    const brief = requester
      ? `[Requested by another chat] Chat ${requester.id} “${requester.title ?? 'Untitled'}” asked for this build through coordination with chat ${conv.id} “${conv.title ?? 'Untitled'}”. It runs here, in its own chat, so it stays out of that chat's human thread. Call read_conversation("${requester.id}") for the context behind the request, and report the result to that chat with send_message.\n\n${body.data.brief}`
      : body.data.brief;
    reactivateConversation(buildChat.id);
    void ctx.manager
      .enqueueBuild(buildChat.id, body.data.title, brief, req.user!.id)
      .then((result) => {
        if (!result.ok) {
          // Never leave behind an empty chat that no build will ever start.
          if (requester) ctx.db.prepare('DELETE FROM conversations WHERE id=?').run(buildChat.id);
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
          JSON.stringify({ jobId: result.job.id, conversationId: buildChat.id, disposition: result.disposition }),
        );
        res.status(result.disposition === 'enqueued' ? 201 : 200).json({
          ok: true,
          job: result.job,
          position: result.position,
          disposition: result.disposition,
          ...(requester ? { buildConversation: { id: buildChat.id, title: buildChat.title } } : {}),
        });
      })
      .catch((err: Error) => res.status(503).json({ ok: false, error: err.message }));
  });

  router.post('/recover', (req,res)=>{
    const p=BuildRecoveryInput.safeParse(req.body);
    if(!p.success){res.status(400).json({error:'Exact recovery metadata required'});return;}
    const conv=queueConversation.get(p.data.job_id) as {user_id:number;visibility:'team'|'private'}|undefined;
    if(!conv||!canManageConversation(req.user!,conv,ctx.db)){res.status(404).json({error:'Build not found'});return;}
    void ctx.manager.recoverBuild(p.data,req.user!.id,req.agentConversationId??null).then(result=>res.json(result)).catch((e:Error)=>res.status(409).json({error:e.message}));
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
