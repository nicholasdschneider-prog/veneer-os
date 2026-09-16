import { Bot } from 'lucide-react';
import { cn } from '@/lib/utils';

export function NewChatPlaceholderRow({
  status,
  selected = false,
  onOpen,
}: {
  status: 'starting' | 'failed';
  selected?: boolean;
  onOpen: () => void;
}) {
  const starting = status === 'starting';
  return (
    <li>
      <button
        type="button"
        onPointerUp={starting ? undefined : onOpen}
        disabled={starting}
        aria-current={selected ? 'true' : undefined}
        aria-label={starting ? 'New chat, starting' : 'New chat, could not start'}
        className={cn(
          'flex w-full min-w-0 items-center gap-2 rounded-xl px-2.5 py-2 text-left active:bg-accent disabled:cursor-wait',
          selected && 'bg-accent',
        )}
      >
        <span className="-ml-2.5 flex shrink-0 items-center">
          <span className="size-2.5 -translate-x-2" aria-hidden="true" />
          <Bot className="size-3.5 shrink-0 text-muted-foreground" />
        </span>
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium">New chat</span>
        {starting ? (
          <span className="flex shrink-0 items-baseline gap-1 text-xs text-muted-foreground">
            <span>Starting</span>
            <span className="vp-starting-ellipsis inline-flex" aria-hidden="true">
              <span>.</span><span>.</span><span>.</span>
            </span>
          </span>
        ) : (
          <span className="shrink-0 text-xs font-medium text-destructive">Could not start</span>
        )}
      </button>
    </li>
  );
}
