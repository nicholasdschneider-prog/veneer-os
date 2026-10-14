import crypto from 'node:crypto';
import { BUILD_REFUSAL, isReplyToTechnical, isTechnicalConversation, requestMayStartBuild } from '../buildQueue/buildApproval.js';
import express from 'express';
import type { AppContext } from '../context.js';
import type { ConversationRow } from '../db/db.js';
import {
  canSendToConversation,
  canViewConversation,
  canViewCoordinationPair,
  sameBusiness,
} from '../conversations/access.js';
import { presentConversationEventForUser } from '../conversations/messageOriginPresentation.js';
import {
  coordinationLane,
  ensureCoordination,
  type CoordinationThread,
} from './store.js';
import {
  botLabel,
  botLaneConversationId,
  hasBotLane,
  botLaneOfConversation,
  botLaneOwnerOfThread,
  surfaceToHuman,
  surfacedNotice,
} from './botLane.js';

export function createCoordinationRouter(ctx: AppContext): express.Router {
  const router = express.Router();
  const db = ctx.db;
  const row = (id: string) =>
    db.prepare('SELECT * FROM conversations WHERE id=?').get(id) as
      | ConversationRow
      | undefined;
  const name = (id: string) =>
    (
      db
        .prepare(
          'SELECT a.name FROM conversations c JOIN assistants a ON a.id=c.assistant_id WHERE c.id=?',
        )
        .get(id) as { name: string } | undefined
    )?.name ?? 'Bot';
  const label = (thread: CoordinationThread) => {
    const owner = botLaneOwnerOfThread(db, thread.id);
    return owner ? `${botLabel(db, owner)} · bot lane` : `${name(thread.left_id)} ↔ ${name(thread.right_id)}`;
  };
  const allowed = (req: express.Request, thread: CoordinationThread) =>
    canViewCoordinationPair(req.user!, [thread.left_id, thread.right_id], db) &&
    [thread.left_id, thread.right_id].every((id) => {
      const c = row(id);
      return c && sameBusiness(db, req.agentConversationId, c);
    });
  router.get('/conversations/:id/coordination', (req, res) => {
    const parent = row(String(req.params.id));
    if (
      !parent ||
      !canViewConversation(req.user!, parent, db) ||
      !sameBusiness(db, req.agentConversationId, parent)
    ) {
      res.sendStatus(404);
      return;
    }
    const threads = (
      db
        .prepare(
          'SELECT * FROM coordination_threads WHERE left_id=? OR right_id=? ORDER BY created_at DESC',
        )
        .all(parent.id, parent.id) as CoordinationThread[]
    ).filter((t) => allowed(req, t));
    void Promise.all(
      threads.map(async (t) => {
        const lanes = db
          .prepare(
            'SELECT conversation_id FROM coordination_lanes WHERE thread_id=?',
          )
          .all(t.id) as { conversation_id: string }[];
        const statuses = await Promise.all(
          lanes.map((l) => ctx.manager.statusOf(l.conversation_id)),
        );
        return {
          id: t.id,
          label: label(t),
          status: statuses.includes('needs_you')
            ? 'Needs input'
            : statuses.includes('failed')
              ? 'Needs attention'
              : statuses.includes('working')
                ? 'Working'
                : db
                      .prepare(
                        'SELECT 1 FROM queued_messages q JOIN coordination_lanes l ON l.conversation_id=q.conversation_id WHERE l.thread_id=?',
                      )
                      .get(t.id)
                  ? 'Queued'
                  : '',
          active: statuses.includes('working'),
        };
      }),
    )
      .then((summaries) =>
        res.json({
          threads: summaries.filter((summary) => {
            const thread = threads.find((t) => t.id === summary.id);
            return thread && allowed(req, thread);
          }),
        }),
      )
      .catch(() => res.sendStatus(500));
  });
  router.get('/coordination/:id', (req, res) => {
    const thread = db
      .prepare('SELECT * FROM coordination_threads WHERE id=?')
      .get(req.params.id) as CoordinationThread | undefined;
    if (!thread || !allowed(req, thread)) {
      res.sendStatus(404);
      return;
    }
    const lanes = db
      .prepare(
        'SELECT conversation_id,owner_id FROM coordination_lanes WHERE thread_id=? ORDER BY rowid',
      )
      .all(thread.id) as { conversation_id: string; owner_id: string }[];
    void Promise.all(
      lanes.map(async (l) => ({
        id: l.conversation_id,
        name: name(l.owner_id),
        events: (await ctx.manager.snapshot(l.conversation_id)).map((e) =>
          presentConversationEventForUser(db, req.user!, e),
        ),
        status: await ctx.manager.statusOf(l.conversation_id),
      })),
    )
      .then((lanes) => {
        if (!allowed(req, thread)) {
          res.sendStatus(404);
          return;
        }
        res.json({
          label: label(thread),
          lanes,
        });
      })
      .catch(() => res.sendStatus(500));
  });
  router.get('/conversations/:id/bot-lane', (req, res) => {
    const parent = row(String(req.params.id));
    if (!parent || !canViewConversation(req.user!, parent, db) || !sameBusiness(db, req.agentConversationId, parent)) {
      res.sendStatus(404);
      return;
    }
    const laneConversationId = botLaneConversationId(db, parent.id) ?? null;
    res.json({
      enabled: hasBotLane(db, parent.id),
      laneConversationId,
      threadId: laneConversationId ? coordinationLane(db, laneConversationId)?.thread_id ?? null : null,
    });
  });
  /** A bot session (bot lane or coordination thread) of a registered bot shows
   * one short line in its human chat. The line links to the session; nothing
   * else from that session enters the human chat. */
  router.post('/bot-lane/surface', (req, res) => {
    const executionId = req.agentExecutionConversationId;
    const lane = executionId ? coordinationLane(db, executionId) : undefined;
    if (!lane || lane.owner_id !== req.agentConversationId) {
      res.status(400).json({ error: 'surface_to_human is only for a bot lane or coordination thread; in the human chat just answer the human' });
      return;
    }
    if (!hasBotLane(db, lane.owner_id)) {
      res.status(409).json({ error: 'Only a registered bot has a bot lane; your coordination result stays in this thread' });
      return;
    }
    const body = req.body as { summary?: unknown; kind?: unknown; request_key?: unknown };
    const summary = typeof body.summary === 'string' ? body.summary : '';
    const kind = body.kind === 'urgent' || body.kind === 'result' ? body.kind : null;
    const requestKey = typeof body.request_key === 'string' ? body.request_key.trim() : '';
    if (!summary.trim() || summary.length > 2000 || !kind || !requestKey || requestKey.length > 200) {
      res.status(400).json({ error: 'summary (one short line), kind (urgent or result) and request_key are required' });
      return;
    }
    const botLane = botLaneOfConversation(db, lane.conversation_id);
    const thread = db.prepare('SELECT left_id,right_id FROM coordination_threads WHERE id=?').get(lane.thread_id) as { left_id: string; right_id: string } | undefined;
    const peer = thread ? (thread.left_id === lane.owner_id ? thread.right_id : thread.left_id) : null;
    try {
      const { row: surfaced, duplicate } = surfaceToHuman(db, {
        ownerId: lane.owner_id,
        laneConversationId: lane.conversation_id,
        threadId: lane.thread_id,
        kind,
        sourceLabel: botLane || !peer ? 'bot lane' : botLabel(db, peer),
        summary,
        requestKey: `lane:${lane.conversation_id}:${requestKey}`,
      });
      if (!duplicate) ctx.manager.bus.emit('event', lane.owner_id, surfacedNotice(surfaced));
      res.json({ ok: true, duplicate, id: surfaced.id, shown: surfacedNotice(surfaced).message });
    } catch (err) {
      res.status(409).json({ error: (err as Error).message });
    }
  });
  return router;
}

