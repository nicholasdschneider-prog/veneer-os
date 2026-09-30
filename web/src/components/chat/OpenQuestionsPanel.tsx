import { useEffect, useState } from 'react';
import { MessageCircleQuestion, X } from 'lucide-react';
import { botsApi, type BotDecision } from '@/lib/bots';
import { decisionStatusLabel } from '@/lib/decisionPresentation';
import { withSideParam } from '@/lib/sideChat';
import { Button } from '../ui/button';
import { Bots } from '../../screens/Bots';

export function questionsForConversation(decisions: BotDecision[], conversationId: string) {
  return decisions.filter(d => d.conversation_id === conversationId && d.state === 'needs_input');
}

export const CHAT_DECISIONS_CHANGED = 'chat-decisions-changed';
const POLL_MS = 5000;

interface DecisionFeed { decisions: BotDecision[]; loaded: boolean; error: string }
interface FeedEntry { feed: DecisionFeed; listeners: Set<() => void>; inFlight: boolean; timer: number | null; issued: number; applied: number; stop?: () => void }
/**
 * One poller per conversation, shared by every consumer on the page (chat
 * transcript, header button, side panel). A completed response is applied
 * unless a newer one was already applied; a slow reply is never thrown away
 * because the next poll started. The next poll is scheduled only after the
 * previous one settles.
 */
const feeds = new Map<string, FeedEntry>();

function emit(entry: FeedEntry) { for (const l of entry.listeners) l(); }

function poll(conversationId: string, entry: FeedEntry): void {
  if (entry.inFlight || !entry.listeners.size) return;
  entry.inFlight = true;
  const request = ++entry.issued;
  const settle = (next: Partial<DecisionFeed>) => {
    entry.inFlight = false;
    if (request > entry.applied) { entry.applied = request; entry.feed = { ...entry.feed, ...next }; emit(entry); }
    if (entry.listeners.size) entry.timer = window.setTimeout(() => { entry.timer = null; poll(conversationId, entry); }, POLL_MS);
  };
  botsApi.decisionsFor(conversationId)
    .then(result => settle({ decisions: result.decisions.filter(d => d.conversation_id === conversationId), loaded: true, error: '' }))
    .catch(() => settle({ error: 'Could not refresh open questions.' }));
}

function refreshNow(conversationId: string, entry: FeedEntry): void {
  if (entry.timer !== null) { window.clearTimeout(entry.timer); entry.timer = null; }
  poll(conversationId, entry);
}

export function subscribeChatDecisions(conversationId: string, listener: () => void): () => void {
  let entry = feeds.get(conversationId);
  if (!entry) { entry = { feed: { decisions: [], loaded: false, error: '' }, listeners: new Set(), inFlight: false, timer: null, issued: 0, applied: 0 }; feeds.set(conversationId, entry); }
  entry.listeners.add(listener);
  if (entry.listeners.size === 1) {
    const wake = () => { if (document.visibilityState !== 'hidden') refreshNow(conversationId, entry!); };
    window.addEventListener(CHAT_DECISIONS_CHANGED, wake);
    window.addEventListener('focus', wake);
    document.addEventListener('visibilitychange', wake);
    entry.stop = () => { window.removeEventListener(CHAT_DECISIONS_CHANGED, wake); window.removeEventListener('focus', wake); document.removeEventListener('visibilitychange', wake); };
    refreshNow(conversationId, entry);
  }
  return () => {
    entry!.listeners.delete(listener);
    if (entry!.listeners.size === 0) {
      entry!.stop?.();
      if (entry!.timer !== null) { window.clearTimeout(entry!.timer); entry!.timer = null; }
      // Keep the last feed so a remount shows questions immediately; the next subscriber refreshes.
    }
  };
}

export function readChatDecisions(conversationId: string): DecisionFeed | undefined { return feeds.get(conversationId)?.feed; }

