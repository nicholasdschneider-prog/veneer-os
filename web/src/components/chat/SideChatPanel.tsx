import { ChevronDown, MessagesSquare, Plus, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api, type SideChatSummary } from '@/lib/api';
import { withSideParam } from '@/lib/sideChat';
import { cn } from '@/lib/utils';
import type { ToastAction } from '../ui/toast';
import { Button } from '../ui/button';
import { Chat } from '../../screens/Chat';

function replaceSide(value: string | null): void {
  const oldURL = window.location.href;
  window.history.replaceState(window.history.state, '', withSideParam(window.location.hash, value));
  window.dispatchEvent(new HashChangeEvent('hashchange', { oldURL, newURL: window.location.href }));
}

/**
 * A second conversation docked beside the main chat. The side agent shares the
 * parent's agent, project and model, starts with the parent's recent exchange,
 * and never posts into the parent, so the main turn is never interrupted.
 *
 * `sideParam` is the `side` query value: `open` resolves to the newest side
 * chat (or the new-chat form), `new` shows the form, anything else is an id.
 */
export function SideChatPanel({
  parentId,
  agentName,
  sideParam,
  onNavigate,
  onToast,
  onClose,
}: {
  parentId: string;
  agentName: string;
  sideParam: string;
  onNavigate: (hash: string) => void;
  onToast: (message: string, action?: ToastAction) => void;
  onClose: () => void;
}) {
  const [list, setList] = useState<SideChatSummary[] | null>(null);
  const [draft, setDraft] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const sideId = sideParam === 'open' || sideParam === 'new' ? null : sideParam;

  useEffect(() => {
    let active = true;
    const load = () =>
      api
        .sideChats(parentId)
        .then((r) => {
          if (active) setList(r.sideChats);
          return r.sideChats;
        })
        .catch(() => {
          if (active) setList([]);
          return [] as SideChatSummary[];
        });
    void load().then((chats) => {
      if (!active || sideParam !== 'open') return;
      replaceSide(chats[0]?.id ?? 'new');
    });
    const timer = window.setInterval(() => void load(), 10_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [parentId, sideParam]);

  useEffect(() => {
    if (!sideId) textareaRef.current?.focus();
  }, [sideId]);

  const create = async () => {
    const text = draft.trim();
    if (!text || creating) return;
    setCreating(true);
    setError(null);
    try {
      const { conversation } = await api.createSideChat(parentId, text);
      setDraft('');
      setList((prev) => [
        { id: conversation.id, title: conversation.title, lastActiveAt: conversation.lastActiveAt, status: 'working', unread: false },
        ...(prev ?? []),
      ]);
      replaceSide(conversation.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start the side chat');
    } finally {
      setCreating(false);
    }
  };

  const parentHash = withSideParam(window.location.hash, null);

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex shrink-0 items-center gap-1.5 border-b px-2 py-1.5 pt-[calc(env(safe-area-inset-top)+0.375rem)] md:pt-1.5">
        <MessagesSquare className="ml-1 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="shrink-0 text-sm font-medium">Side chat</span>
        {list && list.length > 0 ? (
          <label className="relative min-w-0 flex-1">
            <span className="sr-only">Which side chat</span>
            <select
              aria-label="Which side chat"
              value={sideId ?? 'new'}
              onChange={(e) => replaceSide(e.target.value)}
              className="w-full appearance-none truncate rounded-full border bg-background py-1 pr-7 pl-3 text-xs"
            >
              {list.map((c) => (
                <option key={c.id} value={c.id}>
                  {(c.title ?? 'Side chat').replace(/^Side chat · /, '')}
                  {c.unread ? ' •' : ''}
                </option>
              ))}
              <option value="new">New side chat…</option>
            </select>
            <ChevronDown className="pointer-events-none absolute top-1/2 right-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          </label>
        ) : (
          <span className="flex-1" />
        )}
        {sideId ? (
          <Button
            variant="ghost"
            size="icon"
            aria-label="New side chat"
            title="New side chat"
            onPointerUp={() => replaceSide('new')}
            className="rounded-full text-muted-foreground"
          >
            <Plus className="size-4" />
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="icon"
          aria-label="Close side chat"
          onPointerUp={onClose}
          className="rounded-full text-muted-foreground"
        >
          <X className="size-4" />
        </Button>
      </div>
      {sideId ? (
        <div className="min-h-0 flex-1">
          <Chat
            key={sideId}
            conversationId={sideId}
            backHash={parentHash}
            artifacts={[]}
            onOpenArtifact={() => undefined}
            onRefreshArtifacts={async () => []}
            onPublishArtifact={async () => undefined}
            onOpenCitations={() => undefined}
            onOpenProjectFile={() => undefined}
            onNavigate={onNavigate}
            onToast={onToast}
            sideChatButton={false}
          />
        </div>
      ) : (
        <form
          className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <div>
            <p className="font-medium">Ask on the side</p>
            <p className="mt-1 text-sm text-muted-foreground">
              A separate {agentName} answers here with this chat’s recent context. It reads the
              main chat but never messages it, so the work in progress is not interrupted.
            </p>
          </div>
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void create();
              }
            }}
            placeholder={`Question for ${agentName}…`}
            rows={4}
            disabled={creating}
            className="composer-fill w-full resize-none rounded-2xl px-3 py-2 text-[16px] outline-none"
          />
          {error ? <p className="text-xs text-destructive">{error}</p> : null}
          <div className="flex items-center justify-between gap-2">
            {list === null ? <span /> : list.length > 0 ? (
              <span className="text-xs text-muted-foreground">{list.length} earlier side {list.length === 1 ? 'chat' : 'chats'}</span>
            ) : <span />}
            <Button type="submit" disabled={creating || !draft.trim()} className={cn('min-h-10 rounded-full px-4')}>
              {creating ? 'Starting…' : 'Ask'}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
