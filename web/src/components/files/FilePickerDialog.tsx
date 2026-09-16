import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { FileManager } from './FileManager';

/**
 * Reusable "choose a file on the server" dialog: a pick-mode FileManager with
 * a Cancel/Choose footer. Selecting a file stages it; Choose reports it via
 * onPick and closes.
 */
export function FilePickerDialog({
  open,
  onOpenChange,
  onPick,
  onToast,
  initialRoot,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (sel: { root: string; path: string }) => void;
  onToast: (message: string) => void;
  initialRoot?: string;
}) {
  const [picked, setPicked] = useState<{ root: string; path: string } | null>(null);

  // Reset the staged pick whenever the dialog opens.
  useEffect(() => {
    if (open) setPicked(null);
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false} className="flex h-[min(85dvh,40rem)] flex-col sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Choose a file</DialogTitle>
          <DialogDescription>Pick a file from this server.</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-hidden rounded-xl border">
          <FileManager mode="pick" initialRoot={initialRoot} onPickFile={setPicked} onToast={onToast} className="h-full" />
        </div>
        {picked ? (
          <p className="truncate text-xs text-muted-foreground">
            {picked.root}: {picked.path}
          </p>
        ) : null}
        <DialogFooter className="gap-2">
          <Button variant="outline" className="h-11 flex-1 rounded-xl" onPointerUp={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            className="h-11 flex-1 rounded-xl"
            disabled={!picked}
            onPointerUp={() => {
              if (!picked) return;
              onPick(picked);
              onOpenChange(false);
            }}
          >
            Choose
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
