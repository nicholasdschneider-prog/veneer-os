/* Hallmark · component: decision evidence gallery · genre: modern-minimal · theme: existing Veneer
 * states: default · hover · focus · active · disabled · loading · error · success
 */
import { useRef, useState } from 'react';
import type { BotDecision } from '@/lib/bots';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle, DialogDescription, DialogClose } from '@/components/ui/dialog';

type EvidenceImage = NonNullable<BotDecision['proposal']['images']>[number];
function ImageTile({ image, url, onOpen }: { image: EvidenceImage; url: string; onOpen: (button: HTMLButtonElement) => void }) {
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [attempt, setAttempt] = useState(0);
  return <figure className="min-w-0 rounded-xl border bg-muted/20 p-2">
    <button type="button" aria-label={`Enlarge ${image.label}`} disabled={state !== 'ready'} onClick={event => onOpen(event.currentTarget)}
      className="relative flex min-h-[140px] w-full items-center justify-center overflow-hidden rounded-lg bg-muted focus-visible:outline-2 focus-visible:outline-ring hover:bg-accent active:opacity-80 disabled:cursor-default">
      {state !== 'error' && <img key={attempt} src={`${url}?retry=${attempt}`} alt={image.label} loading="lazy" onLoad={() => setState('ready')} onError={() => setState('error')} className="h-40 w-full object-contain" />}
      {state === 'loading' && <span role="status" className="absolute rounded bg-background/90 px-2 py-1 text-xs">Loading image…</span>}
      {state === 'error' && <span className="p-3 text-sm text-muted-foreground">Image unavailable or changed</span>}
    </button>
    <figcaption className="space-y-1 p-2 text-sm [overflow-wrap:anywhere]">
      <p className="font-medium">{image.label}</p><p className="text-xs text-muted-foreground">{image.source}</p>
      {state === 'error' && <><p className="text-xs text-muted-foreground">Ask the bot to attach the retained original or update the evidence.</p><Button variant="outline" className="min-h-[44px]" onClick={() => { setState('loading'); setAttempt(n => n + 1); }}>Retry image</Button></>}
    </figcaption>
  </figure>;
}
export function DecisionImages({ decision }: { decision: BotDecision }) {
  const images = decision.proposal.images ?? [];
  const opener = useRef<HTMLButtonElement | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [zoom, setZoom] = useState(false);
  const [failed, setFailed] = useState(false);
  const url = (index: number) => `/api/bots/decisions/${encodeURIComponent(decision.id)}/images/${decision.version}/${index}`;
  const image = selected === null ? null : images[selected];
  return <section aria-label="Images supplied for this decision" className="my-5 min-w-0 space-y-3">
    <h3 className="font-medium">Images{images.length > 0 ? ` · ${images.length}` : ''}</h3>
    {images.length === 0 ? <p className="text-sm text-muted-foreground">No images attached to this proposal. Ask the bot to attach the relevant customer or case photos.</p> : <>
      <p className="text-xs text-muted-foreground">Supplied evidence for proposal v{decision.version}. Select an image to enlarge.</p>
      <div className="grid min-w-0 gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 180px), 1fr))' }}>
        {images.map((item, index) => <ImageTile key={`${decision.version}-${index}`} image={item} url={url(index)} onOpen={button => { opener.current = button; setSelected(index); setZoom(false); setFailed(false); }} />)}
      </div>
    </>}
    <Dialog open={!!image} onOpenChange={open => { if (!open) setSelected(null); }}>
      <DialogContent className="sm:max-w-4xl" showCloseButton={false} onCloseAutoFocus={event => { event.preventDefault(); opener.current?.focus(); }}>
        <DialogClose asChild><Button variant="ghost" className="absolute right-2 top-2 min-h-[44px] min-w-[44px]">Close</Button></DialogClose>
        <DialogTitle className="pr-16 [overflow-wrap:anywhere]">{image?.label}</DialogTitle>
        <DialogDescription className="[overflow-wrap:anywhere]">{image?.source} · Proposal v{decision.version}</DialogDescription>
        {image && selected !== null && <>
          <div className="max-h-[65dvh] overflow-auto rounded-lg bg-muted">
            {failed ? <p role="status" className="p-4">Image unavailable or changed. Close this preview and refresh the decision.</p> : <img src={url(selected)} alt={image.label} onError={() => setFailed(true)} className={zoom ? 'max-w-none' : 'mx-auto max-h-[65dvh] max-w-full object-contain'} />}
          </div>
          <Button variant="outline" disabled={failed} className="min-h-[44px]" onClick={() => setZoom(v => !v)}>{zoom ? 'Fit image' : 'View full size'}</Button>
        </>}
      </DialogContent>
    </Dialog>
  </section>;
}
