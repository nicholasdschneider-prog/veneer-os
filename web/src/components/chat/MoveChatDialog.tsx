import { useEffect, useState } from 'react';
import { FolderInput, LoaderCircle } from 'lucide-react';
import { api } from '../../lib/api';
import type { Conversation, Project } from '../../lib/types';
import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog';
import { DropdownMenuItem } from '../ui/dropdown-menu';

export function MoveChatMenuItem({ disabled, onSelect }: { disabled?: boolean; onSelect: () => void }) {
  return (
    <DropdownMenuItem
      disabled={disabled}
      title={disabled ? 'Wait for the current reply to finish.' : undefined}
      onSelect={onSelect}
    >
      <FolderInput className="size-4" />
      Move to project…
    </DropdownMenuItem>
  );
}

/**
 * Picks a destination project for a chat. History stays with the chat; the
 * next turn runs in the new project's folder with its instructions.
 */
export function MoveChatDialog({
  conversation,
  onOpenChange,
  onMoved,
  onToast,
}: {
  /** The chat being moved; null closes the dialog. */
  conversation: Pick<Conversation, 'id' | 'title' | 'projectId'> | null;
  onOpenChange: (open: boolean) => void;
  onMoved: (conversation: Conversation) => void;
  onToast?: (message: string) => void;
}) {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [busy, setBusy] = useState(false);
  const open = conversation !== null;

  useEffect(() => {
    if (!open) return;
    let stop = false;
    setProjects(null);
    api
      .projects()
      .then((r) => {
        if (!stop) setProjects(r.projects);
      })
      .catch(() => {
        if (!stop) setProjects([]);
      });
    return () => {
      stop = true;
    };
  }, [open]);

  const move = async (projectId: string | null, label: string) => {
    if (!conversation || busy) return;
    setBusy(true);
    try {
      const { conversation: moved } = await api.updateConversation(conversation.id, { projectId });
      onToast?.(`Moved “${conversation.title?.trim() || 'Untitled chat'}” to ${label}`);
      onMoved(moved);
      onOpenChange(false);
    } catch (err) {
      onToast?.(err instanceof Error ? err.message : 'Could not move chat');
    } finally {
      setBusy(false);
    }
  };

  const choices = (projects ?? []).filter((p) => p.id !== conversation?.projectId);

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Move to project</DialogTitle>
          <DialogDescription>
            The chat keeps its history. Its next reply runs in the new project&apos;s folder with that
            project&apos;s instructions.
          </DialogDescription>
        </DialogHeader>
        {projects === null ? (
          <div className="flex items-center justify-center py-6 text-muted-foreground">
            <LoaderCircle className="size-5 animate-spin" />
          </div>
        ) : (
          <div className="flex flex-col gap-2" role="list">
            {choices.map((p) => (
              <Button
                key={p.id}
                variant="outline"
                className="h-11 w-full justify-start rounded-xl"
                disabled={busy}
                onPointerUp={() => void move(p.id, p.name)}
              >
                {p.name}
              </Button>
            ))}
            {conversation?.projectId ? (
              <Button
                variant="ghost"
                className="h-11 w-full justify-start rounded-xl text-muted-foreground"
                disabled={busy}
                onPointerUp={() => void move(null, 'Chats')}
              >
                No project
              </Button>
            ) : null}
            {choices.length === 0 && !conversation?.projectId ? (
              <p className="py-4 text-center text-sm text-muted-foreground">No other projects yet.</p>
            ) : null}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
