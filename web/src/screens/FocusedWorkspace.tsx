import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

type Automation = Awaited<ReturnType<typeof api.focusedAutomations>>['automations'][number];

/**
 * The Automations destination for a focused business member: a read-only list
 * of the routines behind their assigned bots. The general scheduler stays
 * unavailable to them (the server answers 403), so a change request goes
 * through the owning bot. Everything else a focused member sees is the shared
 * app shell; see App.tsx.
 */
export function FocusedAutomationsList({ automations, onNavigate }: { automations: Automation[]; onNavigate: (hash: string) => void }) {
  return <section className="mx-auto max-w-3xl space-y-5 p-4 pt-[calc(env(safe-area-inset-top)+1rem)] sm:p-6">
    <div><h1 className="text-xl font-semibold">Automations</h1><p className="mt-1 text-sm text-muted-foreground">Scheduled work for your bots. Open the bot to discuss a change.</p></div>
    {automations.length === 0 ? <p className="rounded-lg border p-5 text-muted-foreground">Your assigned bots have no routines yet.</p> :
      automations.map(item => <article key={item.id} className="rounded-lg border bg-card p-4">
        <div className="flex flex-wrap items-start justify-between gap-2"><h2 className="font-medium">{item.name}</h2><span className="rounded-full bg-muted px-2 py-1 text-xs">{item.enabled ? 'Active' : 'Paused'}</span></div>
        <p className="mt-2 text-sm text-muted-foreground">{item.schedule} · {item.timezone}</p>
        {item.enabled && item.nextRunAt && <p className="mt-1 text-sm text-muted-foreground">Next: {new Date(item.nextRunAt).toLocaleString(undefined, { timeZone: item.timezone })}</p>}
        <button className="mt-3 min-h-11 text-sm font-medium underline underline-offset-4" onClick={() => onNavigate(`#/chat/${item.botId}?from=bots`)}>Open {item.botName}</button>
      </article>)}
  </section>;
}

export function FocusedAutomations({ onNavigate }: { onNavigate: (hash: string) => void }) {
  const [automations, setAutomations] = useState<Automation[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const result = await api.focusedAutomations();
        if (active) { setAutomations(result.automations); setError(''); }
      } catch { if (active) setError('Could not load your automations. Please refresh to try again.'); }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 15000);
    return () => { active = false; clearInterval(timer); };
  }, []);
  return <div className="h-full overflow-auto">
    {error ? <p role="alert" className="p-5">{error}</p> : !automations ? <p role="status" className="p-5">Loading your automations…</p> :
      <FocusedAutomationsList automations={automations} onNavigate={onNavigate} />}
  </div>;
}
