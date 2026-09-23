import type { BotDecision } from '@/lib/bots';
import { decisionCopy } from '@/lib/decisionPresentation';

/** Human review copy stays verbatim; execution instructions are a separate disclosure. */
export function BotProposalSummary({ decision, showIdentifiers = false, compact = false }: { decision: BotDecision; showIdentifiers?: boolean; compact?: boolean }) {
  const delivery = decision.proposal.message_delivery;
  const copy = decisionCopy(decision.proposal);
  return <div className="space-y-4 text-base sm:text-sm [overflow-wrap:anywhere]">
    <dl className="space-y-4">
      {!compact && <div className="space-y-1">
        <dt className="font-medium">Proposed action</dt>
        <dd className="whitespace-pre-wrap text-pretty leading-6 text-muted-foreground">{copy.proposedAction}</dd>
      </div>}
      <div className="space-y-1 border-l-2 border-foreground/15 pl-3">
        <dt className="font-medium">Impact & limits</dt>
        <dd className="whitespace-pre-wrap text-pretty leading-6">{copy.limits}</dd>
      </div>
    </dl>
    {compact && <details className="rounded-lg bg-muted/40 px-3">
      <summary className="cursor-pointer py-3 font-medium focus-visible:outline focus-visible:outline-ring">Read recommendation & background</summary>
      <p className="whitespace-pre-wrap pb-4 leading-6 text-muted-foreground">{copy.proposedAction}</p>
    </details>}
    {delivery && <section className="space-y-2 rounded-lg border p-3" aria-label="Exact customer message authorization">
      <h3 className="font-medium">Exact customer message to authorize</h3>
      <p>Approval includes this one message through the named executor. It does not authorize other customer contact or financial actions.</p>
      <dl className="space-y-1">
        <div><dt className="inline font-medium">Channel / account: </dt><dd className="inline">{delivery.payload.channel} · {delivery.payload.account}</dd></div>
        <div><dt className="inline font-medium">To: </dt><dd className="inline">{delivery.payload.recipients.join(', ')}</dd></div>
        <div><dt className="inline font-medium">Customer / case: </dt><dd className="inline">{delivery.payload.customer} · {delivery.canonical_case}</dd></div>
        <div><dt className="inline font-medium">Named executor: </dt><dd className="inline">{delivery.executor_conversation_id}</dd></div>
        <div><dt className="inline font-medium">Subject: </dt><dd className="inline">{delivery.payload.subject || '(none)'}</dd></div>
        <div><dt className="font-medium">Attachments</dt><dd>{delivery.payload.attachments.length ? delivery.payload.attachments.map((a,i)=><p key={i}>{a.name} · {a.reference}<span className="block text-xs text-muted-foreground">SHA-256: {a.sha256}</span></p>) : 'None'}</dd></div>
      </dl>
      <p className="whitespace-pre-wrap">{delivery.payload.body}</p>
      {delivery.payload.context && <p className="whitespace-pre-wrap text-muted-foreground">{delivery.payload.context}</p>}
    </section>}
    {copy.draft && <details className="rounded-lg bg-muted/40 px-3">
      <summary className="cursor-pointer py-3 font-medium focus-visible:outline focus-visible:outline-ring">Read the proposed customer reply</summary>
      <div className="whitespace-pre-wrap pb-4 leading-6">{copy.draft}</div>
    </details>}
    <details className="border-t border-foreground/10">
      <summary className="cursor-pointer py-3 text-muted-foreground focus-visible:outline focus-visible:outline-ring">Full instructions & conditions</summary>
      <p className="whitespace-pre-wrap pb-3 leading-6 text-muted-foreground">{copy.instructions || 'See the proposed reply above.'}</p>
      {showIdentifiers && <p className="break-all pb-3 text-sm text-muted-foreground">Reference: {decision.id} · Version {decision.version}</p>}
    </details>
  </div>;
}
