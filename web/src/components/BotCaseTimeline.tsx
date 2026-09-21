import type { CaseTimelineEntry } from '@/lib/bots';

const kindLabel = { event: '', request: 'Requested', promise: 'Promised', proposal: 'Proposed' };

/** Dates retain the precision in the evidence; never reinterpret a date-only label as UTC. */
export function BotCaseTimeline({ entries }: { entries?: CaseTimelineEntry[] }) {
  return <section aria-label="Case timeline" className="rounded-xl border p-4 [overflow-wrap:anywhere]">
    <h3 className="font-semibold">Case timeline</h3>
    {!entries?.length ? <p className="mt-2 text-base text-muted-foreground sm:text-sm">Case history hasn’t been recorded for this card yet. See Evidence & context for the source records.</p> : <>
      <ul className="mt-3 list-disc space-y-3 pl-5 text-base leading-6 sm:text-sm">
        {entries.map((entry, index) => <li key={index}>
          <span className="font-medium">{entry.when ?? 'Date unknown'} · {entry.actor}</span>
          {entry.bot && entry.bot !== entry.actor && <span className="text-muted-foreground"> · Handled by {entry.bot}</span>}
          {entry.channel && <span className="text-muted-foreground"> ({entry.channel})</span>}
          <span> — {kindLabel[entry.kind] && <strong className="font-medium">{kindLabel[entry.kind]}: </strong>}{entry.summary}</span>
        </li>)}
      </ul>
      <details className="mt-3 border-t pt-2 text-sm text-muted-foreground">
        <summary className="cursor-pointer py-1 focus-visible:outline focus-visible:outline-ring">Timeline sources</summary>
        <ol className="mt-2 list-decimal space-y-2 pl-5">
          {entries.map((entry, index) => <li key={index}>{entry.source}</li>)}
        </ol>
      </details>
    </>}
  </section>;
}
