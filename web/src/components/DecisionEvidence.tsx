import { useState } from 'react';
import type { BotDecision, EvidenceItem } from '@/lib/bots';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle, DialogDescription, DialogClose } from '@/components/ui/dialog';

/** Evidence the bot (or a human) put on the card, grouped by kind. Photos open by default; the rest fold. */
export function DecisionEvidence({ decision, defaultOpen = false }: { decision: BotDecision; defaultOpen?: boolean }) {
  const items: (EvidenceItem & { index: number })[] = [...(decision.proposal.evidence_items ?? []), ...(decision.human_evidence ?? [])].map((item, index) => ({ ...item, index }));
  const [selected, setSelected] = useState<number | null>(null);
  if (!items.length) return null;
  const url = (index: number) => `/api/bots/decisions/${encodeURIComponent(decision.id)}/evidence/${decision.version}/${index}`;
  const photos = items.filter(i => i.kind === 'image' && i.retained);
  const documents = items.filter(i => i.kind === 'document' && i.retained);
  const messages = items.filter(i => i.kind === 'message');
  const records = items.filter(i => i.kind === 'record');
  const missing = items.filter(i => (i.kind === 'image' || i.kind === 'document') && !i.retained);
  const selectedItem = selected === null ? null : items[selected];
  const who = (i: EvidenceItem) => i.added_by === 'human' ? ' · attached by a teammate' : '';
  return <section aria-label="Evidence for this decision" className="min-w-0 space-y-3">
    {photos.length > 0 && <div>
      <h4 className="text-sm font-medium">Photos · {photos.length}</h4>
      <div className="mt-2 flex gap-2 overflow-x-auto pb-1">
        {photos.map(p => <button key={p.index} type="button" aria-label={`Enlarge ${p.label}`} onClick={() => setSelected(p.index)} className="shrink-0 overflow-hidden rounded-lg border bg-muted focus-visible:outline-2 focus-visible:outline-ring">
          <img src={url(p.index)} alt={p.label} loading="lazy" className="h-28 w-28 object-cover" />
        </button>)}
      </div>
    </div>}
    {messages.length > 0 && <details open={defaultOpen} className="rounded-lg border px-3">
      <summary className="min-h-10 cursor-pointer py-2 text-sm font-medium">Customer messages · {messages.length}</summary>
      <ul className="space-y-2 pb-3">{messages.map(m => <li key={m.index} className="border-l-2 border-foreground/15 pl-3 text-sm"><p className="font-medium">{m.label}{who(m)}</p><blockquote className="whitespace-pre-wrap text-muted-foreground">{m.text}</blockquote></li>)}</ul>
    </details>}
    {records.length > 0 && <details open={defaultOpen} className="rounded-lg border px-3">
      <summary className="min-h-10 cursor-pointer py-2 text-sm font-medium">Order &amp; refund facts · {records.length}</summary>
      <table className="mb-3 w-full text-sm"><tbody>{records.map(r => <tr key={r.index} className="align-top"><th scope="row" className="w-1/3 py-1 pr-2 text-left font-medium">{r.label}<span className="block text-xs font-normal text-muted-foreground">{String(r.source.system)}{r.captured_at ? ` · as of ${new Date(r.captured_at).toLocaleString()}` : ''}</span></th><td className="whitespace-pre-wrap py-1 text-muted-foreground">{r.text}</td></tr>)}</tbody></table>
    </details>}
    {documents.length > 0 && <details open={defaultOpen} className="rounded-lg border px-3">
      <summary className="min-h-10 cursor-pointer py-2 text-sm font-medium">Documents · {documents.length}</summary>
      <ul className="space-y-1 pb-3">{documents.map(d => <li key={d.index} className="flex items-center justify-between gap-2 text-sm"><span>{d.label}{who(d)}</span><a className="inline-flex min-h-9 items-center underline" href={url(d.index)} target="_blank" rel="noreferrer">Open</a></li>)}</ul>
    </details>}
    {missing.length > 0 && <p className="text-xs text-muted-foreground">{missing.length} cited file{missing.length > 1 ? 's were' : ' was'} not retained; ask the bot to attach the original.</p>}
    <Dialog open={!!selectedItem} onOpenChange={open => { if (!open) setSelected(null); }}>
      <DialogContent className="sm:max-w-4xl" showCloseButton={false}>
        <DialogClose asChild><Button variant="ghost" className="absolute right-2 top-2 min-h-[44px] min-w-[44px]">Close</Button></DialogClose>
        <DialogTitle className="pr-16 [overflow-wrap:anywhere]">{selectedItem?.label}</DialogTitle>
        <DialogDescription>{selectedItem ? `${String(selectedItem.source.system)} · Proposal v${decision.version}${who(selectedItem)}` : ''}</DialogDescription>
        {selectedItem && selected !== null && <div className="max-h-[70dvh] overflow-auto rounded-lg bg-muted"><img src={url(selected)} alt={selectedItem.label} className="mx-auto max-h-[70dvh] object-contain" /></div>}
      </DialogContent>
    </Dialog>
  </section>;
}
