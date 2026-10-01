import { useEffect, useRef, useState } from 'react';

export type MergeSetupStatus = {
  configured: boolean;
  registrations: { id: string; enrolled: boolean; enrolledAt: string | null; expiresAt: string; reviewerName: string; executorName: string }[];
};

const button = 'min-h-11 rounded-xl bg-blue-600 px-5 py-3 text-sm font-semibold text-white hover:bg-blue-700 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-blue-500 disabled:opacity-50';
const card = 'space-y-3 rounded-2xl border border-zinc-200 p-5 dark:border-zinc-700';

function when(value: string | null) {
  if (!value) return '';
  const date = new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(value) ? value : value.replace(' ', 'T') + 'Z');
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** Presentation only: what the owner sees for each state. */
export function TicketMergeStatus({ status, busy, error, justTurnedOn, onTurnOn }: { status: MergeSetupStatus | null; busy: boolean; error: string; justTurnedOn: boolean; onTurnOn: (id: string) => void }) {
  if (!status) return <p className="text-sm text-zinc-600 dark:text-zinc-300">{error || 'Checking…'}</p>;
  if (!status.configured) return <section className={card}><h2 className="font-semibold">Not set up yet</h2><p className="text-sm">Ticket merging has not been prepared for this business. There is nothing to turn on.</p></section>;
  return <>{status.registrations.map(r => r.enrolled
    ? <section key={r.id} className="space-y-2 rounded-2xl border border-green-500 p-5">
      <h2 className="font-semibold">On{r.enrolledAt ? ` since ${when(r.enrolledAt)}` : ''}</h2>
      <p className="text-sm">{justTurnedOn ? 'On. OrderOps can now ask for merge approvals.' : 'OrderOps can ask for merge approvals.'} {r.executorName} raises each merge question and {r.reviewerName} can cancel an unused approval.</p>
    </section>
    : <section key={r.id} className={card}>
      <h2 className="font-semibold">Off</h2>
      <p className="text-sm">When you turn this on, {r.executorName} can ask you to approve merging two tickets, one pair at a time.</p>
      <button type="button" className={button} disabled={busy} onClick={() => onTurnOn(r.id)}>{busy ? 'Turning on…' : 'Turn on ticket merging'}</button>
    </section>)}
    {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
  </>;
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
  return <main className="mx-auto max-w-2xl space-y-5 p-5">
    <h1 className="text-xl font-semibold">Turn on ticket merging</h1>
    <p className="text-sm text-zinc-600 dark:text-zinc-300">Customers often write in more than once about the same problem, by email, text and voicemail. This lets OrderOps combine those duplicate tickets into one, but only after a person approves each merge. Nothing merges automatically, and only the business owner can switch this on.</p>
    <TicketMergeStatus status={status} busy={busy} error={error} justTurnedOn={justTurnedOn} onTurnOn={id => void turnOn(id)} />
    <a className="inline-block py-3 text-sm text-blue-600 underline dark:text-blue-400" href="#/bot-guide?feature=merge-questions">How merge approvals work</a>
  </main>;
}
