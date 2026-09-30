import { ContactVerificationProposal } from './ContactVerificationProposal';
import { useId, useState } from 'react';
import type { BotDecision } from '@/lib/bots';
import { decisionCopy } from '@/lib/decisionPresentation';

function Background({ bullets }: { bullets: string[] }) {
  const id = useId();
  const [hover, setHover] = useState(false);
  const [pinned, setPinned] = useState(false);
  const open = hover || pinned;
  return <div className="relative w-full min-w-0" onPointerEnter={e => { if (e.pointerType === 'mouse') setHover(true); }} onPointerLeave={() => setHover(false)} onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget)) { setPinned(false); setHover(false); } }} onKeyDown={e => { if (e.key === 'Escape') { setPinned(false); setHover(false); } }}>
    <button type="button" className="min-h-[44px] rounded-lg border px-3 text-sm focus-visible:outline focus-visible:outline-ring" aria-expanded={open} aria-controls={id} onClick={() => { setPinned(!pinned); setHover(false); }}>Background</button>
    {open && <div id={id} role="region" aria-label="Background" className="absolute left-0 top-full z-20 max-h-72 w-full max-w-md overflow-y-auto rounded-xl border bg-popover p-4 text-popover-foreground shadow-lg">
      <ul className="list-disc space-y-2 pl-4 text-sm leading-6">{(bullets.length ? bullets : ['A short background summary was not supplied. Original details retain the full recommendation.']).map((bullet, i) => <li key={i}>{bullet}</li>)}</ul>
    </div>}
  </div>;
}

/** Display only: raw scope and approval remain in the unchanged versioned proposal. */
export function BotProposalSummary({ decision, showIdentifiers = false, compact = false, hideDetails = false, editingReply = false, inline = false }: { decision: BotDecision; showIdentifiers?: boolean; compact?: boolean; hideDetails?: boolean; editingReply?: boolean; inline?: boolean }) {
  // Both surfaces expose the exact reply; compact affects the containing card, not evidence.
  void compact;
  const proposal = decision.proposal;
  const delivery = proposal.message_delivery;
  const copy = decisionCopy(proposal);
  const summary = proposal.review_summary;
  const refund = summary?.refund;
  const draft = delivery?.payload.body ?? copy.draft;
  // Legacy summaries required refund status even for operational work. Do not
  // turn that forced unknown into a refund concern; retain all sourced history.
  const showRefund = refund && (refund.status !== 'not_verified' || !!draft || !!summary?.request);
  const action = summary?.action_title || (copy.proposedAction.length <= 240 ? copy.proposedAction : 'Review the recommended action in Original details.');
  return <div className="space-y-4 text-base sm:text-sm [overflow-wrap:anywhere]">
    {!inline && <dl className="space-y-2 rounded-xl bg-muted/40 p-3">
      <div><dt className="font-medium">What the bot needs from you</dt><dd className="whitespace-pre-wrap text-muted-foreground">{summary?.request || proposal.question}</dd></div>
      {summary?.customer_request && <div><dt className="font-medium">{draft || summary.request ? 'Customer request' : 'Context'}</dt><dd className="whitespace-pre-wrap text-muted-foreground">{summary.customer_request}</dd></div>}
      {showRefund && <div><dt className="inline font-medium">Already refunded? </dt><dd className="inline font-semibold">{!refund || refund.status === 'not_verified' ? 'Not verified' : refund.status === 'none' ? 'NO' : refund.status === 'partial' ? 'PARTIAL' : 'YES'}</dd></div>}
      {refund && refund.status !== 'not_verified' && <div className="text-sm text-muted-foreground">
        {refund.status !== 'none' && <p>{refund.amount} {refund.currency} · Completed refund receipt: {refund.receipt}</p>}
        <p>Scope: {refund.scope}</p><p>Source: {refund.source}</p><p>Checked as of: <time dateTime={refund.as_of}>{refund.as_of}</time></p>
      </div>}
    </dl>}
    {proposal.contact_verification && <ContactVerificationProposal manifest={proposal.contact_verification} />}
    {draft ? <section className="space-y-2 rounded-xl border p-3" aria-label="Proposed customer reply">
      <h3 className="font-medium">{delivery ? 'Exact customer message to authorize' : 'Proposed customer reply'}</h3>
      {delivery?.payload.subject && <p className="text-sm">Subject: {delivery.payload.subject}</p>}
      <div className="whitespace-pre-wrap leading-6">{editingReply ? 'Editing below. The saved reply stays unchanged until you save a new version.' : draft}</div>
    </section> : !inline && <section className="space-y-1" aria-label="Recommended action"><h3 className="font-medium">Recommended action</h3><p className="whitespace-pre-wrap leading-6">{action}</p></section>}
    {!inline && <div className="space-y-1 border-l-2 border-foreground/15 pl-3"><h3 className="font-medium">Impact &amp; limits</h3><p className="whitespace-pre-wrap leading-6">{copy.limits}</p></div>}
    {!inline && <Background bullets={summary?.background ?? []} />}
    {!hideDetails && <BotProposalDetails decision={decision} showIdentifiers={showIdentifiers} />}
  </div>;
}

