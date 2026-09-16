import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import {
  FileSpreadsheet,
  FileText,
  FolderOpen,
  Image as ImageIcon,
  Search,
  Trash2,
  X,
  type LucideIcon,
} from 'lucide-react';
import { api, type GeneratedFile } from '../lib/api';
import { formatBytes } from '../lib/format';
import { delimiterFor, parseDsv } from '../lib/csv';
import { DESKTOP_QUERY, useMediaQuery } from '../hooks/useMediaQuery';
import { cn } from '@/lib/utils';
import { CodeFilePreview, isCodeFileName } from '@/components/chat/CodeFilePreview';
import { HtmlFilePreview, isHtmlFileName } from '@/components/chat/HtmlFilePreview';

const MobilePdfViewer = lazy(() =>
  import('../components/chat/MobilePdfViewer').then((module) => ({ default: module.MobilePdfViewer })),
);
const OfficePreview = lazy(() =>
  import('../components/chat/OfficePreview').then((module) => ({ default: module.OfficePreview })),
);
import { Button } from '@/components/ui/button';
import { FileDownloadLink } from '@/components/ui/file-download-link';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

const IMAGE_RE = /\.(png|jpe?g|svg|gif)$/i;
const TABLE_RE = /\.(csv|tsv)$/i;
const PDF_RE = /\.pdf$/i;
const OFFICE_RE = /\.(docx|xlsx)$/i;
const CSV_PREVIEW_ROWS = 200;
const FILE_ROW_HEIGHT = 68;
const FIRST_GROUP_HEADER_HEIGHT = 26;
const GROUP_HEADER_HEIGHT = 42;
const FILE_LIST_OVERSCAN = FILE_ROW_HEIGHT * 8;

/** Leading icon by extension: spreadsheet, image, or generic document. */
function iconFor(name: string): LucideIcon {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  if (['csv', 'tsv', 'xls', 'xlsx'].includes(ext)) return FileSpreadsheet;
  if (['png', 'jpg', 'jpeg', 'svg', 'gif'].includes(ext)) return ImageIcon;
  return FileText;
}

// File-type buckets for the checkbox filter. Only buckets actually present in
// the loaded list are offered; checking none means "show everything".
const TYPE_BUCKETS = [
  { key: 'spreadsheets', label: 'Spreadsheets', exts: ['csv', 'tsv', 'xls', 'xlsx'] },
  { key: 'documents', label: 'Documents', exts: ['pdf', 'docx', 'pptx', 'txt', 'md', 'html'] },
  { key: 'images', label: 'Images', exts: ['png', 'jpg', 'jpeg', 'svg', 'gif'] },
  { key: 'data', label: 'Data', exts: ['json', 'zip'] },
] as const;

function typeBucketOf(name: string): string {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  return TYPE_BUCKETS.find((b) => (b.exts as readonly string[]).includes(ext))?.key ?? 'other';
}

// Recency bucket for list grouping, keyed off mtime (ms epoch). Calendar days,
// not 24h windows, mirroring ConversationList.
function groupLabel(mtime: number): string {
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOfDay(new Date()) - startOfDay(new Date(mtime))) / 86_400_000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return 'This week';
  if (days < 31) return 'This month';
  return 'Older';
}

// Contiguous recency runs over an mtime-desc-sorted list.
function groupByRecency(files: GeneratedFile[]): { label: string; items: GeneratedFile[] }[] {
  const groups: { label: string; items: GeneratedFile[] }[] = [];
  for (const f of files) {
    const label = groupLabel(f.mtime);
    const last = groups[groups.length - 1];
    if (last?.label === label) last.items.push(f);
    else groups.push({ label, items: [f] });
  }
  return groups;
}

export type VirtualFileRow =
  | { kind: 'heading'; key: string; label: string; top: number; height: number }
  | { kind: 'file'; key: string; file: GeneratedFile; position: number; top: number; height: number };

