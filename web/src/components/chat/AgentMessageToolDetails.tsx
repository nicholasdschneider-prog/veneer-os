import { ArrowUpRight } from 'lucide-react';
import {
  agentMessageActivityLabel,
  agentMessageTargetHash,
  type AgentMessageActivityItem,
} from '@/lib/agentMessageActivity';

function statusLabel(item: AgentMessageActivityItem): string {
  if (item.running) return 'Sending';
  if (!item.ok) return 'Failed';
  if (item.agentMessageDetails?.disposition === 'queued') return 'Queued';
  if (item.agentMessageDetails?.disposition === 'duplicate') return 'Already sent';
  if (item.agentMessageDetails?.disposition === 'delivered') return 'Delivered';
  return 'Sent';
}

export function AgentMessageToolDetails({ item }: { item: AgentMessageActivityItem }) {
  const details = item.agentMessageDetails;
  const label = agentMessageActivityLabel(item);
  if (!details || !label) return null;
  const target = details.targetChat;
  const href = agentMessageTargetHash(details);
  const exact = Boolean(href && href.includes('?message='));

  return (
    <div className="mt-1 ml-6 max-h-64 overflow-auto rounded-md bg-muted/50 text-muted-foreground">
      <div className="flex min-w-0 items-baseline gap-2 border-b border-border/60 px-2.5 py-2 text-xs">
        <span className="min-w-0 flex-1 truncate font-medium text-foreground/80">
          {target ? `To ${target.agentName}` : 'Agent message'}
        </span>
        <span className="shrink-0">{statusLabel(item)}</span>
      </div>
      <p className="whitespace-pre-wrap break-words px-2.5 py-2 text-sm/6 text-foreground/80">
        {details.text}
      </p>
      {href && target ? (
        <div className="border-t border-border/60 px-1 py-0.5">
          <a
            href={href}
            data-app-route={href}
            className="relative inline-flex items-center gap-1 rounded-sm py-1.5 pr-1.5 pl-2.5 text-sm font-medium text-foreground/70 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            aria-label={exact
              ? `Open ${target.agentName} at this message in ${target.title}`
              : `Open ${target.agentName} chat ${target.title}`}
          >
            <span>{exact ? `Open ${target.agentName} at this message` : `Open ${target.agentName}`}</span>
            <ArrowUpRight className="size-4 shrink-0" aria-hidden="true" />
            <span
              className="pointer-fine:hidden absolute top-1/2 left-1/2 size-[max(100%,3rem)] -translate-1/2"
              aria-hidden="true"
            />
          </a>
        </div>
      ) : null}
    </div>
  );
}
