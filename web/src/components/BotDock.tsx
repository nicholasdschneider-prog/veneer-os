import { useEffect, useRef, useState } from 'react';
import { botsApi, type Bot } from '@/lib/bots';
import { BotAvatar } from './BotIdentity';
import { BotActions, BOT_PREFERENCES_CHANGED } from './BotActions';
import { cn } from '@/lib/utils';

/** Server timestamps arrive either as ISO or as SQLite `YYYY-MM-DD HH:MM:SS` (UTC). */
export function parseServerTime(value: string | null | undefined): number {
  if (!value) return 0;
  const iso = value.includes('T') ? value : value.replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(value) ? '' : 'Z');
  const time = Date.parse(iso);
  return Number.isFinite(time) ? time : 0;
}

/** When the bot last said something: its latest reply, else the chat's last activity. */
export function lastHeard(bot: Bot): number {
  return parseServerTime(bot.last_reply?.at) || parseServerTime(bot.updated_at);
}

/** iMessage order: whoever replied most recently is on top. Pins do not override recency here. */
export function sortDockBots(bots: Bot[]): Bot[] {
  return bots
    .filter((b) => !b.archived)
    .slice()
    .sort((a, b) => lastHeard(b) - lastHeard(a) || a.name.localeCompare(b.name) || a.conversation_id.localeCompare(b.conversation_id));
}

/** Short, list-style time: 4m, 3h, Yesterday, Tue, Nov 2. */
export function dockTime(at: number, now = Date.now()): string {
  if (!at) return '';
  const minutes = Math.floor(Math.max(0, now - at) / 60000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const then = new Date(at);
  const today = new Date(now);
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  if (at >= startOfToday) return `${Math.floor(minutes / 60)}h`;
  const day = 86400000;
  if (at >= startOfToday - day) return 'Yesterday';
  if (at >= startOfToday - 6 * day) return then.toLocaleDateString(undefined, { weekday: 'short' });
  return then.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** The URL of a bot's own pop-out window. */
export function popOutHash(conversationId: string): string {
  return `#/popout/${encodeURIComponent(conversationId)}`;
}

/** Open the bot in its own small browser window; reuses that bot's window if already open. */
export function popOutBot(conversationId: string): void {
  const url = `${window.location.origin}${window.location.pathname}${popOutHash(conversationId)}`;
  const win = window.open(url, `veneer-bot-${conversationId}`, 'popup,width=460,height=780');
  win?.focus();
}

/**
 * Every bot the signed-in person can see, newest reply first. Uses the light
 * roster view of /api/bots (no decision bodies); polls quickly only while the
 * dock list is on screen and slowly otherwise, for the unread badge.
 */
export function useBotRoster(open: boolean) {
  const [bots, setBots] = useState<Bot[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const busy = useRef(false);
  useEffect(() => {
    let alive = true;
    const refresh = () => {
      if (busy.current || document.visibilityState === 'hidden') return;
      busy.current = true;
      void botsApi
        .roster()
        .then((r) => { if (alive) { setBots(sortDockBots(r.bots)); setError(''); } })
        .catch((e: Error & { status?: number }) => {
          if (!alive) return;
          if (e.status === 401 || e.status === 403) setBots([]);
          else setError('Bots could not refresh.');
        })
        .finally(() => { busy.current = false; if (alive) setLoaded(true); });
    };
    refresh();
    const timer = window.setInterval(refresh, open ? 5000 : 30000);
    window.addEventListener(BOT_PREFERENCES_CHANGED, refresh);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      alive = false;
      clearInterval(timer);
      window.removeEventListener(BOT_PREFERENCES_CHANGED, refresh);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [open]);
  return { bots, loaded, error, unread: bots.filter((b) => b.unread).length };
}

/** The iMessage-style list of bots inside the desk. */
export function BotDockList({
  bots,
  loaded,
  error,
  selectedId,
  onOpen,
  now,
}: {
  bots: Bot[];
  loaded: boolean;
  error: string;
  selectedId: string | null;
  onOpen: (bot: Bot) => void;
  /** Test seam for relative times. */
  now?: number;
}) {
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const shown = q ? bots.filter((b) => b.name.toLowerCase().includes(q) || (b.title ?? '').toLowerCase().includes(q)) : bots;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b p-2">
        <input
          aria-label="Find a bot"
          placeholder="Find a bot…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="w-full rounded-lg border bg-background px-3 py-2 text-base sm:text-sm"
        />
      </div>
      {error && <p role="alert" className="px-3 pt-2 text-sm text-destructive">{error}</p>}
      <nav aria-label="Bots" className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1">
        {!shown.length && (
          <p className="p-3 text-base text-muted-foreground sm:text-sm">
            {!loaded ? 'Loading your bots…' : q ? 'No bot matches that name.' : 'No bots yet.'}
          </p>
        )}
        {shown.map((bot) => {
          const at = lastHeard(bot);
          return (
            <BotActions key={bot.conversation_id} bot={bot}>
              <button
                type="button"
                data-dock-bot={bot.conversation_id}
                aria-current={bot.conversation_id === selectedId ? 'true' : undefined}
                aria-label={`${bot.name}${bot.unread ? ', unread' : ''}${bot.questions ? `, ${bot.questions} waiting questions` : ''}`}
                onClick={() => onOpen(bot)}
                className={cn(
                  'flex min-h-14 w-full items-center gap-3 rounded-xl px-2 py-2 text-left hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring',
                  bot.conversation_id === selectedId && 'bg-muted',
                )}
              >
                <span className="relative shrink-0">
                  <BotAvatar id={bot.conversation_id} name={bot.name} />
                  {bot.state === 'working' && (
                    <span aria-hidden="true" className="absolute -right-0.5 -bottom-0.5 size-3 rounded-full border-2 border-background bg-emerald-500" />
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-2">
                    <span className={cn('min-w-0 flex-1 truncate text-sm', bot.unread ? 'font-semibold' : 'font-medium')}>{bot.name}</span>
                    <span className={cn('shrink-0 text-xs tabular-nums', bot.unread ? 'text-primary' : 'text-muted-foreground')}>{dockTime(at, now)}</span>
                  </span>
                  <span className="flex items-center gap-2">
                    <span className={cn('min-w-0 flex-1 truncate text-xs', bot.unread ? 'text-foreground' : 'text-muted-foreground')}>
                      {bot.last_reply?.text || bot.title || 'No replies yet'}
                    </span>
                    {bot.questions > 0 && (
                      <span title="Waiting questions" className="shrink-0 rounded-full bg-amber-500 px-1.5 text-xs font-semibold text-black tabular-nums">{bot.questions}</span>
                    )}
                    {bot.unread && <span aria-hidden="true" data-unread-dot className="size-2.5 shrink-0 rounded-full bg-blue-500" />}
                  </span>
                </span>
              </button>
            </BotActions>
          );
        })}
      </nav>
    </div>
  );
}
