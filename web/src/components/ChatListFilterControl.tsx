import { cn } from '@/lib/utils';
import type { ChatListFilter } from '../lib/chatListFilter';

/**
 * The Chats header's All / Unread segmented control. Sits where the desktop
 * "New chat" button used to (the left rail owns New chat now), so it has to
 * survive a ~280px sidebar: `shrink-0` here, `truncate` on the heading.
 */
export function ChatListFilterControl({
  filter,
  unreadCount,
  onChange,
}: {
  filter: ChatListFilter;
  unreadCount: number;
  onChange: (filter: ChatListFilter) => void;
}) {
  const segment = (selected: boolean) =>
    cn(
      'flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium transition-colors',
      selected ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground',
    );
  const unreadSelected = filter === 'unread';
  return (
    <div
      role="group"
      aria-label="Show"
      className="flex shrink-0 items-center gap-0.5 rounded-full bg-muted p-0.5"
    >
      <button
        type="button"
        aria-pressed={filter === 'all'}
        onPointerUp={() => onChange('all')}
        className={segment(filter === 'all')}
      >
        All
      </button>
      <button
        type="button"
        aria-pressed={unreadSelected}
        onPointerUp={() => onChange('unread')}
        className={segment(unreadSelected)}
      >
        Unread
        {unreadCount > 0 ? (
          <span
            className={cn(
              'inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-semibold tabular-nums',
              unreadSelected ? 'bg-primary text-primary-foreground' : 'bg-primary/15 text-primary',
            )}
          >
            {unreadCount}
          </span>
        ) : null}
      </button>
    </div>
  );
}
