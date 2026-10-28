import express from 'express';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import type { ConversationRow } from '../db/db.js';
import { canViewConversation, canViewCoordinationPair } from '../conversations/access.js';
import { BotError, createBotService } from '../bots/service.js';
import { botLabel, botLaneOwnerOfThread } from '../coordination/botLane.js';
import type { CoordinationThread } from '../coordination/store.js';
import { createTaskService, type TaskActor } from './service.js';

/**
 * The CHAT | TASKS board for any bot chat, plus the bot tools behind it.
 * The board is a read over existing sources: the bot's tasks, its own open
 * questions, coordination threads, handed-off chats, mirrored tickets, and
 * (chief of staff only) other bots' questions. Status comes from source state.
 */
export type BoardGroup = 'ready_for_review' | 'needs_input' | 'working' | 'up_next' | 'completed';
export interface BoardRow {
  kind: 'task' | 'decision' | 'question' | 'thread' | 'handoff' | 'ticket';
  id: string;
  group: BoardGroup;
  title: string;
  status_line: string;
  tag: string;
  href: string;
  updated_at: string;
  can_mark: boolean;
  task?: ReturnType<typeof import('./service.js').present> & { open_decision: { id: string; version: number; question: string } | null; thread_id: string | null };
  decision_id?: string;
}
const GROUPS: BoardGroup[] = ['ready_for_review', 'needs_input', 'working', 'up_next', 'completed'];

