import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { api } from '@/lib/api';
import { withSideParam } from '@/lib/sideChat';
import type { ConversationEvent } from '@/lib/types';
import { emptyTranscript, reduceEvents, type ChatItem } from '@/lib/transcript';
import { Markdown } from '../Markdown';
import { Button } from '../ui/button';

export interface CoordinationSummary {
  id: string;
  label: string;
  active: boolean;
  status?: string;
}
export interface CoordinationView {
  label: string;
  lanes: Array<{
    id: string;
    name: string;
    status: string;
    events: ConversationEvent[];
  }>;
}

export function CoordinationActivity({
  conversationId,
  onNavigate,
}: {
  conversationId: string;
  onNavigate: (hash: string) => void;
}) {
  const [threads, setThreads] = useState<CoordinationSummary[]>([]);
  useEffect(() => {
    let live = true;
    const load = () =>
      api
        .coordinationThreads(conversationId)
        .then((r) => {
          if (live) setThreads(r.threads);
        })
        .catch(() => {
          if (live) setThreads([]);
        });
    setThreads([]);
    void load();
    const timer = window.setInterval(() => void load(), 8000);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [conversationId]);
  if (!threads.length) return null;
  return (
    <div
      className="flex shrink-0 gap-3 overflow-x-auto border-b px-4 py-1 text-xs text-muted-foreground"
      aria-label="Bot conversations"
    >
      {threads.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() =>
            onNavigate(
              withSideParam(window.location.hash, `coordination:${t.id}`),
            )
          }
          className="relative min-h-9 shrink-0 rounded-sm hover:text-foreground focus-visible:outline focus-visible:outline-ring"
        >
          {t.label} ·{' '}
          {t.status ? `${t.status} · ` : t.active ? 'Working · ' : ''}View
          conversation
          <span
            className="pointer-fine:hidden absolute top-1/2 left-1/2 size-[max(100%,3rem)] -translate-1/2"
            aria-hidden="true"
          />
        </button>
      ))}
    </div>
  );
}

/** Merge complete turns, retaining each turn's provider event order. */
export function coordinationItems(
  view: CoordinationView,
): Array<{ name: string; at: string; key: string; items: ChatItem[] }> {
  return view.lanes
    .flatMap((lane) => {
      const groups: Array<{
        name: string;
        at: string;
        key: string;
        events: ConversationEvent[];
      }> = [];
      for (const event of lane.events) {
        if (event.type === 'turn_started')
          groups.push({
            name: lane.name,
            at: typeof event.at === 'string' ? event.at : '',
            key: `${lane.id}:${event.turnId}`,
            events: [],
          });
        if (!groups.length)
          groups.push({ name: lane.name, at: '', key: lane.id, events: [] });
        groups[groups.length - 1]!.events.push(event);
      }
      return groups.map((g) => ({
        ...g,
        items: reduceEvents(emptyTranscript(), g.events).items,
      }));
    })
    .sort((a, b) => a.at.localeCompare(b.at) || a.key.localeCompare(b.key));
}

export function CoordinationPanel({
  threadId,
  onClose,
  onNavigate,
}: {
  threadId: string;
  onClose: () => void;
  onNavigate: (hash: string) => void;
}) {
  const [view, setView] = useState<CoordinationView | null>(null);
  const [error, setError] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    closeRef.current?.focus({ preventScroll: true });
    return () => {
      requestAnimationFrame(() => {
        if (previous instanceof HTMLElement && previous.isConnected)
          previous.focus({ preventScroll: true });
      });
    };
  }, []);
  useEffect(() => {
    let live = true;
    setView(null);
    setError(false);
    const load = () =>
      api
        .coordinationThread(threadId)
        .then((r) => {
          if (live) {
            setView(r);
            setError(false);
          }
        })
        .catch(() => {
          if (live) {
            setView(null);
            setError(true);
          }
        });
    void load();
    const timer = window.setInterval(() => void load(), 4000);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [threadId]);
  return (
    <section
      className="flex h-full min-h-0 min-w-0 flex-col bg-background"
      aria-label="Bot conversation"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <header className="flex shrink-0 items-center gap-3 border-b p-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-balance text-base font-medium">
            {view?.label ?? 'Bot conversation'}
          </h2>
          <p className="text-sm text-muted-foreground">Coordination</p>
        </div>
        <Button
          ref={closeRef}
          variant="ghost"
          size="icon"
          onClick={onClose}
          aria-label="Close bot conversation"
          className="relative shrink-0"
        >
          <X className="size-4 shrink-0" />
          <span
            className="pointer-fine:hidden absolute top-1/2 left-1/2 size-[max(100%,3rem)] -translate-1/2"
            aria-hidden="true"
          />
        </Button>
      </header>
      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto overscroll-contain p-4 text-base sm:text-sm">
        {error ? (
          <p role="alert">
            This conversation could not be loaded. Access to both bots is
            required.
          </p>
        ) : !view ? (
          <p>Loading conversation…</p>
        ) : (
          <>
            {view.lanes
              .filter((l) => l.status === 'needs_you' || l.status === 'failed')
              .map((l) => (
                <p key={l.id}>
                  <button
                    className="underline"
                    onClick={() =>
                      onNavigate(withSideParam(window.location.hash, l.id))
                    }
                  >
                    Review {l.name}’s request
                  </button>
                </p>
              ))}
            {coordinationItems(view).map((turn) => (
              <section key={turn.key} className="space-y-3">
                {turn.items.map((item) =>
                  item.kind === 'user' ? (
                    <div
                      key={item.key}
                      className="space-y-1 rounded-lg bg-muted/50 p-3"
                    >
                      <p className="font-medium">
                        {item.origin?.from ?? 'Message'} → {turn.name}
                      </p>
                      <p className="whitespace-pre-wrap break-words">
                        {item.text}
                      </p>
                    </div>
                  ) : item.kind === 'assistant' ? (
                    <div key={item.key} className="space-y-1">
                      <p className="font-medium">{turn.name}</p>
                      <Markdown markdown={item.markdown} />
                    </div>
                  ) : item.kind === 'tool' ? (
                    <details key={item.key} className="text-muted-foreground">
                      <summary className="cursor-pointer">
                        {item.label} ·{' '}
                        {item.running ? 'Working' : item.ok ? 'Done' : 'Failed'}
                      </summary>
                      <pre className="whitespace-pre-wrap break-words text-xs">
                        {item.inputPreview}
                        {'\n'}
                        {item.resultPreview}
                      </pre>
                    </details>
                  ) : item.kind === 'notice' ? (
                    <p key={item.key} className="text-muted-foreground">
                      {item.message}
                    </p>
                  ) : null,
                )}
              </section>
            ))}
            {!view.lanes.length && <p>No messages yet.</p>}
          </>
        )}
      </div>
    </section>
  );
}