export function buildVirtualFileRows(groups: ReturnType<typeof groupByRecency>): {
  rows: VirtualFileRow[];
  height: number;
} {
  const rows: VirtualFileRow[] = [];
  let top = 0;
  let position = 0;
  groups.forEach((group, groupIndex) => {
    const height = groupIndex === 0 ? FIRST_GROUP_HEADER_HEIGHT : GROUP_HEADER_HEIGHT;
    rows.push({ kind: 'heading', key: `heading:${group.label}`, label: group.label, top, height });
    top += height;
    for (const file of group.items) {
      position += 1;
      rows.push({ kind: 'file', key: file.id, file, position, top, height: FILE_ROW_HEIGHT });
      top += FILE_ROW_HEIGHT;
    }
  });
  return { rows, height: top };
}

export function visibleVirtualFileRange(
  rows: VirtualFileRow[],
  scrollTop: number,
  viewportHeight: number,
  overscan = FILE_LIST_OVERSCAN,
): { start: number; end: number } {
  const lower = Math.max(0, scrollTop - overscan);
  const upper = scrollTop + Math.max(1, viewportHeight) + overscan;
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const row = rows[middle]!;
    if (row.top + row.height < lower) low = middle + 1;
    else high = middle;
  }
  const start = low;
  let end = start;
  while (end < rows.length && rows[end]!.top < upper) end += 1;
  return { start, end };
}

const NO_PROJECT = '__none__';

/**
 * The Files page: every deliverable file agents have generated across all chats,
 * recency-grouped, filterable by project, with preview/download/delete. A
 * top-level nav destination (no back button).
 */
