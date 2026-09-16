import { Archive, ArchiveRestore } from 'lucide-react';
import { Button } from '@/components/ui/button';

export function ChatArchiveButton({
  archived,
  canManage,
  busy,
  onArchive,
}: {
  archived: boolean;
  canManage: boolean;
  busy: boolean;
  onArchive: () => void;
}) {
  if (!canManage) return null;

  const label = archived ? 'Move to Chats' : 'Archive chat';
  return (
    <Button
      variant="ghost"
      size="icon-lg"
      className="relative rounded-full text-muted-foreground"
      disabled={busy}
      onClick={onArchive}
      aria-label={label}
      title={label}
    >
      {archived ? (
        <ArchiveRestore className="size-4 shrink-0" aria-hidden="true" />
      ) : (
        <Archive className="size-4 shrink-0" aria-hidden="true" />
      )}
      <span
        className="pointer-fine:hidden absolute top-1/2 left-1/2 size-[max(100%,3rem)] -translate-1/2"
        aria-hidden="true"
      />
    </Button>
  );
}
