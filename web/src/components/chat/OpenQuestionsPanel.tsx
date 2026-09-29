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

export function useChatDecisions(conversationId: string) {
  const [data, setData] = useState<{ conversationId: string; decisions: BotDecision[] } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    setError('');
    if (!conversationId) return;
    let sequence = 0;
    const load = () => { const request = ++sequence; return void botsApi.list('all').then(result => {
      if (active && request === sequence) {
        setData({ conversationId, decisions: result.decisions.filter(d => d.conversation_id === conversationId) });
        setError('');
      }
    }).catch(() => { if (active && request === sequence) setError('Could not refresh open questions.'); }); };
    load();
    const timer = window.setInterval(load, 5000);
    window.addEventListener(CHAT_DECISIONS_CHANGED, load);
    return () => { active = false; window.clearInterval(timer); window.removeEventListener(CHAT_DECISIONS_CHANGED, load); };
  }, [conversationId]);
  return { decisions: data?.conversationId === conversationId ? data.decisions : [], loading: data?.conversationId !== conversationId, error };
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
