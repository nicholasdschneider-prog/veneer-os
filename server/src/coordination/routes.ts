import crypto from 'node:crypto';
import express from 'express';
import type { AppContext } from '../context.js';
import type { ConversationRow } from '../db/db.js';
import {
  canSendToConversation,
  canViewConversation,
  sameBusiness,
} from '../conversations/access.js';
import { presentConversationEventForUser } from '../conversations/messageOriginPresentation.js';
import {
  coordinationLane,
  ensureCoordination,
  type CoordinationThread,
} from './store.js';

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
  const allowed = (req: express.Request, thread: CoordinationThread) =>
    [thread.left_id, thread.right_id].every((id) => {
      const c = row(id);
      return (
        c &&
        canViewConversation(req.user!, c, db) &&
        sameBusiness(db, req.agentConversationId, c)
      );
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
          label: `${name(t.left_id)} ↔ ${name(t.right_id)}`,
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
          label: `${name(thread.left_id)} ↔ ${name(thread.right_id)}`,
          lanes,
        });
      })
      .catch(() => res.sendStatus(500));
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
  const posted = await ctx.manager.queueMessage(
    lane.conversation_id,
    text,
    req.user!.id,
    { kind: 'agent', from, to, sourceConversationId: source.id },
    requestKey ?? crypto.randomUUID(),
  );
  ctx.db
    .prepare(
      `INSERT OR IGNORE INTO agent_message_receipts(source_conversation_id,target_conversation_id,message_id,message_text,disposition) VALUES(?,?,?,?,?)`,
    )
    .run(source.id, target.id, posted.messageId, text, posted.disposition);
  return {
    ...posted,
    coordinationThreadId: thread.id,
    status: await ctx.manager.statusOf(lane.conversation_id),
  };
}