/** Agent calls use the original executor identity, with a separately authenticated
 * execution-session id. No caller-supplied thread id can grant authority. */
export async function sendCoordination(
  ctx: AppContext,
  req: express.Request,
  target: ConversationRow,
  text: string,
) {
  const source = ctx.db
    .prepare('SELECT * FROM conversations WHERE id=?')
    .get(req.agentConversationId) as ConversationRow | undefined;
  if (
    !source ||
    !canViewConversation(req.user!, source, ctx.db) ||
    !canSendToConversation(req.user!, target, ctx.db) ||
    !sameBusiness(ctx.db, source.id, target)
  )
    throw new Error('Conversation not available');
  if (isTechnicalConversation(ctx.db, target.id) && !isTechnicalConversation(ctx.db, source.id) && !isReplyToTechnical(ctx.db, source.id, target.id) && !requestMayStartBuild(ctx.db, req))
    throw new Error(BUILD_REFUSAL);
  if (req.agentExecutionConversationId) {
    const execution = coordinationLane(
      ctx.db,
      req.agentExecutionConversationId,
    );
    if (!execution || execution.owner_id !== source.id)
      throw new Error('Invalid coordination executor');
  }
  const requestKey = req.body.request_key;
  if (
    requestKey !== undefined &&
    (typeof requestKey !== 'string' ||
      !requestKey.trim() ||
      requestKey.length > 200)
  )
    throw new Error('Invalid request_key');
  const priority = req.body.priority;
  if (priority !== undefined && priority !== 'urgent' && priority !== 'informational')
    throw new Error('priority must be informational or urgent');
  const urgent = priority === 'urgent';
  const { thread, lane } = ensureCoordination(ctx.db, source, target);
  const from = (
    ctx.db
      .prepare('SELECT name FROM assistants WHERE id=?')
      .get(source.assistant_id) as { name: string }
  ).name;
  const to = (
    ctx.db
      .prepare('SELECT name FROM assistants WHERE id=?')
      .get(target.assistant_id) as { name: string }
  ).name;
  const deliveryKey: string = requestKey ?? crypto.randomUUID();
  const posted = await ctx.manager.queueMessage(
    lane.conversation_id,
    text,
    req.user!.id,
    { kind: 'agent', from, to, sourceConversationId: source.id, ...(urgent ? { priority: 'urgent' as const } : {}) },
    deliveryKey,
  );
  ctx.db
    .prepare(
      `INSERT OR IGNORE INTO agent_message_receipts(source_conversation_id,target_conversation_id,message_id,message_text,disposition) VALUES(?,?,?,?,?)`,
    )
    .run(source.id, target.id, posted.messageId, text, posted.disposition);
  // Informational messages stay in the thread. An urgent one also shows the
  // registered bot's human one line that links to the thread.
  let surfaced = false;
  if (urgent && hasBotLane(ctx.db, target.id)) {
    const result = surfaceToHuman(ctx.db, {
      ownerId: target.id,
      laneConversationId: lane.conversation_id,
      threadId: thread.id,
      kind: 'urgent',
      sourceLabel: botLabel(ctx.db, source.id),
      summary: text,
      // Queue row ids are reused once a turn starts; the delivery key is not.
      requestKey: `message:${lane.conversation_id}:${deliveryKey}`,
    });
    if (!result.duplicate) ctx.manager.bus.emit('event', target.id, surfacedNotice(result.row));
    surfaced = true;
  }
  return {
    ...posted,
    ...(urgent ? { surfacedToHuman: surfaced } : {}),
    coordinationThreadId: thread.id,
    status: await ctx.manager.statusOf(lane.conversation_id),
  };
}
