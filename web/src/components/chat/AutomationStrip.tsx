import { ChevronRight, Clock3, MessageSquareText, PauseCircle } from 'lucide-react';
import type { ConversationAutomation } from '../../lib/types';

function shortTime(value: string | null): string | null {
  if (!value) return null;
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

/** Cadence plus the one date that is most useful for this run, in that order. */
function detailLine(automation: ConversationAutomation): string {
  const parts = [automation.scheduleText];
  if (!automation.enabled) {
    parts.push('Paused');
  } else if (automation.triggerKind === 'schedule') {
    const next = shortTime(automation.nextRunAt);
    if (next) parts.push(`Next ${next}`);
  }
  const ran = shortTime(automation.ranAt);
  if (ran) parts.push(`This run ${ran}`);
  return parts.join(' · ');
}

/**
 * Pinned under the chat header when the chat is one automation run: says which
 * scheduled agent wrote it and opens that agent's prompt in one tap, so reading
 * a result and editing the instructions behind it are the same gesture.
 */
export function AutomationStrip({
  automation,
  onOpen,
}: {
  automation: ConversationAutomation;
  onOpen: () => void;
}) {
  const Icon = !automation.enabled ? PauseCircle : automation.triggerKind === 'event' ? MessageSquareText : Clock3;
  return (
    <button
      type="button"
      onPointerUp={onOpen}
      aria-label={`Open the settings for the ${automation.name} automation`}
      className="flex shrink-0 items-center gap-2.5 border-b bg-muted/40 px-3 py-2 text-left transition-colors hover:bg-muted/70 focus-visible:ring-1 focus-visible:ring-ring/50 focus-visible:outline-none"
    >
      <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-brand/15 text-brand [&_svg]:size-4">
        <Icon />
      </span>
      <span className="min-w-0 flex-1 leading-tight">
        <span className="flex items-baseline gap-1.5">
          <span className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">Scheduled agent</span>
          <span className="truncate text-xs font-medium">{automation.name}</span>
        </span>
        <span className="block truncate text-[11px] text-muted-foreground">{detailLine(automation)}</span>
      </span>
      <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
    </button>
  );
}
