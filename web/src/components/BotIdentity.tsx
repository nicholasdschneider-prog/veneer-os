import { useEffect, useState } from 'react';
import { wsBus } from '@/lib/ws';
import type { ConversationEvent } from '@/lib/types';

/** Derive display copy only; native chat titles and membership roles stay untouched. */
export function botJobTitle(name: string, title?: string | null): string {
  const value = title?.trim() ?? '';
  const prefix = name.trim();
  if (!prefix) return value;
  if (value.toLocaleLowerCase() === prefix.toLocaleLowerCase()) return '';
  if (value.slice(0, prefix.length).toLocaleLowerCase() !== prefix.toLocaleLowerCase())
    return value;
  const remainder = value.slice(prefix.length);
  // Require a boundary: Ann must not remove the start of Annette.
  return /^[\s·•|:–—-]/u.test(remainder)
    ? remainder.replace(/^[\s·•|:–—-]+/u, '').trim()
    : value;
}

export function BotName({ name, title }: { name: string; title?: string | null }) {
  const description = botJobTitle(name, title);
  return (
    <span className="block min-w-0 break-words font-medium [overflow-wrap:anywhere]">
      <span>{name}</span>
      {description && <>{' '}<span className="ml-1 text-xs font-normal text-muted-foreground">{description}</span></>}
    </span>
  );
}

const colors = ['#7c3aed', '#0284c7', '#059669', '#db2777', '#d97706', '#4f46e5'];
export function BotAvatar({ id, name }: { id: string; name: string }) {
  const hash = Array.from(id).reduce((n, c) => (n * 31 + c.charCodeAt(0)) >>> 0, 0);
  return (
    <svg
      role="img"
      aria-label={`${name} avatar`}
      viewBox="0 0 40 40"
      className="size-10 shrink-0 rounded-xl"
    >
      <rect width="40" height="40" rx="12" fill={colors[hash % colors.length]} />
      <path
        d={(hash >>> 4) % 2 ? 'M20 8v5M15 8h10' : 'M12 10l4 4m12-4-4 4'}
        stroke="white"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <rect
        x="8"
        y="14"
        width="24"
        height="18"
        rx={(hash >>> 8) % 3 === 0 ? 9 : 5}
        fill="white"
        fillOpacity=".95"
      />
      <circle cx="15" cy="22" r="2" fill={colors[hash % colors.length]} />
      <circle cx="25" cy="22" r="2" fill={colors[hash % colors.length]} />
      <path
        d="M17 27h6"
        stroke={colors[hash % colors.length]}
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}
export function replyActivity(event: ConversationEvent, current: boolean): boolean {
  if (event.type === 'text_delta')
    return Boolean(typeof event.text === 'string' && event.text.trim()) || current;
  if (
    [
      'text_final',
      'tool_started',
      'turn_done',
      'error',
      'turn_started',
      'approval_requested',
      'question_asked',
    ].includes(event.type)
  )
    return false;
  return current;
}
export function BotPresence({ id, state }: { id: string; state: string }) {
  const [typing, setTyping] = useState(false);
  const [liveState, setLiveState] = useState<string | null>(null);
  useEffect(() => {
    let composing = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const clear = () => {
      composing = false;
      setTyping(false);
      clearTimeout(timer);
    };
    const unsubscribe = wsBus.subscribe(id, {
      presenceOnly: true,
      // A snapshot may contain historical deltas; only new stream events mean typing.
      onSnapshot: (_events, status) => {
        clear();
        setLiveState(status === 'working' ? 'working' : status === 'failed' ? 'failed' : null);
      },
      onEvent: (event) => {
        composing = replyActivity(event, composing);
        setTyping(composing);
        clearTimeout(timer);
        if (composing) timer = setTimeout(clear, 8000);
      },
      onStatus: (status) => {
        setLiveState(
          status === 'working'
            ? 'working'
            : status === 'failed'
              ? 'failed'
              : status === 'needs_you'
                ? 'needs input'
                : 'idle',
        );
        if (status !== 'working') clear();
      },
      onDisconnect: () => {
        clear();
        setLiveState('Reconnecting');
      },
      onError: clear,
    });
    return () => {
      unsubscribe();
      clearTimeout(timer);
    };
  }, [id]);
  return (
    <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
      {typing ? (
        <span
          role="status"
          aria-label="Composing a reply"
          className="inline-flex items-center gap-1"
        >
          {[0, 1, 2].map((n) => (
            <span
              key={n}
              aria-hidden="true"
              className="size-1 rounded-full bg-current motion-safe:animate-bounce"
              style={{ animationDelay: `${n * 150}ms` }}
            />
          ))}
          <span className="sr-only">Composing a reply</span>
        </span>
      ) : liveState === 'idle' ? (
        state === 'working' || state === 'failed' ? (
          'available'
        ) : (
          state
        )
      ) : (
        (liveState ?? state)
      )}
    </span>
  );
}
