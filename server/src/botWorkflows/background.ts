import type { AppContext } from '../context.js';
import { tickRoutines } from './routines.js';
import { tickSearch } from './search.js';
import { tickNotifications, queueNotification } from './notifications.js';
export function startBotWorkflows(ctx: AppContext) {
  let busy = false,
    searchBusy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      tickRoutines(ctx.db);
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
    clearInterval(timer);
    clearInterval(searchTimer);
  };
}
