import { useEffect, useRef, useState } from 'react';

type Setup = {
  review_hash: string; status: string; policy_text: string;
  blockers: Array<{ owner: string; reason: string }>;
  source: { executor_id: string; principal_id: string; adapter_digest: string; registration_reference: string;
    deployment_receipt: string; principal_receipt: string; runtime_receipt: string } | null;
  connection: { account_id: string; source_origin: string };
  receipt: { policy_id: string; trust_id: string; owner_id: number; account_id: string; request_key: string; created_at: string } | null;
};
async function request(body?: unknown): Promise<Setup> {
  const response = await fetch('/api/bot-communication/routine-messages/setup', {
    method: body ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
    ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Unable to check routine reply setup.');
  return result;
}
export function RoutineOwnerSetup() {
  const [setup, setSetup] = useState<Setup | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [uncertain, setUncertain] = useState(false);
  const lock = useRef(false);
  const mounted = useRef(true);
  async function check() {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError('');
    try { const value = await request(); if (mounted.current) { setSetup(value); setUncertain(false); } }
    catch (e) { if (mounted.current) { setSetup(null); setError((e as Error).message); } }
    finally { lock.current = false; if (mounted.current) setBusy(false); }
  }
  useEffect(() => { mounted.current = true; void check(); return () => { mounted.current = false; }; }, []);
  async function confirm() {
    if (!setup || setup.status !== 'ready' || lock.current || uncertain) return;
    lock.current = true; setBusy(true); setError('');
    try { const value = await request({ review_hash: setup.review_hash, confirm: true }); if (mounted.current) setSetup(value); }
    catch { if (mounted.current) { setUncertain(true); setError('The result is uncertain. Check registration status before continuing. This check does not submit another authorization.'); } }
    finally { lock.current = false; if (mounted.current) setBusy(false); }
  }
  const button = 'min-h-11 rounded-xl bg-blue-600 px-5 py-3 text-sm font-semibold text-white hover:bg-blue-700 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-blue-500 disabled:opacity-50';
  return <main className="h-full overflow-y-auto mx-auto w-full max-w-2xl space-y-6 p-5 pb-16 sm:p-8">
    <header className="space-y-2"><p className="text-sm text-zinc-500">Elkhart RV Parts · Owner setup</p><h1 className="text-2xl font-semibold">Allow routine photo requests</h1><p className="text-zinc-600 dark:text-zinc-300">Let the named bot ask for a missing product-label photo without your approval for each email.</p></header>
    <section className="space-y-3 rounded-2xl border border-zinc-200 p-5 dark:border-zinc-700">
      <h2 className="font-semibold">What you’re authorizing</h2>
      <p>The bot may request a product-label photo only when it is missing and needed to answer the customer’s question.</p>
      <p className="text-sm text-zinc-600 dark:text-zinc-300">Current ticket information, recipient, ownership, holds and previous sends must be checked. Refunds, replacements, fit promises and tracking replies are outside this authorization. Delivery requires a verified provider receipt.</p>
      <blockquote className="border-l-2 pl-4 text-sm">To help us understand your question, please provide the following information:<br /><br />Please reply with a clear photo of the product label.<br /><br />Thank you.</blockquote>
      <p className="text-sm">Only the current signed-in business owner can authorize this. Confirmation records standing authority; source activation still requires verified setup.</p>
    </section>
    {error && <p role="alert" className="rounded-xl border border-amber-400 p-4 text-sm">{error}</p>}
    <div aria-live="polite" className="space-y-3">
      {busy && <p role="status">Checking routine reply setup…</p>}
      {!busy && setup?.status === 'blocked' && <section className="space-y-3 rounded-2xl border border-amber-400 p-5"><h2 className="font-semibold">Setup is not ready for authorization</h2><p>No approval is needed from you yet.</p><ul className="list-disc space-y-2 pl-5">{setup.blockers.map(b => <li key={b.owner + b.reason}><strong>{b.owner}:</strong> {b.reason}</li>)}</ul></section>}
      {!busy && setup?.status === 'registered' && !uncertain && <section className="space-y-3 rounded-2xl border border-green-500 p-5"><h2 className="font-semibold">Standing authority recorded</h2><p>Platform Dev can now finish source activation using this receipt. This registration is not a delivery receipt and has not sent a customer message.</p><a className="inline-block min-h-11 py-3 underline" href="#/routine-scope-review">Review existing decision scopes</a><label className="block text-sm font-medium" htmlFor="routine-receipt">Registration receipt</label><textarea id="routine-receipt" readOnly rows={7} className="w-full rounded-lg border border-zinc-300 bg-transparent p-3 text-sm dark:border-zinc-600" value={JSON.stringify(setup.receipt, null, 2)} /></section>}
      {!busy && setup?.status === 'revoked' && <p role="alert">This authority was revoked or superseded. It cannot be reactivated here. Contact Platform Dev.</p>}
    </div>
    {setup?.status === 'ready' && !uncertain ? <button className={button} disabled={busy} onClick={() => void confirm()}>Authorize routine photo requests</button>
      : setup?.status !== 'revoked' && <button className={button} disabled={busy} onClick={() => void check()}>Check registration status</button>}
    {setup && <details className="rounded-xl border border-zinc-200 p-4 dark:border-zinc-700"><summary className="cursor-pointer py-1 font-medium">Policy and connection details</summary><div className="mt-4 space-y-3 text-sm"><p>{setup.policy_text}</p><pre className="whitespace-pre-wrap break-all">{JSON.stringify({ connection: setup.connection, source: setup.source, review_hash: setup.review_hash }, null, 2)}</pre></div></details>}
    <a className="inline-block py-3 text-sm text-blue-600 underline dark:text-blue-400" href="#/bot-guide?feature=routine-owner-setup">Read the setup guide</a>
  </main>;
}