export function Files({ onToast, onOpenChat }: { onToast: (m: string) => void; onOpenChat: (id: string) => void }) {
  const [files, setFiles] = useState<GeneratedFile[] | null>(null);
  const [pendingSync, setPendingSync] = useState(0);
  const [selected, setSelected] = useState<string>('all');
  const [query, setQuery] = useState('');
  const [checkedTypes, setCheckedTypes] = useState<Set<string>>(new Set());
  const [previewFile, setPreviewFile] = useState<GeneratedFile | null>(null);
  const [confirmFile, setConfirmFile] = useState<GeneratedFile | null>(null);
  const [deleting, setDeleting] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const [listViewport, setListViewport] = useState({ scrollTop: 0, height: 0 });

  // Load on mount. The server answers from the registry instantly and scans
  // stale chats in a background sweep; while it reports pendingSync > 0 we
  // refetch every ~1.5s to pick up newly indexed files. One big transcript can
  // hold the count flat across a poll or two, so only stop after several polls
  // with no progress (a truly wedged sweep, e.g. runner down).
  useEffect(() => {
    let stop = false;
    let timer: number | undefined;
    let lastPending = Infinity;
    let flatPolls = 0;
    const load = () => {
      void api
        .generatedFiles()
        .then((r) => {
          if (stop) return;
          setFiles(r.files);
          setPendingSync(r.pendingSync);
          if (r.pendingSync > 0) {
            flatPolls = r.pendingSync < lastPending ? 0 : flatPolls + 1;
            if (flatPolls < 4) timer = window.setTimeout(load, 1500);
          }
          lastPending = r.pendingSync;
        })
        .catch(() => {
          if (!stop) setFiles((prev) => prev ?? []);
        });
    };
    load();
    return () => {
      stop = true;
      if (timer) window.clearTimeout(timer);
    };
  }, []);

  // Distinct project buckets among loaded files. Chips only make sense when
  // there's more than one bucket to choose between.
  const { chips, showChips } = useMemo(() => {
    const list = files ?? [];
    const names: string[] = [];
    for (const f of list) {
      if (f.projectId && f.projectName && !names.includes(f.projectName)) names.push(f.projectName);
    }
    const hasNoProject = list.some((f) => !f.projectId);
    const hasProject = list.some((f) => f.projectId);
    const built: { key: string; label: string }[] = [{ key: 'all', label: 'All' }];
    for (const n of names) built.push({ key: n, label: n });
    if (hasNoProject && hasProject) built.push({ key: NO_PROJECT, label: 'No project' });
    const bucketCount = names.length + (hasNoProject ? 1 : 0);
    return { chips: built, showChips: bucketCount > 1 };
  }, [files]);

  // Type buckets present in the loaded list (checkbox row hides absent ones,
  // and disappears entirely when everything is one bucket).
  const availableTypes = useMemo(() => {
    const present = new Set((files ?? []).map((f) => typeBucketOf(f.name)));
    const buckets: { key: string; label: string }[] = TYPE_BUCKETS.filter((b) => present.has(b.key));
    if (present.has('other')) buckets.push({ key: 'other', label: 'Other' });
    return buckets;
  }, [files]);

  const filtered = useMemo(() => {
    let list = [...(files ?? [])].sort((a, b) => b.mtime - a.mtime);
    if (selected === NO_PROJECT) list = list.filter((f) => !f.projectId);
    else if (selected !== 'all') list = list.filter((f) => f.projectName === selected);
    if (checkedTypes.size) list = list.filter((f) => checkedTypes.has(typeBucketOf(f.name)));
    const q = query.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (f) =>
          f.name.toLowerCase().includes(q) ||
          (f.conversationTitle ?? '').toLowerCase().includes(q) ||
          (f.projectName ?? '').toLowerCase().includes(q),
      );
    }
    return list;
  }, [files, selected, checkedTypes, query]);

  const toggleType = (key: string) =>
    setCheckedTypes((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const doDelete = async (f: GeneratedFile) => {
    setDeleting(true);
    try {
      await api.deleteGeneratedFile(f.id);
      setFiles((prev) => prev?.filter((x) => x.id !== f.id) ?? prev);
      onToast('Deleted ' + f.name);
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Delete failed');
    } finally {
      setDeleting(false);
      setConfirmFile(null);
    }
  };

  const groups = useMemo(() => groupByRecency(filtered), [filtered]);
  const virtualLayout = useMemo(() => buildVirtualFileRows(groups), [groups]);
  const virtualRange = visibleVirtualFileRange(
    virtualLayout.rows,
    listViewport.scrollTop,
    listViewport.height || 800,
  );
  const virtualRows = virtualLayout.rows.slice(virtualRange.start, virtualRange.end);

  useEffect(() => {
    const element = listRef.current;
    if (!element) return;
    const measure = () => setListViewport((current) => ({ ...current, height: element.clientHeight }));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = 0;
    setListViewport((current) => ({ ...current, scrollTop: 0 }));
  }, [checkedTypes, query, selected]);

  return (
    <div className="mx-auto flex h-full max-w-2xl flex-col pt-[env(safe-area-inset-top)]">
      <header className="flex items-center justify-between px-5 pb-3 pt-6">
        <h1 className="text-2xl font-semibold">Files</h1>
      </header>

      <div className="relative px-5 pb-2">
        <Search className="pointer-events-none absolute top-1/2 left-8 size-4 -translate-y-[calc(50%+0.25rem)] text-muted-foreground" />
        <Input
          type="text"
          inputMode="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search files, chats, projects…"
          aria-label="Search files"
          className="h-10 rounded-xl pl-9 pr-9"
        />
        {query ? (
          <button
            type="button"
            onPointerUp={() => setQuery('')}
            aria-label="Clear search"
            className="absolute top-1/2 right-8 -translate-y-[calc(50%+0.25rem)] rounded-full p-1 text-muted-foreground active:bg-accent"
          >
            <X className="size-4" />
          </button>
        ) : null}
      </div>

      {availableTypes.length > 1 ? (
        <div className="flex gap-4 overflow-x-auto px-5 pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {availableTypes.map((t) => (
            <label
              key={t.key}
              className="flex shrink-0 cursor-pointer items-center gap-1.5 py-1 text-sm font-medium whitespace-nowrap text-muted-foreground has-checked:text-foreground"
            >
              <input
                type="checkbox"
                checked={checkedTypes.has(t.key)}
                onChange={() => toggleType(t.key)}
                className="size-4 accent-primary"
              />
              {t.label}
            </label>
          ))}
        </div>
      ) : null}

      {showChips ? (
        <div className="flex gap-2 overflow-x-auto px-5 pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {chips.map((c) => {
            const active = selected === c.key;
            return (
              <button
                key={c.key}
                type="button"
                onPointerUp={() => setSelected(c.key)}
                className={cn(
                  'shrink-0 rounded-full px-3 py-1 text-sm font-medium whitespace-nowrap transition-colors',
                  active ? 'bg-accent text-foreground' : 'text-muted-foreground active:bg-accent/60',
                )}
              >
                {c.label}
              </button>
            );
          })}
        </div>
      ) : null}

      <div
        ref={listRef}
        onScroll={(event) => {
          const scrollTop = event.currentTarget.scrollTop;
          setListViewport((current) => ({ ...current, scrollTop }));
        }}
        className="flex-1 overflow-y-auto px-3 pb-[calc(env(safe-area-inset-bottom)+1rem)]"
      >
        {files === null || (filtered.length === 0 && pendingSync > 0) ? (
          <p className="px-2 py-8 text-center text-muted-foreground">Loading…</p>
        ) : filtered.length === 0 && (files ?? []).length > 0 ? (
          <p className="px-2 py-16 text-center text-muted-foreground">
            No files match{query.trim() ? ` “${query.trim()}”` : ' the current filters'}.
          </p>
        ) : filtered.length === 0 ? (
          <div className="px-2 py-16 text-center">
            <FolderOpen className="mx-auto size-10 text-muted-foreground" />
            <p className="mt-3 text-lg font-medium">No files yet</p>
            <p className="mt-1 text-muted-foreground">
              When a chat creates a CSV, spreadsheet, PDF or image for you, it shows up here.
            </p>
          </div>
        ) : (
          <>
            <div
              role="list"
              aria-label={`${filtered.length} generated files`}
              data-file-virtual-list
              className="relative"
              style={{ height: virtualLayout.height }}
            >
              {virtualRows.map((row) => {
                if (row.kind === 'heading') {
                  return (
                    <h2
                      key={row.key}
                      className="absolute inset-x-0 flex items-end px-3 pb-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase"
                      style={{ top: row.top, height: row.height }}
                    >
                      {row.label}
                    </h2>
                  );
                }
                const f = row.file;
                const Icon = iconFor(f.name);
                const isImage = IMAGE_RE.test(f.name);
                return (
                      <div
                        key={row.key}
                        role="listitem"
                        aria-posinset={row.position}
                        aria-setsize={filtered.length}
                        className="absolute inset-x-0 flex items-center gap-1"
                        style={{ top: row.top, height: row.height }}
                      >
                        <button
                          onPointerUp={() => setPreviewFile(f)}
                          className="flex min-w-0 flex-1 items-center gap-3 rounded-xl px-3 py-3 text-left active:bg-accent"
                        >
                          {isImage ? (
                            <img
                              src={api.generatedFileDownloadUrl(f.id, { inline: true })}
                              alt=""
                              loading="lazy"
                              className="size-9 shrink-0 rounded-md border border-border bg-muted object-cover"
                              onError={(e) => {
                                // Fall back to the generic image glyph if the thumbnail can't load.
                                e.currentTarget.style.display = 'none';
                              }}
                            />
                          ) : (
                            <Icon className="size-5 shrink-0 text-muted-foreground" />
                          )}
                          <div className="min-w-0 flex-1">
                            <p className="truncate font-medium">{f.name}</p>
                            <p className="mt-0.5 truncate text-sm text-muted-foreground">
                              {formatBytes(f.size)} · {f.conversationTitle ?? 'Deleted chat'}
                              {f.projectName ? ` · ${f.projectName}` : ''}
                            </p>
                          </div>
                        </button>
                        <FileDownloadLink
                          href={api.generatedFileDownloadUrl(f.id, { name: f.name })}
                          name={f.name}
                          showLabel={false}
                          buttonVariant="ghost"
                          buttonSize="icon-lg"
                          className="h-11 w-11 shrink-0 rounded-full text-muted-foreground"
                          onPointerUp={(event) => event.stopPropagation()}
                          iconClassName="size-5"
                        />
                        <Button
                          variant="ghost"
                          size="icon-lg"
                          className="h-11 w-11 shrink-0 rounded-full text-muted-foreground"
                          onPointerUp={() => setConfirmFile(f)}
                          aria-label={`Delete ${f.name}`}
                        >
                          <Trash2 className="size-5" />
                        </Button>
                      </div>
                );
              })}
            </div>
            {pendingSync > 0 ? (
              <p className="px-3 py-3 text-center text-sm text-muted-foreground">Indexing older chats…</p>
            ) : null}
          </>
        )}
      </div>

      {previewFile ? (
        <PreviewDialog
          file={previewFile}
          onClose={() => setPreviewFile(null)}
          onOpenChat={onOpenChat}
          onDelete={(f) => {
            setPreviewFile(null);
            setConfirmFile(f);
          }}
        />
      ) : null}

      <Dialog open={confirmFile !== null} onOpenChange={(o) => !o && !deleting && setConfirmFile(null)}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle className="truncate pr-6">Delete {confirmFile?.name}?</DialogTitle>
            <DialogDescription>
              This permanently removes the file from disk. Chats that mention it will no longer be able to open it.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              className="h-11 flex-1 rounded-xl"
              onPointerUp={() => setConfirmFile(null)}
              disabled={deleting}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              className="h-11 flex-1 rounded-xl"
              onPointerUp={() => confirmFile && void doDelete(confirmFile)}
              disabled={deleting}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

