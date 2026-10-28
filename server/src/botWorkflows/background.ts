import type { AppContext } from '../context.js';
import { startWebLoopMetrics } from '../ops/webLoopMetrics.js';
import { createWebOperationMetrics, type WebOperationMetrics } from '../ops/webOperationMetrics.js';
import { tickRoutines } from './routines.js';
import { createBotService } from '../bots/service.js';
import { tickSearch } from './search.js';
import { tickNotifications, queueNotification, sendCallPush } from './notifications.js';
import { startPhoneCall, tickBotCalls } from '../bots/botCalls.js';
import { startCalendarReminderWorker } from '../calendarReminders/worker.js';
import { escalateStaleDecisions, escalationEnabled } from '../bots/decisionEscalation.js';
import { createTicketPoller, MIRROR_SECRET } from '../csTickets/poll.js';
import { createTaskService } from '../tasks/service.js';
import crypto from 'node:crypto';
import { readSecretValue } from '../secrets/readSecret.js';
export function startBotWorkflows(ctx: AppContext, metrics: WebOperationMetrics = createWebOperationMetrics()) {
  const stopReminders=startCalendarReminderWorker(ctx);
  const stopLoopMetrics = startWebLoopMetrics(ctx.config.dataDir, metrics);
  // Read-only OrderOps mirror for tickets owned inside Veneer (Miles pilot); paces itself to every two minutes.
  const ticketPoller = createTicketPoller(ctx.db, {
    readCredential: async () => (await readSecretValue({ db: ctx.db, projectDopplerCli: ctx.projectDopplerCli ?? null }, { name: MIRROR_SECRET.credential, project: MIRROR_SECRET.project, config: MIRROR_SECRET.config })).value,
    log: { info: (m) => console.info(m), warn: (m) => console.warn(m) },
  });
  // Shared Tasks: after a (re)start, working tasks reconcile against their sources before anything is rescheduled.
  const taskService = createTaskService(ctx.db);
  try { const woken = taskService.reconcileAfterRestart(crypto.randomUUID()); if (woken) console.info(`[tasks] ${woken} working task(s) asked to reconcile after restart`); } catch (e) { console.warn(`[tasks] restart reconciliation failed: ${(e as Error).message}`); }
  let lastSchedule = 0;
  let busy = false,
    searchBusy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      metrics.measure('routines', () => tickRoutines(ctx.db));
      const bots = createBotService(ctx.db);
      metrics.measure('stale_questions', () => bots.withdrawStaleQuestions(ctx.config.staleQuestionWithdrawMs, Date.now(), ctx.config.resolvedQuestionWithdrawMs));
      metrics.measure('question_rechecks', () => bots.queueQuestionRechecks(ctx.config.questionRecheckMs));
      // Before the call poll, so a re-ring made due here can ring in this same pass.
      if (escalationEnabled()) {
        try { escalateStaleDecisions(ctx); } catch { console.warn('[decision-escalation] Pass failed; retrying.'); }
      }
      const calls = metrics.measure('call_poll', () => tickBotCalls(ctx));
      for (const { userId, ring } of calls.pushes) void sendCallPush(ctx, userId, ring).catch(() => {});
      for (const phone of calls.phones) void startPhoneCall(ctx, phone);
      await metrics.measureAsync('notifications', () => tickNotifications(ctx));
      await metrics.measureAsync('cs_ticket_poll', () => ticketPoller.tick());
      if (Date.now() - lastSchedule > 30_000) {
        lastSchedule = Date.now();
        // Start queued tasks whose owner has a free slot and whose shared resources are free.
        for (const { owner } of ctx.db.prepare("SELECT DISTINCT owner_conversation_id AS owner FROM bot_tasks WHERE status='up_next'").all() as { owner: string }[]) taskService.schedule(owner);
      }
    } catch {
      console.warn('[bot-workflows] Background pass failed; retrying.');
    } finally {
      busy = false;
    }
  };
  const searchTimer = setInterval(() => {
    if (searchBusy) return;
    searchBusy = true;
    void metrics.measureAsync('search', () => tickSearch(ctx))
      .catch(() => {})
      .finally(() => {
        searchBusy = false;
      });
  }, 5000);
  searchTimer.unref();
  const timer = setInterval(() => void tick(), 5000);
  timer.unref();
  ctx.manager.bus.on('status', (id: string, status: string) => {
    if (status === 'needs_you' || status === 'failed')
      queueNotification(
        ctx,
        id,
        `status:${id}:${status}:${new Date().toISOString().slice(0, 16)}`,
        status === 'needs_you' ? 'input' : 'blocked',
        `#/chat/${id}`,
      );
  });
  return () => {
    stopReminders();
    stopLoopMetrics();
    clearInterval(timer);
    clearInterval(searchTimer);
  };
}
