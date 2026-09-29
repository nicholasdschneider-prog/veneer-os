import { useEffect, useRef, useState } from 'react';

export type StandingSetup = {
  business_id: string; status: 'not_enrolled' | 'enrolled' | 'revoked' | 'inactive';
  review_hash: string; expected_version: number; default_daily_cap: number;
  template: { key: string; title: string; channel: string; body: string };
  limits: string[];
  candidates: Array<{ conversation_id: string; name: string; subteam: string }>;
  policy: { id: string; version: number; daily_cap: number; created_at: string;
    executors: Array<{ conversation_id: string; name: string }>; revoked: { reason: string; created_at: string } | null } | null;
  sent_with_receipt: number; used_today: number;
};

const button = 'min-h-11 rounded-xl bg-blue-600 px-5 py-3 text-sm font-semibold text-white hover:bg-blue-700 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-blue-500 disabled:opacity-50';
const quiet = 'min-h-11 rounded-xl border border-zinc-300 px-5 py-3 text-sm font-semibold hover:bg-zinc-50 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-blue-500 disabled:opacity-50 dark:border-zinc-600 dark:hover:bg-zinc-800';
const card = 'space-y-3 rounded-2xl border border-zinc-200 p-5 dark:border-zinc-700';

export function StandingReview({ setup }: { setup: StandingSetup }) {
  return <section className={card}>
    <h2 className="font-semibold">The exact message</h2>
    <p className="text-sm text-zinc-600 dark:text-zinc-300">Sent by email on the customer’s existing ticket. Bots cannot change a word of it.</p>
    <blockquote className="whitespace-pre-line border-l-2 pl-4 text-sm">{setup.template.body}</blockquote>
    <h2 className="pt-2 font-semibold">Limits</h2>
    <ul className="list-disc space-y-1 pl-5 text-sm">{setup.limits.map(limit => <li key={limit}>{limit}</li>)}</ul>
  </section>;
}

export function StandingStatus({ setup }: { setup: StandingSetup }) {
  if (!setup.policy) return null;
  const names = setup.policy.executors.map(e => e.name).join(', ');
  if (setup.status === 'enrolled') return <section className="space-y-2 rounded-2xl border border-green-500 p-5">
    <h2 className="font-semibold">Standing authority is on</h2>
    <p className="text-sm">{names} may send this request without asking you. Daily limit {setup.policy.daily_cap}; {setup.used_today} used today; {setup.sent_with_receipt} sent with a receipt so far.</p>
  </section>;
  return <section className="space-y-2 rounded-2xl border border-zinc-400 p-5">
    <h2 className="font-semibold">Standing authority is off</h2>
    <p className="text-sm">{setup.policy.revoked ? `Version ${setup.policy.version} was stopped: ${setup.policy.revoked.reason}` : `Version ${setup.policy.version} is no longer active.`} Bots need your approval for every message until you authorize a new version.</p>
  </section>;
}

