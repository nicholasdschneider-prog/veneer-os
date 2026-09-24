import { cn } from '@/lib/utils';
import { useEffect, useState } from 'react';
import { decisionHandoffsApi, type DecisionHandoff } from '@/lib/decisionHandoffs';

export function DecisionHandoffStatus({ decisionId, className }: { decisionId: string; className?: string }) {
  const [handoffs, setHandoffs] = useState<DecisionHandoff[]>([]);
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    let stopped = false;
    const refresh = () => void decisionHandoffsApi.list(decisionId).then(r => {
      if (!stopped) { setHandoffs(r.handoffs); setUnavailable(false); }
    }).catch(() => { if (!stopped) { setHandoffs([]); setUnavailable(true); } });
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => { stopped = true; clearInterval(timer); };
  }, [decisionId]);
  if (unavailable) return <p role="status" className={cn("text-xs text-muted-foreground",className)}>Investigation status unavailable. Refresh to try again.</p>;
  if (!handoffs.length) return null;
  return <ul aria-label="Thread investigations" className={cn("space-y-2",className)}>
    {handoffs.map(h => <li key={h.id} className="rounded-xl border p-3 text-sm">
      {h.target_id ? <a className="font-medium underline" href={`#/chat/${encodeURIComponent(h.target_id)}`}>@{h.target_label} ↗</a> : <span>{h.target_label}</span>}
      <span className="ml-2 text-muted-foreground">{h.completed_at ? 'Findings returned in this discussion' : h.delivery_status === 'cancelled' ? 'Not delivered — thread access or availability changed' : h.delivery_status === 'delivered' ? 'Delivered · awaiting findings' : 'Investigation queued'} · v{h.version}</span>
    </li>)}
  </ul>;
}
