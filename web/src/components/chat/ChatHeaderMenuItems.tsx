import { Copy, Globe, LoaderCircle, Minimize2, Pencil, Pin, Trash2 } from 'lucide-react';
import type { ChatHeaderMenuLabels } from '../../lib/chatDeletion';
import { cn } from '@/lib/utils';
import { DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu';
import { ChatInfoMenuItem } from './ChatContextDialog';
import { MoveChatMenuItem } from './MoveChatDialog';

interface ChatHeaderMenuItemsProps {
  labels: ChatHeaderMenuLabels;
  pinned: boolean;
  compaction: { supported: boolean; disabled: boolean; busy: boolean; disabledReason?: string };
  onInfo: () => void;
  onRename: () => void;
  onCopyLink: () => void;
  onOpenBrowser?: () => void;
  onCompact: () => void;
  onTogglePin: () => void;
  /** Opens the move-to-project picker; omitted when the chat cannot move now. */
  onMove?: () => void;
  moveDisabled?: boolean;
  onDelete: () => void;
}

export function ChatHeaderMenuItems({
  labels,
  pinned,
  compaction,
  onInfo,
  onRename,
  onCopyLink,
  onOpenBrowser,
  onCompact,
  onTogglePin,
  onMove,
  moveDisabled,
  onDelete,
}: ChatHeaderMenuItemsProps) {
  return (
    <>
      <ChatInfoMenuItem label={labels.info} onSelect={onInfo} />
      {labels.manage ? (
        <DropdownMenuItem onSelect={onRename}>
          <Pencil className="size-4" />
          {labels.manage.rename}
        </DropdownMenuItem>
      ) : null}
      <DropdownMenuItem onSelect={onCopyLink}>
        <Copy className="size-4" />
        {labels.copyLink}
      </DropdownMenuItem>
      {onOpenBrowser ? (
        <DropdownMenuItem onSelect={onOpenBrowser}>
          <Globe className="size-4" />
          Open browser
        </DropdownMenuItem>
      ) : null}
      {labels.manage ? (
        <>
          <DropdownMenuItem
            disabled={compaction.disabled}
            title={
              !compaction.supported
                ? 'Available for Claude and Codex chats.'
                : compaction.busy
                  ? 'Context compaction is running.'
                  : compaction.disabled
                    ? compaction.disabledReason ?? 'Wait for the current reply to finish.'
                    : undefined
            }
            onSelect={onCompact}
          >
            {compaction.busy ? (
              <LoaderCircle className="size-4 shrink-0 animate-spin" />
            ) : (
              <Minimize2 className="size-4 shrink-0" />
            )}
            {compaction.busy
              ? 'Compacting context…'
              : compaction.supported
                ? 'Compact context'
                : 'Context compaction unavailable'}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onTogglePin}>
            <Pin className={cn('size-4', pinned && 'fill-current')} />
            {labels.manage.pin}
          </DropdownMenuItem>
          {onMove ? <MoveChatMenuItem disabled={moveDisabled} onSelect={onMove} /> : null}
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={onDelete}>
            <Trash2 className="size-4" />
            {labels.manage.delete}
          </DropdownMenuItem>
        </>
      ) : null}
    </>
  );
}
