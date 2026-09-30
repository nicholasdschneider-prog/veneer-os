import { useRef, useState } from 'react';
import { botsApi, type BotDecision } from '@/lib/bots';
import { decisionCopy, decisionStatusLabel } from '@/lib/decisionPresentation';
import { BotProposalSummary } from '../BotProposalSummary';
import { DecisionChoices } from '../DecisionChoices';
import { DecisionImages } from '../DecisionImages';
import { Button } from '../ui/button';
import { CHAT_DECISIONS_CHANGED } from './OpenQuestionsPanel';

/**
 * One proposal, shared by the transcript and the catch-up list. Shaped like a
 * question a colleague would ask: the question, what the bot found and what a
 * tap does or does not do, researched options, then the human's own answer.
 */
export function ChatDecisionCard({ decision: d, unavailable = false }: { decision: BotDecision; unavailable?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [recorded, setRecorded] = useState(false);
  const inFlight = useRef(false);
  const keys = useRef(new Map<string, string>());
  const submit = async (kind: 'choice' | 'handling' | 'custom', value: string) => {
    if (inFlight.current || recorded) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    const key = keys.current.get(`${kind}:${value}`) ?? crypto.randomUUID();
    keys.current.set(`${kind}:${value}`, key);
    try {
      await botsApi.mutate(d.id, kind, {
        expected_version: d.version,
        ...(d.shared_queue ? { expected_handling_revision: d.handling_revision } : {}),
        ...(kind === 'choice' ? { choice_id: value, note: '', scope: 'this_case' } : kind === 'custom' ? { text: value } : { action: 'claim' }),
        request_key: key,
      });
      if (kind !== 'handling') setRecorded(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      window.dispatchEvent(new Event(CHAT_DECISIONS_CHANGED));
      inFlight.current = false;
      setBusy(false);
    }
  };
  const pending = d.state === 'needs_input' && !recorded;
  const summary = d.proposal.review_summary;
  const copy = decisionCopy(d.proposal);
  const exact = !!(d.proposal.message_delivery || d.proposal.contact_verification || copy.draft);
  const found = [summary?.request && summary.request !== d.proposal.question ? summary.request : '', ...(summary?.background ?? [])].filter(Boolean);
  return <article aria-label={`Question from ${d.bot_name}`} className="rounded-xl border bg-background p-4 space-y-3 [overflow-wrap:anywhere]">
    <p className="text-sm font-medium">{d.bot_name} · {recorded ? 'Answer recorded' : decisionStatusLabel(d)} · v{d.version}</p>
    {pending ? <>
      <h3 className="text-base font-semibold leading-snug">{d.proposal.question}</h3>
      {found.length > 0 && <div className="text-sm text-muted-foreground space-y-1">{found.map((line, i) => <p key={i}>{line}</p>)}</div>}
      <p className="text-sm text-muted-foreground">{copy.limits}</p>
      {exact && <BotProposalSummary decision={d} inline hideDetails />}
      {!!d.proposal.images?.length && <DecisionImages decision={d} />}
      {d.can_answer ? <>
        <DecisionChoices choices={d.proposal.choices} disabled={busy || unavailable} onChoose={id => void submit('choice', id)} onCustom={text => void submit('custom', text)} />
        <p className="text-sm text-muted-foreground">Or answer in the chat below. Applies to this case only.</p>
      </> : <><p className="text-sm text-muted-foreground">{d.handler_name ? `${d.handler_name} is handling this question.` : 'Waiting for an authorized answer.'}</p>
        {!d.handler_id && d.can_handle && <Button disabled={busy || unavailable} onClick={() => void submit('handling', 'claim')}>Handle this question</Button>}
      </>}
    </> : <>
      <p>{summary?.request || d.proposal.question}</p>
      <p className="text-sm text-muted-foreground">{d.answer?.choice_label || d.answer?.action || 'Your answer was saved.'}{d.answer?.text ? ` · ${d.answer.text}` : ''}</p>
    </>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <a className="inline-flex min-h-11 items-center text-sm underline" href={`#/bots/${encodeURIComponent(d.id)}`}>Details &amp; history</a>
  </article>;
}
