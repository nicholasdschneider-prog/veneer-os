import { useEffect, useRef, useState } from 'react';

export type MergeSetupStatus = {
  configured: boolean;
  registrations: { id: string; enrolled: boolean; enrolledAt: string | null; expiresAt: string; reviewerName: string; executorName: string; standing?: { enabled: boolean; since: string | null }; automaticMerges?: number }[];
};

const button = 'min-h-11 rounded-xl bg-blue-600 px-5 py-3 text-sm font-semibold text-white hover:bg-blue-700 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-blue-500 disabled:opacity-50';
const card = 'space-y-3 rounded-2xl border border-zinc-200 p-5 dark:border-zinc-700';

function when(value: string | null) {
  if (!value) return '';
  const date = new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(value) ? value : value.replace(' ', 'T') + 'Z');
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** Presentation only: what the owner sees for each state. */
export function TicketMergeStatus({ status, busy, error, justTurnedOn, onTurnOn, onStanding }: { status: MergeSetupStatus | null; busy: boolean; error: string; justTurnedOn: boolean; onTurnOn: (id: string) => void; onStanding?: (id: string, enabled: boolean, reason?: string) => void }) {
  if (!status) return <p className="text-sm text-zinc-600 dark:text-zinc-300">{error || 'Checking…'}</p>;
  if (!status.configured) return <section className={card}><h2 className="font-semibold">Not set up yet</h2><p className="text-sm">Ticket merging has not been prepared for this business. There is nothing to turn on.</p></section>;
  return <>{status.registrations.map(r => r.enrolled
    ? <div key={r.id} className="space-y-4">
      <section className="space-y-2 rounded-2xl border border-green-500 p-5">
        <h2 className="font-semibold">On{r.enrolledAt ? ` since ${when(r.enrolledAt)}` : ''}</h2>
        <p className="text-sm">{justTurnedOn ? 'On. Repeat messages now join the customer’s existing ticket.' : 'Repeat messages join the customer’s existing ticket.'}</p>
      </section>
      {r.standing?.enabled
        ? <section className="space-y-2 rounded-2xl border border-green-500 p-5">
          <h2 className="font-semibold">Bots merge clear duplicates on their own{r.standing.since ? ` · since ${when(r.standing.since)}` : ''}</h2>
          <p className="text-sm">When two open tickets share the same customer record and the same order, the bots combine them and log it. No one is asked. {r.automaticMerges ? `${r.automaticMerges} merged this way so far.` : 'None merged this way yet.'} Unclear matches still come to a person.</p>
          {onStanding && <StandingOff busy={busy} onOff={reason => onStanding(r.id, false, reason)} />}
        </section>
        : <section className={card}>
          <h2 className="font-semibold">Let the bots handle the clear ones</h2>
          <p className="text-sm">When two open tickets clearly belong to the same customer and the same order, the bots can combine them on their own and log it. You are not asked. Only unclear matches come to a person.</p>
          <button type="button" className={button} disabled={busy || !onStanding} onClick={() => onStanding?.(r.id, true)}>{busy ? 'Turning on…' : 'Let bots merge clear duplicates on their own'}</button>
        </section>}
    </div>
    : <section key={r.id} className={card}>
      <h2 className="font-semibold">Off</h2>
      <p className="text-sm">Turn this on so repeat messages join the customer’s existing ticket and {r.executorName} can combine duplicate tickets.</p>
      <button type="button" className={button} disabled={busy} onClick={() => onTurnOn(r.id)}>{busy ? 'Turning on…' : 'Turn on ticket merging'}</button>
    </section>)}
    {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
  </>;
}

function StandingOff({ busy, onOff }: { busy: boolean; onOff: (reason: string) => void }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  if (!open) return <button type="button" className="text-sm underline" disabled={busy} onClick={() => setOpen(true)}>Turn off</button>;
  return <div className="space-y-2">
    <label className="block text-sm">Why are you turning this off?
      <input className="mt-1 block w-full rounded-lg border bg-transparent p-2 text-sm" value={reason} onChange={e => setReason(e.target.value)} placeholder="One line is enough" />
    </label>
    <div className="flex gap-3"><button type="button" className="text-sm underline" disabled={busy || !reason.trim()} onClick={() => onOff(reason.trim())}>Turn off</button><button type="button" className="text-sm underline" onClick={() => setOpen(false)}>Cancel</button></div>
  </div>;
}

async function request(path: string, body?: unknown) {
  const response = await fetch('/api/bots/merge-authorization' + path, {
    method: body ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
    ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || 'Unable to check ticket merging.');
  return result;
}

export function TicketMergeSetup() {
  const [status, setStatus] = useState<MergeSetupStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [justTurnedOn, setJustTurnedOn] = useState(false);
  const lock = useRef(false);
  const load = () => request('/status').then(setStatus).catch((e: Error) => setError(e.message));
  useEffect(() => { void load(); }, []);
  const turnOn = async (registrationId: string) => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError('');
    try { await request('/enroll', { registrationId }); setJustTurnedOn(true); await load(); }
    catch (e) { setError((e as Error).message); }
    finally { lock.current = false; setBusy(false); }
  };
  const setStanding = async (registrationId: string, enabled: boolean, reason?: string) => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError('');
    try { await request('/standing', { registrationId, enabled, ...(reason ? { reason } : {}) }); await load(); }
    catch (e) { setError((e as Error).message); }
    finally { lock.current = false; setBusy(false); }
  };
  return <main className="mx-auto max-w-2xl space-y-5 p-5">
    <h1 className="text-xl font-semibold">Ticket merging</h1>
    <ul className="list-disc space-y-1 pl-5 text-sm text-zinc-600 dark:text-zinc-300">
      <li>When a customer with an open ticket writes again from the same email, phone or order, the message goes into that ticket automatically. No one is asked.</li>
      <li>When two separate tickets clearly belong to the same customer and the same order, the bots can combine them on their own.</li>
      <li>Only unclear matches come to a person.</li>
    </ul>
    <p className="text-sm text-zinc-600 dark:text-zinc-300">Only the business owner can switch these on or off.</p>
    <TicketMergeStatus status={status} busy={busy} error={error} justTurnedOn={justTurnedOn} onTurnOn={id => void turnOn(id)} onStanding={(id, enabled, reason) => void setStanding(id, enabled, reason)} />
    <a className="inline-block py-3 text-sm text-blue-600 underline dark:text-blue-400" href="#/bot-guide?feature=merge-questions">How merge approvals work</a>
  </main>;
}
