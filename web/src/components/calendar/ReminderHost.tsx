import { useCallback, useEffect, useState } from 'react';
import { BellRing, Video, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { requestJson } from '@/lib/api';
import { cn } from '@/lib/utils';
import { calendarApi, calendarPanel, formatTime, useCalendarPanel, type UpcomingEvent } from '@/lib/masterCalendar';

const POLL_MS = 60_000;

/** Registers this device for Veneer push (shared with bot notifications). */
export async function enableCalendarPush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window))
    throw new Error('This browser does not support notifications. On iPhone or iPad, add Veneer to your Home Screen and open it there.');
  if ((await Notification.requestPermission()) !== 'granted') throw new Error('Allow notifications for Veneer in your browser or device settings.');
  const { publicKey } = await requestJson<{ publicKey: string }>('/api/bot-workflows/push');
  const registration = await navigator.serviceWorker.register('/sw.js');
  await navigator.serviceWorker.ready;
  const key = Uint8Array.from(atob(publicKey.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
  const sub = (await registration.pushManager.getSubscription()) ?? (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }));
  const raw = sub.toJSON();
  const device = await requestJson<{ id: string }>('/api/bot-workflows/push', { method: 'POST', body: JSON.stringify({ endpoint: raw.endpoint, keys: raw.keys }) });
  localStorage.setItem('veneer:push-device', device.id);
}

function startsIn(startMs: number, now: number) {
  const minutes = Math.round((startMs - now) / 60_000);
  if (minutes <= 0) return minutes < -1 ? `Started ${-minutes} min ago` : 'Starting now';
  return minutes < 60 ? `In ${minutes} min` : `In ${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/**
 * Pops up calendar reminders anywhere in Veneer. Reads the server's shared upcoming list, so a
 * dismiss or snooze on one device clears the reminder on the others at their next read.
 */
export function ReminderHost() {
  const panel = useCalendarPanel();
  const [events, setEvents] = useState<UpcomingEvent[]>([]);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [now, setNow] = useState(Date.now());
  const [stopped, setStopped] = useState(false);

  const load = useCallback(async () => {
    if (document.hidden || stopped) return;
    try {
      const r = await calendarApi.upcoming();
      setEvents(r.events);
      setHidden(new Set());
    } catch (e) {
      if ((e as { status?: number }).status === 403 || (e as { status?: number }).status === 404) setStopped(true);
    }
  }, [stopped]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), POLL_MS);
    const onVisible = () => void load();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [load, panel.changed]);

  // Wake exactly when the next reminder is due rather than waiting for the next poll.
  useEffect(() => {
    const t = Date.now();
    const next = events.map((e) => e.dueMs).filter((d): d is number => d !== null && d > t).sort((a, b) => a - b)[0];
    const timer = window.setTimeout(() => setNow(Date.now()), Math.min(30_000, Math.max(250, (next ?? t + 30_000) - t)));
    return () => window.clearTimeout(timer);
  }, [events, now]);

  const due = events.filter((e) => e.dueMs !== null && e.dueMs <= now && e.endMs > now && !hidden.has(e.occurrenceKey));
  if (!due.length) return null;

  const act = (e: UpcomingEvent, action: 'dismiss' | 'snooze') => {
    setHidden((h) => new Set(h).add(e.occurrenceKey));
    void calendarApi
      .reminder(e.occurrenceKey, action)
      .catch(() => setHidden((h) => {
        const next = new Set(h);
        next.delete(e.occurrenceKey);
        return next;
      }));
  };

  return (
    <div
      role="region"
      aria-label="Calendar reminders"
      className={cn(
        'fixed right-3 bottom-[calc(var(--vp-nav-h,0px)+0.75rem)] z-[60] flex w-[min(22rem,calc(100vw-1.5rem))] flex-col gap-2 md:bottom-4',
        // Beside an open desktop calendar panel rather than over it.
        panel.open && 'md:right-[376px]',
      )}
    >
      {due.slice(0, 3).map((e) => (
        <div key={e.occurrenceKey} role="alert" className="rounded-xl border bg-card p-3 text-sm shadow-xl ring-1 ring-black/5">
          <div className="flex items-start gap-2">
            <BellRing className="mt-0.5 size-4 shrink-0" style={{ color: e.color }} />
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium">{e.title}</p>
              <p className="text-xs text-muted-foreground">
                {startsIn(e.startMs, now)} · {formatTime(e.startMs)} · {e.account}
              </p>
              {e.location && !e.joinUrl ? <p className="truncate text-xs text-muted-foreground">{e.location}</p> : null}
            </div>
            <button type="button" aria-label="Dismiss reminder" onClick={() => act(e, 'dismiss')} className="text-muted-foreground">
              <X className="size-4" />
            </button>
          </div>
          <div className="mt-2 flex gap-2">
            {e.joinUrl ? (
              <Button size="sm" asChild>
                <a href={e.joinUrl} target="_blank" rel="noreferrer" onClick={() => act(e, 'dismiss')}>
                  <Video /> Join
                </a>
              </Button>
            ) : (
              <Button size="sm" variant="outline" onClick={() => calendarPanel.setOpen(true)}>
                Open calendar
              </Button>
            )}
            <Button size="sm" variant="outline" onClick={() => act(e, 'snooze')}>
              Snooze 5 min
            </Button>
            <Button size="sm" variant="ghost" onClick={() => act(e, 'dismiss')}>
              Dismiss
            </Button>
          </div>
        </div>
      ))}
      {due.length > 3 ? <p className="text-right text-xs text-muted-foreground">+{due.length - 3} more</p> : null}
    </div>
  );
}
