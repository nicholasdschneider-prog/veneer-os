import { MessageFooter } from '@/components/ui/message';
import {
  formatResponseDateTime,
  formatResponseTime,
  formatResponseTokenCount,
  normalizeResponseTokenUsage,
  responseTokenBreakdown,
  responseTokenRows,
  type ResponseTokenRow,
  type ResponseTokenUsage,
} from '@/lib/responseMetadata';

export function AssistantResponseMetadata({
  at,
  usage,
}: {
  at?: string;
  usage?: ResponseTokenUsage;
}) {
  const time = formatResponseTime(at);
  const normalizedUsage = normalizeResponseTokenUsage(usage);
  if (!time && !normalizedUsage) return null;

  return (
    <MessageFooter className="gap-1.5 font-normal text-muted-foreground/70">
      {time && at ? (
        <time dateTime={at} title={formatResponseDateTime(at)}>{time}</time>
      ) : null}
      {time && normalizedUsage ? <span aria-hidden="true">·</span> : null}
      {normalizedUsage ? <TokenCount usage={normalizedUsage} /> : null}
    </MessageFooter>
  );
}

// Older rows are frozen to static HTML (renderToStaticMarkup, no React
// handlers), so the card must work without JS. A native <details> toggles on
// tap, which matters because Tailwind's hover: variant is gated behind
// @media (hover: hover) and never fires on phones; desktop still gets hover.
function TokenCount({ usage }: { usage: ResponseTokenUsage }) {
  const rows = responseTokenRows(usage);
  const label = responseTokenBreakdown(usage);

  return (
    <details className="group/tokens relative inline-flex" data-slot="token-count">
      <summary
        aria-label={label}
        className="cursor-default list-none rounded-sm underline-offset-2 outline-none select-none hover:underline group-open/tokens:underline focus-visible:ring-2 focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden"
      >
        {formatResponseTokenCount(usage)} tokens
      </summary>
      <span
        role="tooltip"
        data-slot="token-breakdown-card"
        className="pointer-events-none absolute bottom-full left-0 z-50 mb-1.5 hidden w-max rounded-lg bg-popover px-2.5 py-2 text-xs text-popover-foreground shadow-lg ring-1 ring-foreground/10 group-open/tokens:block group-hover/tokens:block"
      >
        <TokenBreakdownCard rows={rows} />
      </span>
    </details>
  );
}

export function TokenBreakdownCard({ rows }: { rows: ResponseTokenRow[] }) {
  return (
    <dl data-slot="token-breakdown" className="grid grid-cols-[auto_auto] gap-x-4 gap-y-1">
      {rows.map((row) => (
        <div key={row.key} className="col-span-2 grid grid-cols-subgrid">
          <dt className={row.key === 'total' ? 'text-popover-foreground' : 'text-muted-foreground'}>
            {row.label}
          </dt>
          <dd className="text-right tabular-nums">{row.value.toLocaleString()}</dd>
        </div>
      ))}
    </dl>
  );
}
