import { Check, ExternalLink, LoaderCircle, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export type ConnectionReceiptStatus = {
  kind: 'working' | 'success' | 'error';
  label: string;
};

export type ConnectionReceiptField = {
  label: string;
  value: string;
  multiline?: boolean;
};

function StatusIcon({ kind }: { kind: ConnectionReceiptStatus['kind'] }) {
  if (kind === 'working') {
    return <LoaderCircle className="size-4 shrink-0 animate-spin stroke-brand" aria-hidden="true" />;
  }
  if (kind === 'error') {
    return <X className="size-4 shrink-0 stroke-destructive" aria-hidden="true" />;
  }
  return <Check className="size-4 shrink-0 stroke-emerald-600 dark:stroke-emerald-400" aria-hidden="true" />;
}

export function ConnectionReceipt({
  title,
  description,
  status,
  fields,
  actionHref,
  actionLabel,
  children,
  className,
}: {
  title: string;
  description: string;
  status: ConnectionReceiptStatus;
  fields: ConnectionReceiptField[];
  actionHref?: string;
  actionLabel?: string;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('overflow-hidden rounded-xl bg-muted/40 ring-1 ring-foreground/5 dark:ring-white/5', className)}>
      <div className="flex min-w-0 items-start justify-between gap-3 p-3">
        <div className="min-w-0">
          <p className="font-medium text-foreground">{title}</p>
          <p className={cn('text-pretty text-muted-foreground', status.kind === 'error' && 'text-destructive')}>
            {description}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5 rounded-full bg-background/70 py-1 pr-2 pl-1 font-medium tabular-nums ring-1 ring-foreground/5 dark:ring-white/5">
          <StatusIcon kind={status.kind} />
          <span>{status.label}</span>
        </div>
      </div>

      {fields.length ? (
        <dl className="divide-y divide-foreground/5 border-t border-foreground/5">
          {fields.map((field) => (
            <div key={field.label} className="grid gap-1 p-3 sm:grid-cols-[6rem_minmax(0,1fr)] sm:gap-3">
              <dt className="font-medium text-foreground">{field.label}</dt>
              <dd
                className={cn(
                  'min-w-0 break-words text-muted-foreground',
                  field.multiline && 'max-h-48 overflow-auto whitespace-pre-wrap text-pretty',
                )}
              >
                {field.value}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}

      {children ? <div className="border-t border-foreground/5 p-3">{children}</div> : null}

      {actionHref && actionLabel ? (
        <div className="border-t border-foreground/5 p-3">
          <a
            href={actionHref}
            target="_blank"
            rel="noreferrer"
            className="inline-flex min-h-12 items-center gap-1.5 rounded-md font-medium text-foreground underline decoration-foreground/25 underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:min-h-9"
          >
            {actionLabel}
            <ExternalLink className="size-4 shrink-0 stroke-muted-foreground" aria-hidden="true" />
          </a>
        </div>
      ) : null}
    </div>
  );
}
