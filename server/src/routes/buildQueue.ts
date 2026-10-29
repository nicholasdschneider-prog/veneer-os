import { BuildRecoveryInput } from '../buildQueue/recovery.js';
import express, { type Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { canManageConversation, canTrainBusinessBot, canViewConversation, sameBusiness } from '../conversations/access.js';
import { createConversationReactivator } from './conversationActivity.js';
import type { ConversationRow } from '../db/db.js';
import type { MoveBuildActor } from '../buildQueue/coordinator.js';
import { approverName, BUILD_REFUSAL, claimBuildPass, requestMayStartBuild, settleBuildPass, type BuildPassRow } from '../buildQueue/buildApproval.js';

const EnqueueSchema = z.object({
  sourceConversationId: z.string().trim().min(1).max(100),
  title: z.string().trim().min(1).max(200),
  brief: z.string().trim().min(1).max(100_000),
  // A pass an approver sent with a handoff or message to this chat.
  buildPass: z.string().trim().min(1).max(100).optional(),
});
const ResolveSchema = z.object({ action: z.enum(['retry', 'skip']) });
const MoveTargetSchema = z.union([
  z.object({ position: z.number().int().min(1) }).strict(),
  z.object({ before: z.number().int().min(1) }).strict(),
  z.object({ after: z.number().int().min(1) }).strict(),
]);
// A bot names the human direction it acts on; the UI and James do not.
const AuthorityNote = z.object({ authority_note: z.string().trim().min(1).max(500).optional() });
export const MoveSchema = z.union([
  z.object({ position: z.number().int().min(1) }).merge(AuthorityNote).strict(),
  z.object({ before: z.number().int().min(1) }).merge(AuthorityNote).strict(),
  z.object({ after: z.number().int().min(1) }).merge(AuthorityNote).strict(),
]);
const MoveTarget = (body: z.infer<typeof MoveSchema>) => {
  const { authority_note: _note, ...target } = body;
  return MoveTargetSchema.parse(target);
};
const HistoryQuery = z.object({
  scopeKey: z.string().trim().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

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
    `SELECT c.id, c.user_id, c.visibility, c.business_team_id, b.scope_key
     FROM build_queue b JOIN conversations c ON c.id = b.conversation_id
     WHERE b.id = ?`,
  );
  // Mirrors the coordinator's scopeFor: a filed chat's project queue, or the
  // Veneer source queue for an unfiled Platform Dev chat.
  const scopeOfConversation = (conversationId: string): string | null => {
    const row = ctx.db.prepare(
      'SELECT c.project_id, a.slug FROM conversations c JOIN assistants a ON a.id = c.assistant_id WHERE c.id = ?',
    ).get(conversationId) as { project_id: string | null; slug: string } | undefined;
    if (!row) return null;
    if (row.project_id) return `project:${row.project_id}`;
    return row.slug === 'platform-dev' ? 'source' : null;
  };

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
    // The chat's own approved turn needs no pass. Otherwise the chat must hold
    // an approver's pass, sent to it by the chat where the approval was given.
    let pass: BuildPassRow | undefined;
    if (!requestMayStartBuild(ctx.db, req)) {
      if (req.agentConversationId === conv.id) pass = claimBuildPass(ctx.db, conv.id, body.data.buildPass ?? null);
      if (!pass) {
        res.status(403).json({ ok: false, error: BUILD_REFUSAL });
        return;
      }
    }
    // enqueue_build is fresh activity just like a prompt. Reactivate first so
    // the coordinator's active-conversation guard can reserve the workspace.
    const buildChat = conv;
    const brief = pass
      ? `${body.data.brief}\n\nApproved by ${approverName(ctx.db, pass.approver_user_id)} with build pass ${pass.id} from chat ${pass.source_conversation_id} at ${pass.source_turn_at ?? pass.created_at} UTC: "${pass.scope_note}"`
      : body.data.brief;
    reactivateConversation(buildChat.id);
    void ctx.manager
      .enqueueBuild(buildChat.id, body.data.title, brief, req.user!.id)
      .then((result) => {
        if (pass) settleBuildPass(ctx.db, pass.id, result.ok && result.disposition !== 'existing' ? Number(result.job.id) : null);
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
          JSON.stringify({
            jobId: result.job.id, conversationId: buildChat.id, disposition: result.disposition,
            ...(pass ? { buildPass: { id: pass.id, approverUserId: pass.approver_user_id, sourceConversationId: pass.source_conversation_id, sourceTurnAt: pass.source_turn_at } } : {}),
          }),
        );
        res.status(result.disposition === 'enqueued' ? 201 : 200).json({
          ok: true,
          job: result.job,
          position: result.position,
          disposition: result.disposition,
        });
      })
      .catch((err: Error) => {
        if (pass) settleBuildPass(ctx.db, pass.id, null);
        res.status(503).json({ ok: false, error: err.message });
      });
  });

  router.post('/recover', (req,res)=>{
    const p=BuildRecoveryInput.safeParse(req.body);
    if(!p.success){res.status(400).json({error:'Exact recovery metadata required'});return;}
    const conv=queueConversation.get(p.data.job_id) as {user_id:number;visibility:'team'|'private'}|undefined;
    if(!conv||!canManageConversation(req.user!,conv,ctx.db)){res.status(404).json({error:'Build not found'});return;}
    void ctx.manager.recoverBuild(p.data,req.user!.id,req.agentConversationId??null).then(result=>res.json(result)).catch((e:Error)=>res.status(409).json({error:e.message}));
  });
  // Newest reorders first. Each entry names the build, who moved it and from
  // where to where, so the queue history explains the current order.
  router.get('/history', (req, res) => {
    const query = HistoryQuery.safeParse(req.query);
    if (!query.success) {
      res.status(400).json({ ok: false, error: 'Invalid history query' });
      return;
    }
    void ctx.manager
      .buildQueueHistory({ ...(query.data.scopeKey ? { scopeKey: query.data.scopeKey } : {}), limit: query.data.limit ?? 50 })
      .then((entries) => {
        const visible = entries.filter((entry) => {
          const conversation = queueConversation.get(entry.job_id) as
            | { user_id: number; visibility: 'team' | 'private' }
            | undefined;
          return Boolean(conversation && canViewConversation(req.user!, conversation, ctx.db));
        });
        res.json({
          ok: true,
          entries: visible.map((entry) => ({
            id: entry.id,
            jobId: entry.job_id,
            jobTitle: entry.job_title,
            jobStatus: entry.job_status,
            scopeKey: entry.scope_key,
            actorUserId: entry.actor_user_id,
            actorLabel: entry.actor_label,
            via: entry.via,
            oldPosition: entry.old_position,
            newPosition: entry.new_position,
            authorityNote: entry.authority_note,
            createdAt: entry.created_at,
          })),
        });
      })
      .catch((err: Error) => res.status(503).json({ ok: false, error: err.message }));
  });

  router.post('/:id/move', (req, res) => {
    const body = MoveSchema.safeParse(req.body);
    const jobId = Number(req.params.id);
    if (!body.success || !Number.isSafeInteger(jobId) || jobId <= 0) {
      res.status(400).json({ ok: false, error: 'Send exactly one of position, before or after' });
      return;
    }
    const conversation = queueConversation.get(jobId) as
      | { user_id: number; visibility: 'team' | 'private'; scope_key: string }
      | undefined;
    if (!conversation || !canManageConversation(req.user!, conversation, ctx.db)) {
      res.status(404).json({ ok: false, error: 'not_found' });
      return;
    }
    // A bot reorders only inside its own workspace, and only on a human
    // direction it names; the note is kept with the move in the queue history.
    let actor: MoveBuildActor;
    if (req.agentConversationId) {
      if (!body.data.authority_note) {
        res.status(400).json({ ok: false, error: 'authority_note is required: name the human direction this move follows' });
        return;
      }
      if (scopeOfConversation(req.agentConversationId) !== conversation.scope_key) {
        res.status(404).json({ ok: false, error: 'not_found' });
        return;
      }
      actor = { userId: req.user!.id, label: req.agentConversationId, via: 'bot_tool', authorityNote: body.data.authority_note };
    } else {
      actor = { userId: req.user!.id, label: req.user!.display_name || req.user!.email, via: 'ui' };
    }
    void ctx.manager
      .moveBuild(jobId, MoveTarget(body.data), actor)
      .then((result) => {
        if (!result.ok) {
          res.status(result.error === 'not_found' || result.error === 'target_not_found' ? 404 : 409).json({ ok: false, error: result.error });
          return;
        }
        res.json({
          ok: true,
          job: result.job,
          oldPosition: result.oldPosition,
          newPosition: result.newPosition,
          changed: result.changed,
          queue: result.queue.map((job, index) => ({ id: job.id, title: job.title, status: job.status, position: index + 1 })),
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