export function createTasksRouter(ctx: AppContext) {
  const router = express.Router();
  const db = ctx.db;
  const tasks = createTaskService(db);
  const bots = createBotService(db);
  router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  const run = (fn: (req: express.Request, res: express.Response) => unknown) => (req: express.Request, res: express.Response, next: express.NextFunction) => {
    Promise.resolve().then(() => fn(req, res)).catch((e) => {
      if (e instanceof BotError) res.status(e.status).json({ error: e.message });
      else if (e instanceof z.ZodError) res.status(400).json({ error: e.issues.map((x) => `${x.path.join('.')}: ${x.message}`).join('; ') });
      else next(e);
    });
  };
  const actor = (req: express.Request): TaskActor => ({ user: req.user!, conversationId: req.agentConversationId, executionConversationId: req.agentExecutionConversationId });
  const conversation = (id: string) => db.prepare('SELECT * FROM conversations WHERE id=?').get(id) as ConversationRow | undefined;
  const visibleChat = (req: express.Request, id: string): ConversationRow => {
    const c = conversation(id);
    if (!c || !canViewConversation(req.user!, c, db)) throw new BotError(404, 'Chat not found');
    return c;
  };
  const agentName = (id: string) => (db.prepare('SELECT a.name FROM conversations c JOIN assistants a ON a.id=c.assistant_id WHERE c.id=?').get(id) as { name: string } | undefined)?.name ?? 'Bot';

  router.get('/conversations/:id/tasks', run(async (req, res) => {
    if (req.agentConversationId) throw new BotError(403, 'The board is a human view');
    const chat = visibleChat(req, req.params.id!);
    const user = req.user!;
    const marks = tasks.marks(chat.id);
    const rows: BoardRow[] = [];
    // 1. The bot's own tasks.
    for (const t of tasks.listForOwner(chat.id)) {
      const group: BoardGroup = t.status === 'done' ? 'completed' : t.status;
      rows.push({ kind: 'task', id: t.id, group, title: t.title, status_line: t.status_line, tag: t.case_key ? `case ${t.case_key}` : t.source.replace('_', ' '), updated_at: t.updated_at,
        // The task chat is read in the owner chat's side panel (it renders a lane's transcript); a lane page on its own is blank.
        // A task opens in the board's own pane (status, question card, the task chat's transcript, composer); never the bare lane page.
        href: `#/chat/${chat.id}?view=tasks&task=${t.id}`,
        can_mark: group !== 'completed', task: t, ...(t.open_decision ? { decision_id: t.open_decision.id } : {}) });
    }
    // 2. The bot's own open questions not bound to a task.
    const boundIds = new Set((db.prepare('SELECT id FROM bot_decisions WHERE conversation_id=? AND task_id IS NOT NULL').all(chat.id) as { id: string }[]).map((r) => r.id));
    let ownDecisions: ReturnType<typeof bots.list> = [];
    try { ownDecisions = bots.list({ user }, 'all', chat.id); } catch { ownDecisions = []; }
    for (const d of ownDecisions) {
      if (d.state !== 'needs_input' || boundIds.has(d.id) || d.stale?.resolved) continue;
      rows.push({ kind: 'decision', id: d.id, group: 'needs_input', title: d.proposal.review_summary?.action_title || d.proposal.question, status_line: d.stale ? 'Being refreshed by the bot' : (d.proposal.review_summary?.request || 'Waiting for your answer'), tag: d.bot_name, updated_at: d.updated_at, href: `#/chat/${chat.id}?side=decision:${d.id}`, can_mark: false, decision_id: d.id });
    }
    // 3. Chief of staff only: other bots' open questions across businesses (existing check inside openQuestions).
    try {
      const q = bots.openQuestions({ user, conversationId: chat.id }) as { questions: { decision_id: string; bot: { name: string }; business: { name: string } | null; question: string; recommendation?: string; review_summary?: { action_title?: string } | null; updated_at: string }[] };
      for (const item of q.questions) rows.push({ kind: 'question', id: item.decision_id, group: 'needs_input', title: item.review_summary?.action_title || item.question, status_line: item.recommendation ? `Recommended: ${item.recommendation}` : 'Waiting for your answer', tag: [item.bot.name, item.business?.name].filter(Boolean).join(' · '), updated_at: item.updated_at, href: `#/bots/${item.decision_id}`, can_mark: false, decision_id: item.decision_id });
    } catch { /* not the chief of staff */ }
    // 4. Coordination threads (excluding task and ticket lanes, which already appear above).
    // Only live work shows under Active: a lane that needs an answer, failed, is working or is queued.
    // Finished bot-to-bot traffic (e.g. the half-hour CS queue trigger) is never "Ready for review";
    // the most recent finished threads are reachable under Completed only.
    const laneChats = new Set([
      ...(db.prepare('SELECT task_conversation_id AS id FROM bot_tasks WHERE owner_conversation_id=? AND task_conversation_id IS NOT NULL').all(chat.id) as { id: string }[]).map((r) => r.id),
      ...(db.prepare('SELECT ticket_conversation_id AS id FROM cs_tickets WHERE owner_conversation_id=? AND ticket_conversation_id IS NOT NULL').all(chat.id) as { id: string }[]).map((r) => r.id),
    ]);
    const isAutomation = (id: string) => { const c = conversation(id); return Boolean(c && (c.channel === 'automation' || db.prepare('SELECT 1 FROM scheduled_task_runs WHERE conversation_id=? LIMIT 1').get(id))); };
    const threads = (db.prepare('SELECT * FROM coordination_threads WHERE left_id=? OR right_id=? ORDER BY created_at DESC LIMIT 400').all(chat.id, chat.id) as CoordinationThread[])
      .filter((t) => !laneChats.has(t.left_id) && !laneChats.has(t.right_id) && canViewCoordinationPair(user, [t.left_id, t.right_id], db));
    let finishedThreads = 0, threadRows = 0;
    for (const t of threads) {
      if (threadRows >= 50) break;
      const lanes = (db.prepare('SELECT conversation_id FROM coordination_lanes WHERE thread_id=?').all(t.id) as { conversation_id: string }[]).map((l) => l.conversation_id);
      const statuses = await Promise.all(lanes.map((id) => ctx.manager.statusOf(id).catch(() => 'idle' as const)));
      const queued = Boolean(db.prepare('SELECT 1 FROM queued_messages q JOIN coordination_lanes l ON l.conversation_id=q.conversation_id WHERE l.thread_id=?').get(t.id));
      const mark = marks.get(`thread:${t.id}`);
      const laneOwner = botLaneOwnerOfThread(db, t.id);
      const peer = t.left_id === chat.id ? t.right_id : t.left_id;
      const automation = !laneOwner && isAutomation(peer);
      const peerTitle = conversation(peer)?.title?.trim();
      const title = laneOwner ? `${botLabel(db, laneOwner)} · bot lane` : automation && peerTitle ? peerTitle : `${botLabel(db, chat.id)} ↔ ${peerTitle || botLabel(db, peer)}`;
      const live: BoardGroup | null = statuses.includes('needs_you') || statuses.includes('failed') ? 'needs_input' : statuses.includes('working') ? 'working' : queued ? 'up_next' : null;
      if (!live) {
        // Finished: never review work. Keep a short tail reachable under Completed; bot lanes are not listed.
        if (laneOwner || finishedThreads >= 20) continue;
        finishedThreads++;
      }
      const group: BoardGroup = live ?? 'completed';
      const last = (db.prepare('SELECT MAX(last_active_at) AS at FROM conversations WHERE id IN (SELECT conversation_id FROM coordination_lanes WHERE thread_id=?)').get(t.id) as { at: string | null }).at ?? '';
      threadRows++;
      rows.push({ kind: 'thread', id: t.id, group, title, status_line: statuses.includes('failed') ? 'Needs attention: the last turn failed' : statuses.includes('needs_you') ? 'The bot needs an answer in this thread' : statuses.includes('working') ? 'Working' : queued ? 'Queued behind other work' : mark?.mark === 'done' ? 'Marked done' : 'Finished', tag: laneOwner ? 'bot lane' : automation ? 'automation' : `with ${botLabel(db, peer)}`, updated_at: last, href: `#/chat/${chat.id}?side=coordination:${t.id}`, can_mark: Boolean(live) });
    }
    // 5. Chats this bot handed off. Live ones show under Active; a finished handoff is Completed, not review work,
    // because whether it was a human's ask or a bot's cannot be told cheaply and automation must never pile up here.
    const handoffs = (db.prepare('SELECT * FROM conversations WHERE origin_conversation_id=? AND archived=0 AND id<>? ORDER BY last_active_at DESC LIMIT 100').all(chat.id, chat.id) as ConversationRow[])
      .filter((c) => !laneChats.has(c.id) && !db.prepare('SELECT 1 FROM coordination_lanes WHERE conversation_id=?').get(c.id) && canViewConversation(user, c, db));
    let finishedHandoffs = 0;
    for (const c of handoffs) {
      const status = await ctx.manager.statusOf(c.id).catch(() => 'idle' as const);
      const mark = marks.get(`handoff:${c.id}`);
      const live: BoardGroup | null = status === 'needs_you' || status === 'failed' ? 'needs_input' : status === 'working' ? 'working' : null;
      if (!live && (isAutomation(c.id) || finishedHandoffs >= 20)) continue;
      if (!live) finishedHandoffs++;
      const group: BoardGroup = live ?? 'completed';
      rows.push({ kind: 'handoff', id: c.id, group, title: c.title || 'Untitled chat', status_line: status === 'failed' ? 'Needs attention: the last turn failed' : status === 'needs_you' ? 'Waiting for your answer' : status === 'working' ? 'Working' : mark?.mark === 'done' ? 'Marked done' : 'Finished', tag: agentName(c.id), updated_at: c.last_active_at, href: `#/chat/${c.id}`, can_mark: Boolean(live) });
    }
    // 6. Tickets mirrored into Veneer (Miles pilot) stay where they are; the board just shows them.
    for (const t of db.prepare('SELECT * FROM cs_tickets WHERE owner_conversation_id=? ORDER BY updated_at DESC').all(chat.id) as { id: string; orderops_ticket_id: string; subject: string; status: string; updated_at: string; customer_name: string }[]) {
      const open = db.prepare("SELECT id FROM bot_decisions WHERE cs_ticket_id=? AND state='needs_input' AND stale_json IS NULL LIMIT 1").get(t.id) as { id: string } | undefined;
      const group: BoardGroup = t.status === 'done' ? 'completed' : open || t.status === 'waiting_human' ? 'needs_input' : 'working';
      rows.push({ kind: 'ticket', id: t.id, group, title: t.subject || `Ticket ${t.orderops_ticket_id}`, status_line: open ? 'A question is waiting on the ticket page' : t.status === 'waiting_customer' ? 'Waiting on the customer' : t.status === 'done' ? 'Done' : 'Bot is working the ticket', tag: `ticket · ${t.customer_name || 'customer'}`, updated_at: t.updated_at, href: `#/bots/tickets/${chat.id}/${t.id}`, can_mark: false, ...(open ? { decision_id: open.id } : {}) });
    }
    rows.sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
    const counts = Object.fromEntries(GROUPS.map((g) => [g, rows.filter((r) => r.group === g).length])) as Record<BoardGroup, number>;
    res.json({ chat: { id: chat.id, title: chat.title, bot_name: botLabel(db, chat.id), registered: Boolean(db.prepare('SELECT 1 FROM bot_registrations WHERE conversation_id=? AND active=1').get(chat.id)) }, rows, counts, needs_you: counts.needs_input + counts.ready_for_review });
  }));
  router.post('/conversations/:id/tasks/mark', run((req, res) => {
    if (req.agentConversationId) throw new BotError(403, 'Marks are a human action');
    visibleChat(req, req.params.id!);
    res.json(tasks.mark(actor(req), req.params.id!, req.body));
  }));
  router.post('/conversations/:id/tasks/:taskId/discuss', run((req, res) => {
    if (req.agentConversationId) throw new BotError(403, 'Discussion from the board is a human action');
    visibleChat(req, req.params.id!);
    res.json(tasks.discuss(actor(req), req.params.taskId!, req.body));
  }));
  router.get('/conversations/:id/tasks/:taskId', run((req, res) => {
    if (req.agentConversationId) throw new BotError(403, 'The board is a human view');
    visibleChat(req, req.params.id!);
    const t = tasks.read(req.params.taskId!);
    if (!t || t.owner_conversation_id !== req.params.id) throw new BotError(404, 'Task not found');
    res.json({ task: tasks.listForOwner(req.params.id!).find((x) => x.id === t.id), events: tasks.events(t.id, 50), bot_name: botLabel(db, req.params.id!) });
  }));
  // Bot tools.
  router.post('/tasks', run((req, res) => res.json(tasks.create(actor(req), req.body))));
  router.post('/tasks/intake', run((req, res) => res.json(tasks.intake(actor(req), req.body))));
  router.post('/tasks/current/status', run((req, res) => res.json(tasks.setStatus(actor(req), req.body))));
  return router;
}
