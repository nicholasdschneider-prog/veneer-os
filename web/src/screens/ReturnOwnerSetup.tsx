import { useEffect, useRef, useState } from 'react';

type Setup = {
  review_hash: string; status: string;
  manifest: { boundary: Record<string, string>; principal_evidence: string; registration_basis: string };
  payload: Record<string, string>;
  receipt: { trust_id?: string; source_id?: string; owner_id: number; account_id: string; request_key: string; created_at: string } | null;
};
async function request(endpoint: string, body?: unknown): Promise<Setup> {
  const response = await fetch(endpoint, { method: body ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
    ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Unable to check owner setup. Sign in and try checking again.');
  return result;
}
export function ReturnOwnerSetup({ candidate = false }: { candidate?: boolean }) {
  const endpoint = candidate ? '/api/bot-communication/autoship-candidates/setup' : '/api/bot-communication/return-exception/setup';
  const [setup, setSetup] = useState<Setup | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [uncertain, setUncertain] = useState(false);
  const lock = useRef(false);
  const mounted = useRef(true);
  async function check() {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError('');
    try { const value = await request(endpoint); if (mounted.current) { setSetup(value); setUncertain(false); } }
    catch (e) { if (mounted.current) { setSetup(null); setError((e as Error).message); } }
    finally { lock.current = false; if (mounted.current) setBusy(false); }
  }
  useEffect(() => { mounted.current = true; void check(); return () => { mounted.current = false; }; }, []);
  async function confirm() {
    if (!setup || lock.current || uncertain) return;
    lock.current = true; setBusy(true); setError('');
    try { const value = await request(endpoint, { review_hash: setup.review_hash, confirm: true }); if (mounted.current) setSetup(value); }
    catch { if (mounted.current) { setUncertain(true); setError('We could not confirm the result. Check registration status before doing anything else. This check does not submit another registration.'); } }
    finally { lock.current = false; if (mounted.current) setBusy(false); }
  }
  const button = 'min-h-11 rounded-xl bg-blue-600 px-5 py-3 text-sm font-semibold text-white hover:bg-blue-700 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-blue-500 disabled:opacity-50';
  return <main className="mx-auto w-full max-w-2xl space-y-6 p-5 pb-16 sm:p-8">
    <header className="space-y-2"><p className="text-sm text-zinc-500">Elkhart RV Parts · Owner setup</p><h1 className="text-2xl font-semibold">{candidate ? 'Connect AutoShip candidate notifications' : 'Connect the prepared return service'}</h1><p className="text-zinc-600 dark:text-zinc-300">{candidate ? 'Confirm the prepared connection that notifies the existing AutoShip worker about order and stock candidates.' : 'Confirm the connection prepared for Avery’s return-window exception workflow.'}</p></header>
    <section className="space-y-3 rounded-2xl border border-zinc-200 p-5 dark:border-zinc-700">
      <h2 className="font-semibold">What you’re confirming</h2>
      <p>{candidate ? 'Connect OrderOps Production to the existing AutoShip worker using a separate candidate-only service identity.' : 'Connect Avery to the dedicated OrderOps Production return verifier, using the reviewed source account and service identity.'}</p>
      <p className="text-sm text-zinc-600 dark:text-zinc-300">{candidate ? 'This registers notifications only. It does not ship an order, buy a label or grant shipping permission. OrderOps still checks current eligibility and duplicate prevention. The source operator must finish configuration and acceptance.' : 'This saves the setup only. It does not issue a label, refund, customer message or return. Your existing customer approval stays unchanged. The source operator still needs to finish the connection and acceptance checks.'}</p>
      <p className="text-sm">Only the current signed-in business owner can confirm.</p>
    </section>
    {error && <p role="alert" className="rounded-xl border border-amber-400 p-4 text-sm">{error}</p>}
    <div aria-live="polite">
      {busy && <p role="status">{setup ? 'Checking the registration…' : 'Checking owner access…'}</p>}
      {!busy && setup?.status === 'registered' && !uncertain && <section className="space-y-3 rounded-2xl border border-green-500 p-5"><h2 className="font-semibold">Setup confirmed</h2><p>Share this nonsecret receipt with Platform Dev so the source operator can finish the connection.</p><label className="block text-sm font-medium" htmlFor="trust-receipt">Registration receipt</label><textarea id="trust-receipt" readOnly rows={5} className="w-full rounded-lg border border-zinc-300 bg-transparent p-3 text-sm dark:border-zinc-600" value={JSON.stringify(setup.receipt, null, 2)} /><p className="text-sm">No customer action has been performed by this setup.</p></section>}
      {!busy && setup?.status === 'revoked' && <p role="alert">This registration was revoked. Contact Platform Dev; it cannot be reactivated here.</p>}
    </div>
    {(uncertain || (!busy && !setup)) ? <button className={button} disabled={busy} onClick={() => void check()}>Check registration status</button>
      : setup?.status === 'ready' && <button className={button} disabled={busy} onClick={() => void confirm()}>{candidate ? 'Confirm candidate notifications' : 'Confirm return service setup'}</button>}
    {setup && <details className="rounded-xl border border-zinc-200 p-4 dark:border-zinc-700"><summary className="cursor-pointer py-1 font-medium">Prepared connection details</summary><div className="mt-4 space-y-3 text-sm"><p>{setup.manifest.registration_basis}</p><p>{setup.manifest.principal_evidence}</p><pre className="whitespace-pre-wrap break-all">{JSON.stringify({ boundary: setup.manifest.boundary, registration: setup.payload, review_hash: setup.review_hash }, null, 2)}</pre></div></details>}
    <a className="inline-block py-3 text-sm text-blue-600 underline dark:text-blue-400" href={candidate ? '#/bot-guide?feature=autoship-candidate-setup' : '#/bot-guide?feature=return-owner-setup'}>Read the setup guide</a>
  </main>;
}
