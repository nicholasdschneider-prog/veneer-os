import { ChevronLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { FileManager } from '../components/files/FileManager';
import type { ProjectFileLocation } from '../lib/projectFilesRoute';

/** Full-screen file browser + editor (owner/consultant only), off Settings. */
export function FileBrowser({
  onBack,
  onToast,
  title = 'File browser',
  fixedRoot,
  initialFile = null,
  onInitialFileDeclined,
  backLabel = 'Back',
}: {
  onBack: () => void;
  onToast: (message: string) => void;
  title?: string;
  fixedRoot?: string;
  initialFile?: ProjectFileLocation | null;
  onInitialFileDeclined?: () => void;
  backLabel?: string;
}) {
  return (
    <div className="mx-auto flex h-full max-w-5xl flex-col pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]">
      <header className="flex items-center gap-2 border-b px-3 py-2.5">
        <Button variant="ghost" size="icon-lg" className="rounded-full" onPointerUp={onBack} aria-label={backLabel}>
          <ChevronLeft className="size-5" />
        </Button>
        <p className="min-w-0 flex-1 truncate font-medium">{title}</p>
      </header>
      <FileManager
        key={fixedRoot ?? 'global'}
        mode="browse"
        fixedRoot={fixedRoot}
        initialFile={initialFile}
        onInitialFileDeclined={onInitialFileDeclined}
        onToast={onToast}
        className="min-h-0 flex-1"
      />
    </div>
  );
}
