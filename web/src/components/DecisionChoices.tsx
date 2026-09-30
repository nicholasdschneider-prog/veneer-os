import { useRef, useState } from 'react';
import { Button } from './ui/button';
import { defaultDecisionChoices, type BotProposal } from '@/lib/bots';

type Choice = NonNullable<BotProposal['choices']>[number];
const secondaryAction = (c: Choice) => c.action === 'defer' || c.action === 'withdraw';
const actionNote = (c: Choice) => c.action === 'approve' ? 'Approves this proposal' : c.action === 'reject' ? 'Declines this proposal' : c.action === 'defer' ? 'Defers this decision' : 'Withdraws this request';

/**
 * Researched options first (recommended on top), hold/withdraw as quiet links,
 * then the human's own typed answer. A click submits one explicit action against
 * the caller's reviewed proposal version; a typed answer is recorded as `custom`.
 */
export function DecisionChoices({ choices, disabled, onChoose, onCustom }: {
  choices?: BotProposal['choices']; disabled: boolean; onChoose: (id: string) => void; onCustom?: (text: string, files: File[]) => void;
}) {
  const [customOpen, setCustomOpen] = useState(false);
  const [custom, setCustom] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const picker = useRef<HTMLInputElement | null>(null);
  const supplied = choices ?? defaultDecisionChoices;
  const ordered = [...supplied].sort((a, b) => Number(!!b.recommended) - Number(!!a.recommended));
  const hasPrimary = ordered.some(c => !secondaryAction(c));
  const primary = hasPrimary ? ordered.filter(c => !secondaryAction(c)) : ordered;
  const secondary = hasPrimary ? ordered.filter(secondaryAction) : [];
  const label = (c: Choice) => !choices && c.action === 'approve' ? 'Approve recommendation' : c.label;
  return <div className="mt-4 space-y-3">
    <div className="flex flex-col gap-2">
      {primary.map((choice, index) => <Button key={choice.id} type="button" className="h-auto min-h-12 justify-start whitespace-normal py-3" variant="outline" disabled={disabled} onClick={() => onChoose(choice.id)}>
        <span className="flex size-7 shrink-0 items-center justify-center rounded-md border text-xs text-muted-foreground">{index < 26 ? String.fromCharCode(65 + index) : String(index + 1)}</span>
        <span className="min-w-0 break-words text-left">
          <span className="block">{label(choice)}{choice.recommended && <span className="ml-2 rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:text-emerald-300">Recommended</span>}</span>
          {choice.description ? <span className="block text-xs font-normal text-muted-foreground">{choice.description}</span>
            : <span className="block text-xs font-normal text-muted-foreground">{actionNote(choice)}</span>}
        </span>
      </Button>)}
      {onCustom && (customOpen ? <div className="rounded-xl border p-3 space-y-2" aria-label="Something else">
        <label className="block text-sm font-medium">Something else
          <textarea className="mt-1 block w-full rounded-lg border bg-background p-2 text-sm" rows={3} autoFocus value={custom} placeholder="Tell the bot what should happen instead" onChange={e => setCustom(e.target.value)} />
        </label>
        <p className="text-xs text-muted-foreground">Submitting records this as your answer. The bot follows your direction; it does not authorize the proposal’s exact action.</p>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <input ref={picker} type="file" accept="image/png,image/jpeg,image/gif,image/webp,application/pdf" multiple className="hidden" onChange={e => { setFiles(f => [...f, ...Array.from(e.target.files ?? [])]); e.target.value = ''; }} />
          <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => picker.current?.click()}>Attach photo or PDF</Button>
          {files.map((f, i) => <span key={`${f.name}-${i}`} className="rounded-full border px-2 py-0.5">{f.name} <button type="button" aria-label={`Remove ${f.name}`} className="ml-1" onClick={() => setFiles(list => list.filter((_, j) => j !== i))}>×</button></span>)}
        </div>
        <div className="flex gap-2">
          <Button type="button" disabled={disabled || !custom.trim()} onClick={() => { onCustom(custom.trim(), files); setCustom(''); setFiles([]); setCustomOpen(false); }}>Submit answer</Button>
          <Button type="button" variant="ghost" disabled={disabled} onClick={() => setCustomOpen(false)}>Cancel</Button>
        </div>
      </div> : <Button type="button" className="h-auto min-h-12 justify-start whitespace-normal py-3" variant="outline" disabled={disabled} onClick={() => setCustomOpen(true)}>
        <span className="flex size-7 shrink-0 items-center justify-center rounded-md border text-xs text-muted-foreground">…</span>
        <span className="min-w-0 break-words text-left"><span className="block">Something else</span><span className="block text-xs font-normal text-muted-foreground">Type what you actually want to happen and submit it as the answer</span></span>
      </Button>)}
    </div>
    {secondary.length > 0 && <div className="flex flex-wrap gap-x-4 gap-y-1">
      {secondary.map(choice => <button key={choice.id} type="button" disabled={disabled} className="min-h-9 text-sm text-muted-foreground underline underline-offset-2 disabled:opacity-50" title={choice.description || actionNote(choice)} onClick={() => onChoose(choice.id)}>{label(choice)}</button>)}
    </div>}
  </div>;
}
