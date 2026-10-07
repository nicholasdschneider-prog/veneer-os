import type { AppContext } from '../context.js';
import { startWebLoopMetrics } from '../ops/webLoopMetrics.js';
import { tickRoutines } from './routines.js';
import { createBotService } from '../bots/service.js';
import { tickSearch } from './search.js';
import { tickNotifications, queueNotification, sendCallPush } from './notifications.js';
import { startPhoneCall, tickBotCalls } from '../bots/botCalls.js';
import { startCalendarReminderWorker } from '../calendarReminders/worker.js';
export function startBotWorkflows(ctx: AppContext) {
  const stopReminders=startCalendarReminderWorker(ctx);
  const stopLoopMetrics = startWebLoopMetrics(ctx.config.dataDir);
  let busy = false,
    searchBusy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      tickRoutines(ctx.db);
      const bots = createBotService(ctx.db);
      bots.withdrawStaleQuestions(ctx.config.staleQuestionWithdrawMs, Date.now(), ctx.config.resolvedQuestionWithdrawMs);
      bots.queueQuestionRechecks(ctx.config.questionRecheckMs);
      const calls = tickBotCalls(ctx);
      for (const { userId, ring } of calls.pushes) void sendCallPush(ctx, userId, ring).catch(() => {});
      for (const phone of calls.phones) void startPhoneCall(ctx, phone);
      await tickNotifications(ctx);
    } catch {
      console.warn('[bot-workflows] Background pass failed; retrying.');
    } finally {
      busy = false;
    }
  };
  const searchTimer = setInterval(() => {
    if (searchBusy) return;
    searchBusy = true;
    void tickSearch(ctx)
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
