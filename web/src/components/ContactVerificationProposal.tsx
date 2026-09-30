import type { BotProposal } from '@/lib/bots';

/** Public approved template only; source secrets and rendered links never enter this view. */
export function ContactVerificationProposal({ manifest: m }: { manifest: NonNullable<BotProposal['contact_verification']> }) {
  return <section aria-label="Exact paired contact verification" className="space-y-4 rounded-xl border p-3">
    <h3 className="font-medium">Exact email and SMS to authorize</h3>
    <p className="text-sm text-muted-foreground">Email goes first. Each message contains one independently generated single-use verification link. No other wording or destination may change.</p>
    {m.channels.map(c => <section key={c.channel} aria-label={`Exact ${c.channel} template`} className="space-y-2 border-t pt-3">
      <h4 className="font-medium">{c.channel === 'email' ? 'Email' : 'SMS'}</h4>
      <dl className="space-y-1 text-sm">
        <div><dt className="inline font-medium">Account: </dt><dd className="inline">{c.accountId}</dd></div>
        <div><dt className="inline font-medium">From: </dt><dd className="inline">{c.from}</dd></div>
        <div><dt className="inline font-medium">To: </dt><dd className="inline">{c.recipient}</dd></div>
        {c.subject && <div><dt className="inline font-medium">Subject: </dt><dd className="inline">{c.subject}</dd></div>}
      </dl>
      <div className="whitespace-pre-wrap leading-6">{c.segments.map((s,i) => s.kind === 'literal' ? <span key={i}>{s.text}</span> : <strong key={i}>[Single-use {c.channel} verification link]</strong>)}</div>
      <p className="text-sm text-muted-foreground">Fixed link destination: {c.slot.origin}{c.slot.path}. The secret stays in the URL fragment and is not shown here.</p>
      <p className="text-sm">Attachments: {c.attachments.length ? c.attachments.map(a => `${a.name} · SHA-256 ${a.sha256}`).join('; ') : 'None'}</p>
    </section>)}
    <div className="space-y-1 border-t pt-3"><h4 className="font-medium">Purchaser statement</h4><p className="whitespace-pre-wrap">{m.statement}</p></div>
    <p className="text-sm text-muted-foreground">This authorizes only the exact pair. Contact control is not purchaser identity, a customer-record merge, or financial clearance.</p>
    <details><summary className="min-h-11 cursor-pointer py-3 text-sm">Exact case, customer records, executor and public manifest</summary><pre className="whitespace-pre-wrap break-words text-xs">{JSON.stringify(m,null,2)}</pre></details>
  </section>;
}