export function useChatDecisions(conversationId: string) {
  const [, rerender] = useState(0);
  useEffect(() => {
    if (!conversationId) return;
    return subscribeChatDecisions(conversationId, () => rerender(n => n + 1));
  }, [conversationId]);
  const feed = conversationId ? feeds.get(conversationId)?.feed : undefined;
  return { decisions: feed?.decisions ?? [], loading: !feed?.loaded, error: feed?.error ?? '' };
}

export function OpenQuestionsButton({ conversationId, onNavigate }: { conversationId: string; onNavigate: (hash: string) => void }) {
  const { decisions, error } = useChatDecisions(conversationId);
  const pending = questionsForConversation(decisions, conversationId).length;
  return <Button variant="ghost" size="sm" className="min-h-11 shrink-0 gap-1 rounded-full" aria-label={`Open questions${pending ? `, ${pending} pending` : ''}${error ? ', refresh unavailable' : ''}`} title="Unanswered questions" onClick={() => onNavigate(withSideParam(window.location.hash, 'questions'))}>
    <MessageCircleQuestion className="size-4" aria-hidden="true" />
    <span className="hidden sm:inline">Questions</span>
    {pending > 0 && <span className="rounded-full bg-amber-500 px-1.5 text-xs font-semibold text-black tabular-nums">{pending}</span>}
    {error && <span aria-hidden="true">!</span>}
  </Button>;
}

export function OpenQuestionsPanel({ conversationId, decisionId, restricted = false, onClose, onNavigate }: {
  conversationId: string; decisionId?: string; restricted?: boolean; onClose: () => void; onNavigate: (hash: string) => void;
}) {
  const { decisions, loading, error } = useChatDecisions(conversationId);
  const pending = questionsForConversation(decisions, conversationId);
  const open = (id?: string) => onNavigate(withSideParam(window.location.hash, id ? `decision:${id}` : 'questions'));
  const navigateThread = (hash: string) => {
    if (hash === '#/bots') open();
    else if (hash.startsWith('#/bots/')) open(hash.slice('#/bots/'.length));
    else onNavigate(hash);
  };
  const row = (d: BotDecision) => {
    return <button key={d.id} type="button" onClick={() => open(d.id)} className="block w-full rounded-xl border p-3 text-left hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">
    <span className="block text-sm font-medium">{d.proposal.review_summary?.request || d.proposal.question}</span>
    <span className="mt-1 block text-xs text-muted-foreground">{decisionStatusLabel(d)}</span>
  </button>;
  };
  return <aside aria-label="Open questions" className="flex h-full min-h-0 flex-col bg-background">
    <header className="flex shrink-0 items-center gap-2 border-b px-3 py-2 pt-[calc(env(safe-area-inset-top)+0.5rem)] md:pt-2">
      <h2 className="min-w-0 flex-1 text-sm font-semibold">Open questions{pending.length > 0 ? ` · ${pending.length}` : ''}</h2>
      <Button variant="ghost" size="icon" aria-label="Close open questions" onClick={onClose}><X className="size-4" /></Button>
    </header>
    {decisionId ? <div className="min-h-0 flex-1"><Bots key={decisionId} embedded decisionId={decisionId} restricted={restricted} onNavigate={navigateThread} /></div> :
      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto overscroll-contain p-4">
        <p className="text-sm text-muted-foreground">Questions you may have missed. Answer in the conversation or open a question here; either updates the same record.</p>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <section className="space-y-2" aria-label="Needs your input">
          <h3 className="text-sm font-semibold">Needs your input</h3>
          {pending.map(row)}
          {!pending.length && <p className="text-sm text-muted-foreground">{loading ? 'Loading questions…' : error ? 'Questions are temporarily unavailable.' : 'No questions waiting for an answer.'}</p>}
        </section>
        <a className="inline-flex min-h-11 items-center text-sm underline" href="#/bots?view=work">Progress &amp; history</a>
      </div>}
  </aside>;
}
