import { useEffect, useState } from 'react';
import { Check, ChevronRight, CornerLeftUp, Folder, FolderOpen, FolderPlus, Home, X } from 'lucide-react';
import { api } from '../lib/api';
import type { DirListing, Project } from '../lib/types';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

/**
 * Create a project (folder). Name is required; instructions are optional
 * standing context saved into each new chat's fixed provider-level snapshot.
 *
 * All active users may also pick the folder the project runs in — anywhere
 * on the system — instead of the default managed workspace. CLAUDE.md and
 * AGENTS.md in that folder remain fully user-owned and provider-native.
 */
export function NewProjectDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (project: Project) => void;
}) {
  const [name, setName] = useState('');
  const [instructions, setInstructions] = useState('');
  const [rootDir, setRootDir] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset fields whenever the dialog opens.
  useEffect(() => {
    if (open) {
      setName('');
      setInstructions('');
      setRootDir(null);
      setPicking(false);
      setError(null);
      setBusy(false);
    }
  }, [open]);

  const create = async () => {
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      const { project } = await api.createProject({
        name: trimmed,
        instructions: instructions.trim() || undefined,
        rootDir: rootDir ?? undefined,
      });
      onCreated(project);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="grid-cols-[minmax(0,1fr)]">
        <DialogHeader>
          <DialogTitle>New project</DialogTitle>
          <DialogDescription>A project is a folder with its own context that its chats share.</DialogDescription>
        </DialogHeader>
        {picking ? (
          <FolderPicker
            initial={rootDir}
            onCancel={() => setPicking(false)}
            onSelect={(path) => {
              setRootDir(path);
              setPicking(false);
            }}
          />
        ) : (
          <>
            <div className="flex flex-col gap-3">
              <label className="flex flex-col gap-1.5">
                <span className="text-sm font-medium">Name</span>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Q3 Marketing"
                  autoFocus
                  className="rounded-xl border bg-card px-3 py-2.5 text-[16px] outline-none focus:border-ring"
                />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-sm font-medium">
                  Context <span className="font-normal text-muted-foreground">(optional)</span>
                </span>
                <textarea
                  value={instructions}
                  onChange={(e) => setInstructions(e.target.value)}
                  placeholder="What this project is about, goals, useful background…"
                  rows={4}
                  className="resize-none rounded-xl border bg-card px-3 py-2.5 text-[16px] outline-none focus:border-ring"
                />
              </label>
              <div className="flex flex-col gap-1.5">
                <span className="text-sm font-medium">
                  Folder <span className="font-normal text-muted-foreground">(where its chats run)</span>
                </span>
                <div className="flex items-center gap-2">
                  <button
                    aria-label="Choose project folder"
                    onPointerUp={() => !busy && setPicking(true)}
                    className="flex min-w-0 flex-1 items-center gap-2 rounded-xl border bg-card px-3 py-2.5 text-left active:bg-accent"
                  >
                    <FolderOpen className="size-4 shrink-0 text-muted-foreground" />
                    <span
                      className={`truncate text-sm ${rootDir ? '' : 'text-muted-foreground'}`}
                      title={rootDir ?? undefined}
                    >
                      {rootDir ?? 'Default project workspace'}
                    </span>
                  </button>
                  {rootDir ? (
                    <button
                      onPointerUp={() => !busy && setRootDir(null)}
                      aria-label="Use default folder"
                      className="rounded-full p-2 text-muted-foreground active:bg-accent"
                    >
                      <X className="size-4" />
                    </button>
                  ) : null}
                </div>
              </div>
              {error ? <p className="text-sm text-destructive">{error}</p> : null}
            </div>
            <DialogFooter className="gap-2">
              <Button
                variant="outline"
                className="h-11 flex-1 rounded-xl"
                onPointerUp={() => !busy && onOpenChange(false)}
                disabled={busy}
              >
                Cancel
              </Button>
              <Button
                className="h-11 flex-1 rounded-xl"
                onPointerUp={() => void create()}
                disabled={busy || !name.trim()}
              >
                Create
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Join a browsed directory with a new subfolder name, tolerant of a trailing slash. */
function joinDir(base: string, name: string): string {
  return `${base.replace(/\/+$/, '')}/${name.trim().replace(/^\/+/, '')}`;
}

/**
 * Server-side folder browser: walk the whole filesystem via GET /api/fs/dirs,
 * or type/paste any absolute path (that's also the only way to reach hidden
 * folders, which listings skip). A typed path that doesn't exist yet is fine —
 * the server creates it when the project is created. You can also name a brand
 * new folder to create inside the directory you're browsing ("New folder").
 */
function FolderPicker({
  initial,
  onCancel,
  onSelect,
}: {
  initial: string | null;
  onCancel: () => void;
  onSelect: (path: string) => void;
}) {
  const [listing, setListing] = useState<DirListing | null>(null);
  const [typed, setTyped] = useState(initial ?? '');
  const [error, setError] = useState<string | null>(null);
  // Non-null when the user is naming a new subfolder to create here.
  const [newName, setNewName] = useState<string | null>(null);

  const load = (path?: string) => {
    setError(null);
    setNewName(null);
    api
      .browseDirs(path)
      .then((l) => {
        setListing(l);
        setTyped(l.path);
      })
      .catch((err) => setError((err as Error).message));
  };

  useEffect(() => {
    load(initial ?? undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const typedIsElsewhere = typed.trim() !== '' && typed.trim() !== listing?.path;
  const createNew = () => {
    const name = (newName ?? '').trim();
    if (!name || !listing) return;
    onSelect(joinDir(listing.path, name));
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <input
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && typed.trim().startsWith('/')) load(typed.trim());
          }}
          placeholder="/absolute/path"
          spellCheck={false}
          autoCapitalize="off"
          className="min-w-0 flex-1 rounded-xl border bg-card px-3 py-2 font-mono text-[13px] outline-none focus:border-ring"
        />
        <button
          onPointerUp={() => listing && load(listing.home)}
          aria-label="Home folder"
          className="rounded-full p-2 text-muted-foreground active:bg-accent"
        >
          <Home className="size-4" />
        </button>
      </div>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      <div className="max-h-56 overflow-y-auto rounded-xl border bg-card">
        {listing ? (
          <ul>
            {listing.parent ? (
              <li>
                <button
                  onPointerUp={() => load(listing.parent!)}
                  className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-sm active:bg-accent"
                >
                  <CornerLeftUp className="size-4 shrink-0 text-muted-foreground" />
                  <span className="text-muted-foreground">Up one level</span>
                </button>
              </li>
            ) : null}
            <li className="border-b">
              {newName === null ? (
                <button
                  onPointerUp={() => setNewName('')}
                  className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-sm text-primary active:bg-accent"
                >
                  <FolderPlus className="size-4 shrink-0" />
                  <span>New folder here…</span>
                </button>
              ) : (
                <div className="flex items-center gap-2 px-3 py-2">
                  <FolderPlus className="size-4 shrink-0 text-muted-foreground" />
                  <input
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') createNew();
                      if (e.key === 'Escape') setNewName(null);
                    }}
                    placeholder="folder-name"
                    autoFocus
                    spellCheck={false}
                    autoCapitalize="off"
                    className="min-w-0 flex-1 rounded-lg border bg-card px-2 py-1.5 text-sm outline-none focus:border-ring"
                  />
                  <button
                    onPointerUp={createNew}
                    disabled={!newName.trim()}
                    aria-label="Create and use folder"
                    className="rounded-full p-1.5 text-primary active:bg-accent disabled:opacity-40"
                  >
                    <Check className="size-4" />
                  </button>
                  <button
                    onPointerUp={() => setNewName(null)}
                    aria-label="Cancel new folder"
                    className="rounded-full p-1.5 text-muted-foreground active:bg-accent"
                  >
                    <X className="size-4" />
                  </button>
                </div>
              )}
            </li>
            {listing.dirs.map((d) => (
              <li key={d.path}>
                <button
                  onPointerUp={() => load(d.path)}
                  className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-sm active:bg-accent"
                >
                  <Folder className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">{d.name}</span>
                  <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
                </button>
              </li>
            ))}
            {listing.dirs.length === 0 && !listing.parent ? (
              <li className="px-3 py-2.5 text-sm text-muted-foreground">No subfolders</li>
            ) : null}
          </ul>
        ) : (
          <p className="px-3 py-2.5 text-sm text-muted-foreground">{error ? 'Type a path above.' : 'Loading…'}</p>
        )}
      </div>
      <DialogFooter className="gap-2">
        <Button variant="outline" className="h-11 flex-1 rounded-xl" onPointerUp={onCancel}>
          Back
        </Button>
        <Button
          className="h-11 flex-1 rounded-xl"
          disabled={!typed.trim().startsWith('/')}
          onPointerUp={() => {
            const path = typed.trim();
            if (path.startsWith('/')) onSelect(path);
          }}
        >
          {typedIsElsewhere ? 'Use typed path' : 'Use this folder'}
        </Button>
      </DialogFooter>
    </div>
  );
}
