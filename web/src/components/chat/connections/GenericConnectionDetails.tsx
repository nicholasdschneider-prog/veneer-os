import type { ToolChatItem } from '@/lib/activityRuns';
import { cn } from '@/lib/utils';

export function GenericConnectionDetails({ item, className }: { item: ToolChatItem; className?: string }) {
  const source = item.source!;
  const connection = [source.name, source.label, source.sharing === 'shared' ? 'Shared' : null]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className={cn('overflow-hidden rounded-xl bg-muted/40 ring-1 ring-foreground/5 dark:ring-white/5', className)}>
      <dl className="divide-y divide-foreground/5">
        <div className="grid gap-1 p-3 sm:grid-cols-[6rem_minmax(0,1fr)] sm:gap-3">
          <dt className="font-medium text-foreground">Connection</dt>
          <dd className="min-w-0 break-words text-muted-foreground">{connection}</dd>
        </div>
        <div className="grid gap-1 p-3 sm:grid-cols-[6rem_minmax(0,1fr)] sm:gap-3">
          <dt className="font-medium text-foreground">Action</dt>
          <dd className="min-w-0 break-words text-muted-foreground">{item.actionLabel}</dd>
        </div>
      </dl>
      <p className="border-t border-foreground/5 p-3 text-pretty text-muted-foreground">
        Connector-specific details are not available for this action.
      </p>
    </div>
  );
}
