import { useEffect, useRef, useState } from 'react';

export type ReadinessCapability = {
  id: string; title: string; summary: string; state: string; state_label: string; authority: string;
  blockers: Array<{ owner: string; dependency: string }>; evidence: string[]; tests: string[];
};
export type Readiness = { business_id: string; as_of: string; capabilities: ReadinessCapability[]; autonomous: string[]; notice: string };

const tone: Record<string, string> = {
  live: 'border-green-500 text-green-700 dark:text-green-400',
  live_for_pilot: 'border-green-500 text-green-700 dark:text-green-400',
  tested: 'border-blue-500 text-blue-700 dark:text-blue-400',
  blocked_on_integration: 'border-amber-500 text-amber-700 dark:text-amber-400',
  awaiting_owner: 'border-blue-500 text-blue-700 dark:text-blue-400',
  paused: 'border-zinc-400 text-zinc-600 dark:text-zinc-300',
  draft: 'border-zinc-300 text-zinc-600 dark:border-zinc-600 dark:text-zinc-300',
};

export function ReadinessList({ readiness }: { readiness: Readiness }) {
  const working = readiness.capabilities.filter(c => c.state === 'live' || c.state === 'live_for_pilot');
  return <div className="space-y-6">
    <section className="rounded-2xl border border-zinc-200 p-5 dark:border-zinc-700">
      <h2 className="font-semibold">{readiness.autonomous.length
        ? `${readiness.autonomous.length} task${readiness.autonomous.length === 1 ? '' : 's'} can run without per-message approval`
        : 'No task runs without your approval yet'}</h2>
      <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-300">{working.length} of {readiness.capabilities.length} capabilities are working today. Checked {new Date(readiness.as_of).toLocaleString()}.</p>
    </section>
    <ul className="space-y-4">
      {readiness.capabilities.map(c => <li key={c.id} className="space-y-3 rounded-2xl border border-zinc-200 p-5 dark:border-zinc-700">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <h3 className="font-semibold">{c.title}</h3>
          <span className={`rounded-full border px-3 py-1 text-xs font-semibold ${tone[c.state] ?? tone.draft}`}>{c.state_label}</span>
        </div>
        <p className="text-sm">{c.summary}</p>
        {c.blockers.length > 0 && <div className="space-y-2">
          <h4 className="text-sm font-semibold">What is blocking it</h4>
          <ol className="list-decimal space-y-2 pl-5 text-sm">
            {c.blockers.map((b, i) => <li key={i}><span className="font-medium">{b.owner}:</span> {b.dependency}</li>)}
          </ol>
        </div>}
        <details className="text-sm">
          <summary className="cursor-pointer py-2 font-medium">Authority and evidence</summary>
          <dl className="mt-2 space-y-2">
            <div><dt className="font-medium">Authority</dt><dd>{c.authority}</dd></div>
            <div><dt className="font-medium">Recorded evidence</dt>{c.evidence.map((e, i) => <dd key={i}>{e}</dd>)}</div>
            <div><dt className="font-medium">Automated tests</dt><dd>{c.tests.length ? c.tests.join(', ') : 'None yet.'}</dd></div>
          </dl>
        </details>
      </li>)}
    </ul>
    <p className="text-sm text-zinc-600 dark:text-zinc-300">{readiness.notice}</p>
  </div>;
}

export function CsReadiness() {
  const [readiness, setReadiness] = useState<Readiness | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const mounted = useRef(true);
  async function check() {
    setBusy(true); setError('');
    try {
      const business = new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('business');
      const response = await fetch('/api/bot-communication/cs-readiness' + (business ? `?business_id=${encodeURIComponent(business)}` : ''), { credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Unable to check customer service readiness.');
      if (mounted.current) setReadiness(result);
    } catch (e) { if (mounted.current) { setReadiness(null); setError((e as Error).message); } }
    finally { if (mounted.current) setBusy(false); }
  }
  useEffect(() => { mounted.current = true; void check(); return () => { mounted.current = false; }; }, []);
  return <main className="h-full overflow-y-auto mx-auto w-full max-w-2xl space-y-6 p-5 pb-16 sm:p-8">
    <header className="space-y-2">
      <p className="text-sm text-zinc-500">Customer service</p>
      <h1 className="text-2xl font-semibold">What the bots can do today</h1>
      <p className="text-zinc-600 dark:text-zinc-300">Each task shows whether it works now and, if it does not, who has to do what next.</p>
    </header>
    {error && <p role="alert" className="rounded-xl border border-amber-400 p-4 text-sm">{error}</p>}
    <div aria-live="polite">{busy && !readiness && <p role="status">Checking readiness…</p>}</div>
    {readiness && <ReadinessList readiness={readiness} />}
    <button className="min-h-11 rounded-xl bg-blue-600 px-5 py-3 text-sm font-semibold text-white hover:bg-blue-700 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-blue-500 disabled:opacity-50" disabled={busy} onClick={() => void check()}>Check again</button>
    <a className="block py-3 text-sm text-blue-600 underline dark:text-blue-400" href="#/bot-guide?feature=cs-readiness">Read the guide</a>
  </main>;
}