type PreviewState =
  | { loading: true }
  | { loading: false; error: string }
  | { loading: false; content?: string; truncated?: boolean; binary?: boolean };

/** Fetches and renders a preview for one generated file (image / table / text). */
function PreviewDialog({
  file,
  onClose,
  onOpenChat,
  onDelete,
}: {
  file: GeneratedFile;
  onClose: () => void;
  onOpenChat: (id: string) => void;
  onDelete: (file: GeneratedFile) => void;
}) {
  const isImage = IMAGE_RE.test(file.name);
  const isTable = TABLE_RE.test(file.name);
  const isPdf = PDF_RE.test(file.name);
  const isOffice = OFFICE_RE.test(file.name);
  const isHtml = isHtmlFileName(file.name);
  const isCode = isCodeFileName(file.name);
  const isDesktop = useMediaQuery(DESKTOP_QUERY);
  const [state, setState] = useState<PreviewState>({ loading: true });

  useEffect(() => {
    if (isImage || isPdf || isOffice || isHtml) return; // these render straight from the inline download URL
    let stop = false;
    setState({ loading: true });
    void api
      .generatedFilePreview(file.id)
      .then((r) => {
        if (!stop) setState({ loading: false, content: r.content, truncated: r.truncated, binary: r.binary });
      })
      .catch((err: Error) => {
        if (!stop) setState({ loading: false, error: err.message });
      });
    return () => {
      stop = true;
    };
  }, [file.id, isHtml, isImage, isOffice, isPdf]);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className={cn('flex max-h-[85dvh] flex-col sm:max-w-2xl', (isPdf || isOffice || isHtml || isCode) && 'sm:max-w-5xl')}>
        <DialogHeader>
          <DialogTitle className="truncate pr-6">{file.name}</DialogTitle>
          <DialogDescription>
            {formatBytes(file.size)} · updated {new Date(file.mtime).toLocaleString()}
          </DialogDescription>
        </DialogHeader>

        <div
          className={cn(
            'min-h-0 flex-1 overflow-auto overscroll-contain rounded-xl border bg-card',
            (isPdf || isOffice || isHtml || isCode) && 'flex h-[70dvh]',
          )}
        >
          {isImage ? (
            <img
              src={api.generatedFileDownloadUrl(file.id, { inline: true })}
              alt={file.name}
              className="mx-auto max-h-[70dvh] w-auto object-contain"
            />
          ) : isPdf ? (
            isDesktop ? (
              <iframe
                src={api.generatedFileDownloadUrl(file.id, { inline: true })}
                title={file.name}
                className="min-h-0 flex-1 border-0 bg-white"
              />
            ) : (
              <Suspense
                fallback={<p className="p-4 text-sm text-muted-foreground">Preparing PDF viewer…</p>}
              >
                <MobilePdfViewer
                  url={api.generatedFileDownloadUrl(file.id, { inline: true })}
                  title={file.name}
                />
              </Suspense>
            )
          ) : isOffice ? (
            <Suspense fallback={<p className="p-4 text-sm text-muted-foreground">Preparing document preview…</p>}>
              <OfficePreview
                fileName={file.name}
                url={api.generatedFileDownloadUrl(file.id, { inline: true })}
              />
            </Suspense>
          ) : isHtml ? (
            <HtmlFilePreview
              key={file.id}
              title={file.name}
              url={api.generatedFileDownloadUrl(file.id, { inline: true })}
              loadSource={() => api.generatedFilePreview(file.id)}
            />
          ) : state.loading ? (
            <p className="p-4 text-sm text-muted-foreground">Loading preview…</p>
          ) : 'error' in state ? (
            <p className="p-4 text-sm text-destructive">{state.error}</p>
          ) : state.binary || state.content === undefined ? (
            <p className="p-8 text-center text-sm text-muted-foreground">No preview available</p>
          ) : isTable ? (
            <CsvTable text={state.content} delimiter={delimiterFor(file.name)} />
          ) : isCode ? (
            <CodeFilePreview
              fileName={file.name}
              content={state.content}
              cacheKey={`generated:${file.id}:${file.mtime}`}
            />
          ) : (
            <pre className="p-3 text-xs whitespace-pre-wrap">{state.content}</pre>
          )}
        </div>

        {!isHtml && !isImage && !state.loading && !('error' in state) && state.truncated ? (
          <p className="text-xs text-muted-foreground">Preview truncated — download for the full file.</p>
        ) : null}

        <DialogFooter className="flex-col items-stretch gap-2 sm:flex-col sm:items-stretch sm:space-x-0">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
            {file.conversationId ? (
              <button
                type="button"
                onPointerUp={() => {
                  onOpenChat(file.conversationId!);
                  onClose();
                }}
                className="truncate font-medium text-foreground underline-offset-2 active:underline"
              >
                {file.conversationTitle ?? 'Untitled chat'}
              </button>
            ) : (
              <span className="truncate">Deleted chat</span>
            )}
            {file.projectName ? <span className="truncate">· {file.projectName}</span> : null}
          </div>
          <div className="flex gap-2">
            <FileDownloadLink
              href={api.generatedFileDownloadUrl(file.id, { name: file.name })}
              name={file.name}
              buttonVariant="outline"
              buttonSize="default"
              className="h-11 flex-1 rounded-xl"
              iconClassName="size-4"
            />
            <Button
              variant="destructive"
              className="h-11 flex-1 rounded-xl"
              onPointerUp={() => onDelete(file)}
            >
              <Trash2 className="size-4" />
              Delete
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Lean CSV/TSV preview table, capped at CSV_PREVIEW_ROWS rows. */
function CsvTable({ text, delimiter }: { text: string; delimiter: string }) {
  const rows = useMemo(() => parseDsv(text, delimiter), [text, delimiter]);
  const [header, ...body] = rows;
  if (!header?.length) {
    return <p className="p-4 text-sm text-muted-foreground">Empty file.</p>;
  }
  const shown = body.slice(0, CSV_PREVIEW_ROWS);
  return (
    <>
      <table className="w-full border-collapse text-xs">
        <thead className="sticky top-0 bg-card shadow-[0_1px_0_var(--border)]">
          <tr>
            {header.map((h, i) => (
              <th key={i} className="px-2.5 py-1.5 text-left font-semibold whitespace-nowrap">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shown.map((r, i) => (
            <tr key={i} className="odd:bg-muted/40">
              {r.map((c, j) => (
                <td key={j} className="px-2.5 py-1 align-top whitespace-nowrap">
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {body.length > shown.length ? (
        <p className="border-t px-2.5 py-1.5 text-xs text-muted-foreground">
          Showing {shown.length} of {body.length} rows — download for the full file.
        </p>
      ) : null}
    </>
  );
}
