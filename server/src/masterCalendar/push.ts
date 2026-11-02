import webpush from 'web-push';
import type { AppContext } from '../context.js';
import { pushKeys, Subscription } from '../botWorkflows/notifications.js';
import type { MasterCalendar } from './service.js';

function startsIn(startMs: number, now: number) {
  const minutes = Math.round((startMs - now) / 60_000);
  if (minutes <= 0) return 'Starting now';
  if (minutes < 60) return `Starts in ${minutes} min`;
  return `Starts in ${Math.floor(minutes / 60)} h ${minutes % 60 ? `${minutes % 60} min` : ''}`.trim();
}

/**
 * Sends each due calendar reminder once to each of the person's push devices. Only people who have
 * opened the master calendar (a settings row) are polled, and only while they have a device.
 */
export function createCalendarPushWorker(ctx: Pick<AppContext, 'db' | 'secrets'>, calendar: MasterCalendar, send = webpush.sendNotification, clock = Date.now) {
  let lastPrune = 0;
  return async function tick() {
    const now = clock();
    if (now - lastPrune > 3_600_000) {
      lastPrune = now;
      ctx.db.prepare('DELETE FROM master_calendar_push_sent WHERE sent_ms < ?').run(now - 3 * 86_400_000);
    }
    const users = ctx.db
      .prepare('SELECT DISTINCT s.user_id AS id FROM master_calendar_settings s JOIN bot_push_devices d ON d.user_id=s.user_id')
      .all() as { id: number }[];
    for (const { id: userId } of users) {
      let due;
      try {
        due = await calendar.dueReminders(userId);
      } catch {
        continue;
      }
      if (!due.length) continue;
      const devices = ctx.db.prepare('SELECT id FROM bot_push_devices WHERE user_id=?').all(userId) as { id: string }[];
      for (const event of due) {
        const firing = `${event.occurrenceKey}#${event.dueMs}`;
        for (const device of devices) {
          const claimed = ctx.db
            .prepare('INSERT OR IGNORE INTO master_calendar_push_sent(device_id,firing_key,sent_ms) VALUES(?,?,?)')
            .run(device.id, firing, now).changes;
          if (!claimed) continue;
          const raw = ctx.secrets.getApiKeyOverride(`bot-push-device-${device.id}`);
          if (!raw) continue;
          try {
            await send(
              Subscription.parse(JSON.parse(raw)),
              JSON.stringify({
                kind: 'calendar',
                title: event.title.slice(0, 120),
                body: `${startsIn(event.startMs, now)} · ${event.account}`.slice(0, 200),
                occurrenceKey: event.occurrenceKey,
                joinUrl: event.joinUrl,
                tag: `veneer-cal-${firing}`.slice(0, 200),
              }),
              { vapidDetails: { subject: 'https://veneer.app', ...pushKeys(ctx as AppContext) }, TTL: 900, urgency: 'high', timeout: 10_000 },
            );
          } catch (e) {
            // One attempt per device: a late calendar reminder is worse than none.
            const status = (e as { statusCode?: number }).statusCode;
            if (status === 404 || status === 410) {
              ctx.db.prepare('DELETE FROM bot_push_devices WHERE id=?').run(device.id);
              ctx.secrets.clearApiKeyOverride(`bot-push-device-${device.id}`);
            }
          }
        }
      }
    }
  };
}
