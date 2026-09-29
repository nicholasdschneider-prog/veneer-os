import { useEffect, useState } from 'react';
import { MessageCircleQuestion, X } from 'lucide-react';
import { botsApi, type BotDecision } from '@/lib/bots';
import { decisionSection, decisionStatusLabel } from '@/lib/decisionPresentation';
import { withSideParam } from '@/lib/sideChat';
import { useBotCommunication } from '../BotCommunication';
import { Button } from '../ui/button';
import { Bots } from '../../screens/Bots';

export function questionsForConversation(decisions: BotDecision[], conversationId: string) {
  return decisions.filter(d => d.conversation_id === conversationId && decisionSection(d) !== 'history');
}

function useChatQuestions(conversationId: string) {
  const [data, setData] = useState<{ conversationId: string; decisions: BotDecision[] } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    setError('');
    const load = () => void botsApi.list('all').then(result => {
      if (active) {
        setData({ conversationId, decisions: questionsForConversation(result.decisions, conversationId) });
        setError('');
      }
    }).catch(() => { if (active) setError('Could not refresh open questions.'); });
    load();
    const timer = window.setInterval(load, 5000);
    return () => { active = false; window.clearInterval(timer); };
  }, [conversationId]);
  return { decisions: data?.conversationId === conversationId ? data.decisions : [], loading: data?.conversationId !== conversationId, error };
}

export function OpenQuestionsButton({ conversationId, onNavigate }: { conversationId: string; onNavigate: (hash: string) => void }) {
  const { decisions, error } = useChatQuestions(conversationId);
  const pending = decisions.filter(d => d.state === 'needs_input').length;
  return <Button variant="ghost" size="sm" className="min-h-11 shrink-0 gap-1 rounded-full" aria-label={`Open questions${pending ? `, ${pending} pending` : ''}${error ? ', refresh unavailable' : ''}`} title="Open questions and follow-through" onClick={() => onNavigate(withSideParam(window.location.hash, 'questions'))}>
    <MessageCircleQuestion className="size-4" aria-hidden="true" />
    <span className="hidden sm:inline">Questions</span>
    {pending > 0 && <span className="rounded-full bg-amber-500 px-1.5 text-xs font-semibold text-black tabular-nums">{pending}</span>}
    {error && <span aria-hidden="true">!</span>}
  </Button>;
}

export function OpenQuestionsPanel({ conversationId, decisionId, restricted = false, onClose, onNavigate }: {
  conversationId: string; decisionId?: string; restricted?: boolean; onClose: () => void; onNavigate: (hash: string) => void;
}) {
  const { decisions, loading, error } = useChatQuestions(conversationId);
  const communication = useBotCommunication(conversationId);
  const obligations = communication.data.approved_obligations ?? [];
  const pending = decisions.filter(d => d.state === 'needs_input');
  const followThrough = decisions.filter(d => d.state !== 'needs_input');
  const open = (id?: string) => onNavigate(withSideParam(window.location.hash, id ? `decision:${id}` : 'questions'));
  const navigateThread = (hash: string) => {
    if (hash === '#/bots') open();
    else if (hash.startsWith('#/bots/')) open(hash.slice('#/bots/'.length));
    else onNavigate(hash);
  };
  const row = (d: BotDecision) => {
    const obligation = obligations.find(o => o.decision_id === d.id);
    return <button key={d.id} type="button" onClick={() => open(d.id)} className="block w-full rounded-xl border p-3 text-left hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">
    <span className="block text-sm font-medium">{d.proposal.review_summary?.request || d.proposal.question}</span>
    <span className="mt-1 block text-xs text-muted-foreground">{decisionStatusLabel(d)}</span>
    {obligation && <span className="mt-2 block text-xs text-muted-foreground">Original approved message · v{obligation.version}: {obligation.reason}</span>}
  </button>;
  };
  return <aside aria-label="Open questions" className="flex h-full min-h-0 flex-col bg-background">
    <header className="flex shrink-0 items-center gap-2 border-b px-3 py-2 pt-[calc(env(safe-area-inset-top)+0.5rem)] md:pt-2">
      <h2 className="min-w-0 flex-1 text-sm font-semibold">Open questions{pending.length > 0 ? ` · ${pending.length}` : ''}</h2>
      <Button variant="ghost" size="icon" aria-label="Close open questions" onClick={onClose}><X className="size-4" /></Button>
    </header>
    {decisionId ? <div className="min-h-0 flex-1"><Bots key={decisionId} embedded decisionId={decisionId} restricted={restricted} onNavigate={navigateThread} /></div> :
      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto overscroll-contain p-4">
        <p className="text-sm text-muted-foreground">Discuss and answer questions here. Pending decisions stay with this chat until answered.</p>
        {(error || communication.error) && <p role="alert" className="text-sm text-destructive">{error || communication.error}</p>}
        <section className="space-y-2" aria-label="Needs your input">
          <h3 className="text-sm font-semibold">Needs your input</h3>
          {pending.map(row)}
          {!pending.length && <p className="text-sm text-muted-foreground">{loading ? 'Loading questions…' : error ? 'Questions are temporarily unavailable.' : 'No questions waiting for an answer.'}</p>}
        </section>
        <section className="space-y-2" aria-label="Follow-through">
          <h3 className="text-sm font-semibold">Follow-through</h3>
          <p className="text-xs text-muted-foreground">Answered, deferred, and blocked work stays tracked here. Approval does not mean completion.</p>
          {followThrough.map(row)}
          {obligations.filter(o => !decisions.some(d => d.id === o.decision_id)).map(o => <button key={o.decision_id} onClick={() => open(o.decision_id)} className="block w-full space-y-1 rounded-xl border p-3 text-left text-sm hover:bg-muted">
            <span className="block font-medium">Approved message · {o.ready ? 'awaiting delegation' : 'blocked'}</span>
            <span className="block text-xs text-muted-foreground">{o.reason}</span>
            <span className="block text-xs text-muted-foreground">Original approval · version {o.version}</span>
          </button>)}
          {!loading && !error && !followThrough.length && !obligations.length && <p className="text-sm text-muted-foreground">No outstanding follow-through.</p>}
        </section>
      </div>}
  </aside>;
}