export function BotProposalDetails({decision,showIdentifiers=false}:{decision:BotDecision;showIdentifiers?:boolean}) {
  const proposal=decision.proposal, delivery=proposal.message_delivery, copy=decisionCopy(proposal);
  const action=proposal.review_summary?.action_title || (copy.proposedAction.length <= 240 ? copy.proposedAction : 'Review the recommended action in Original details.');
  return <div className="space-y-4">
    {delivery && <details className="rounded-lg border p-3">
      <summary className="cursor-pointer min-h-[44px] font-medium focus-visible:outline focus-visible:outline-ring">Message scope &amp; delivery details</summary>
      <p>Approval includes this one message through the named executor. It does not authorize other customer contact or financial actions.</p>
      <dl className="space-y-1">
        <div><dt className="inline font-medium">Channel / account: </dt><dd className="inline">{delivery.payload.channel} · {delivery.payload.account}</dd></div>
        <div><dt className="inline font-medium">To: </dt><dd className="inline">{delivery.payload.recipients.join(', ')}</dd></div>
        <div><dt className="inline font-medium">Customer / case: </dt><dd className="inline">{delivery.payload.customer} · {delivery.canonical_case}</dd></div>
        <div><dt className="inline font-medium">Named executor: </dt><dd className="inline">{delivery.executor_conversation_id}</dd></div>
        <div><dt className="font-medium">Attachments</dt><dd>{delivery.payload.attachments.length ? delivery.payload.attachments.map((a,i)=><p key={i}>{a.name} · {a.reference}<span className="block text-xs text-muted-foreground">SHA-256: {a.sha256}</span></p>) : 'None'}</dd></div>
      </dl>
      {delivery.payload.context && <p className="whitespace-pre-wrap text-muted-foreground">{delivery.payload.context}</p>}
    </details>}
    <details className="border-t border-foreground/10">
      <summary className="cursor-pointer min-h-[44px] py-3 text-muted-foreground focus-visible:outline focus-visible:outline-ring">Original details &amp; conditions</summary>
      <p className="whitespace-pre-wrap pb-3 leading-6">Original question: {proposal.question}</p>
      {copy.proposedAction !== action && <p className="whitespace-pre-wrap pb-3 leading-6 text-muted-foreground">Original recommendation: {copy.proposedAction}</p>}
      <p className="whitespace-pre-wrap pb-3 leading-6 text-muted-foreground">{copy.instructions || 'See the proposed reply above.'}</p>
      {delivery && copy.draft && copy.draft !== delivery.payload.body && <div className="whitespace-pre-wrap pb-3"><p className="font-medium">Additional legacy draft text (not the structured message scope)</p>{copy.draft}</div>}
      {showIdentifiers && <p className="break-all pb-3 text-sm text-muted-foreground">Reference: {decision.id} · Version {decision.version}</p>}
    </details>
  </div>;
}
