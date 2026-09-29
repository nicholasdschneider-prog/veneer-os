import { useRef, useState } from 'react';
import { botsApi, type BotDecision } from '@/lib/bots';
import { decisionStatusLabel } from '@/lib/decisionPresentation';
import { BotProposalSummary } from '../BotProposalSummary';
import { DecisionChoices } from '../DecisionChoices';
import { DecisionImages } from '../DecisionImages';
import { Button } from '../ui/button';
import { CHAT_DECISIONS_CHANGED } from './OpenQuestionsPanel';

/** One proposal, shared by the transcript and the catch-up list. */
export function ChatDecisionCard({ decision: d, unavailable = false }: { decision: BotDecision; unavailable?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [recorded, setRecorded] = useState(false);
  const inFlight = useRef(false);
  const keys = useRef(new Map<string, string>());
  const submit = async (kind: 'choice' | 'handling', choiceId: string) => {
    if (inFlight.current || recorded) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    const key = keys.current.get(`${kind}:${choiceId}`) ?? crypto.randomUUID();
    keys.current.set(`${kind}:${choiceId}`, key);
    try {
      await botsApi.mutate(d.id, kind, {
        expected_version: d.version,
        ...(d.shared_queue ? { expected_handling_revision: d.handling_revision } : {}),
        ...(kind === 'choice' ? { choice_id: choiceId, note: '', scope: 'this_case' } : { action: 'claim' }),
        request_key: key,
      });
      if (kind === 'choice') setRecorded(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      window.dispatchEvent(new Event(CHAT_DECISIONS_CHANGED));
      inFlight.current = false;
      setBusy(false);
    }
  };
  const pending = d.state === 'needs_input' && !recorded;
  return <article aria-label={`Question from ${d.bot_name}`} className="rounded-xl border bg-background p-4 space-y-3 [overflow-wrap:anywhere]">
    <p className="text-sm font-medium">{d.bot_name} · {recorded ? 'Answer recorded' : decisionStatusLabel(d)} · v{d.version}</p>
    {pending ? <>
      <BotProposalSummary decision={d} />
      {!!d.proposal.images?.length && <DecisionImages decision={d} />}
      {d.can_answer ? <>
        <p className="text-sm text-muted-foreground">Choose below or answer in the chat. Applies to this case only.</p>
        <DecisionChoices choices={d.proposal.choices} disabled={busy || unavailable} onChoose={id => void submit('choice', id)} />
      </> : <><p className="text-sm text-muted-foreground">{d.handler_name ? `${d.handler_name} is handling this question.` : 'Waiting for an authorized answer.'}</p>
        {!d.handler_id && d.can_handle && <Button disabled={busy || unavailable} onClick={() => void submit('handling', 'claim')}>Handle this question</Button>}
      </>}
    </> : <>
      <p>{d.proposal.review_summary?.request || d.proposal.question}</p>
      <p className="text-sm text-muted-foreground">{d.answer?.choice_label || d.answer?.action || 'Your answer was saved.'}{d.answer?.text ? ` · ${d.answer.text}` : ''}</p>
    </>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <a className="inline-flex min-h-11 items-center text-sm underline" href={`#/bots/${encodeURIComponent(d.id)}`}>Details &amp; history</a>
  </article>;
}