async function request(path: string, body?: unknown): Promise<StandingSetup> {
  const response = await fetch('/api/bot-communication/cs-standing-policy' + path, {
    method: body ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
    ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Unable to check the photo request setup.');
  return result;
}

export function CsPhotoRequestSetup() {
  const [setup, setSetup] = useState<StandingSetup | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [cap, setCap] = useState(20);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [uncertain, setUncertain] = useState(false);
  const lock = useRef(false);
  const mounted = useRef(true);
  // One key per page visit: a repeated confirmation replays instead of enrolling twice.
  const requestKey = useRef(`owner-enroll-${crypto.randomUUID()}`);
  const business = new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('business');
  const query = business ? `?business_id=${encodeURIComponent(business)}` : '';

  async function check() {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError('');
    try { const value = await request(query); if (mounted.current) { setSetup(value); setUncertain(false); } }
    catch (e) { if (mounted.current) { setSetup(null); setError((e as Error).message); } }
    finally { lock.current = false; if (mounted.current) setBusy(false); }
  }
  useEffect(() => { mounted.current = true; void check(); return () => { mounted.current = false; }; }, []);

  async function act(path: string, body: unknown, failure: string) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError('');
    try { const value = await request(path, body); if (mounted.current) { setSetup(value); setReason(''); requestKey.current = `owner-enroll-${crypto.randomUUID()}`; } }
    catch (e) {
      if (!mounted.current) return;
      const message = (e as Error).message;
      // A server refusal is certain. Anything else may have been recorded.
      if (message && message !== 'Failed to fetch') setError(message);
      else { setUncertain(true); setError(failure); }
    }
    finally { lock.current = false; if (mounted.current) setBusy(false); }
  }
  const canEnroll = !!setup && setup.status !== 'enrolled' && selected.length > 0 && cap >= 1 && cap <= 200 && !uncertain;

  return <main className="h-full overflow-y-auto mx-auto w-full max-w-2xl space-y-6 p-5 pb-16 sm:p-8">
    <header className="space-y-2">
      <p className="text-sm text-zinc-500">Customer service · Owner setup</p>
      <h1 className="text-2xl font-semibold">Let bots request a product-label photo</h1>
      <p className="text-zinc-600 dark:text-zinc-300">Authorize one fixed message so the bots you name can send it without asking you each time. Every other message still needs your approval.</p>
    </header>
    {error && <p role="alert" className="rounded-xl border border-amber-400 p-4 text-sm">{error}</p>}
    <div aria-live="polite">{busy && !setup && <p role="status">Checking setup…</p>}</div>
    {setup && <>
      <StandingStatus setup={setup} />
      <StandingReview setup={setup} />
      {setup.status !== 'enrolled' && <section className={card}>
        <h2 className="font-semibold">Who may send it</h2>
        {setup.candidates.length === 0 && <p className="text-sm">No active bots are available in this business.</p>}
        <ul className="space-y-1">{setup.candidates.map(bot => <li key={bot.conversation_id}>
          <label className="flex min-h-11 items-center gap-3 text-sm">
            <input type="checkbox" className="size-5" checked={selected.includes(bot.conversation_id)} disabled={busy}
              onChange={event => setSelected(current => event.target.checked ? [...current, bot.conversation_id] : current.filter(id => id !== bot.conversation_id))} />
            <span>{bot.name}{bot.subteam && <span className="text-zinc-500"> · {bot.subteam}</span>}</span>
          </label>
        </li>)}</ul>
        <label className="block space-y-1 text-sm">
          <span className="font-medium">Most requests per day</span>
          <input type="number" min={1} max={200} value={cap} disabled={busy} onChange={event => setCap(Number(event.target.value))}
            className="block min-h-11 w-32 rounded-xl border border-zinc-300 px-3 dark:border-zinc-600 dark:bg-zinc-900" />
          <span className="block text-zinc-600 dark:text-zinc-300">After this many in one day, bots ask you again until the next day.</span>
        </label>
      </section>}
      {setup.status !== 'enrolled'
        ? <button className={button} disabled={busy || !canEnroll}
            onClick={() => void act('', { business_id: setup.business_id, expected_version: setup.expected_version, request_key: requestKey.current, executor_ids: selected, daily_cap: cap, review_hash: setup.review_hash, confirm: true },
              'The result is uncertain. Check status before trying again; checking does not authorize anything.')}>
            Authorize photo requests</button>
        : <section className={card}>
            <h2 className="font-semibold">Stop photo requests</h2>
            <p className="text-sm">Stopping takes effect at once for every request not yet sent. It cannot be undone; you would authorize a new version to resume.</p>
            <label className="block space-y-1 text-sm"><span className="font-medium">Reason</span>
              <input value={reason} disabled={busy} onChange={event => setReason(event.target.value)} maxLength={2000}
                className="block min-h-11 w-full rounded-xl border border-zinc-300 px-3 dark:border-zinc-600 dark:bg-zinc-900" /></label>
            <button className={quiet} disabled={busy || !reason.trim()}
              onClick={() => void act('/revoke', { policy_id: setup.policy!.id, reason: reason.trim() }, 'The result is uncertain. Check status before trying again.')}>
              Stop photo requests</button>
          </section>}
    </>}
    <button className={quiet} disabled={busy} onClick={() => void check()}>Check status</button>
    <p className="text-sm"><a className="inline-block py-3 text-blue-600 underline dark:text-blue-400" href={business ? `#/cs-readiness?business=${encodeURIComponent(business)}` : '#/cs-readiness'}>What the bots can do today</a>
      <span aria-hidden="true"> · </span><a className="inline-block py-3 text-blue-600 underline dark:text-blue-400" href="#/bot-guide?feature=routine-owner-setup">Read the setup guide</a></p>
  </main>;
}
