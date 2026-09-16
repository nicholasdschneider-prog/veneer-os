import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { RotateCw } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { Button } from '@/components/ui/button';
import { Markdown } from '@/components/Markdown';
import { HtmlPreviewFrame, isHtmlFileName } from '@/components/chat/HtmlFilePreview';
import { isCodeFileName } from '@/components/chat/CodeFilePreview';
import { FilePreviewModeToggle, type FilePreviewMode } from '@/components/ui/file-preview-mode-toggle';
import { textSelectionForLocation } from '../../lib/projectFileLinks';

const CodeFileEditorSurface = lazy(() =>
  import('./CodeFileEditorSurface').then((module) => ({ default: module.CodeFileEditorSurface })),
);

type Phase =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'binary'; size: number | null }
  | { kind: 'too-large'; size: number | null }
  | { kind: 'ready' };

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatRelativeMtime(mtimeMs: number): string {
  const diff = Date.now() - mtimeMs;
  if (diff < 60_000) return 'just now';
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(mtimeMs).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** Pull the structured size out of a 413 'too-large' / 415 'binary' ApiError body. */
function errorSize(err: unknown): number | null {
  const body = err instanceof ApiError ? err.body : null;
  return body && typeof body.size === 'number' ? body.size : null;
}

/**
 * Editor for one file. Code uses the lazy Diffs edit surface; other text keeps
 * the lightweight textarea. Saves send the mtime from the last read/save so an
 * edit made behind our back surfaces as a 409 conflict instead of clobbering it.
 */
export function FileEditor({
  root,
  path,
  line,
  column,
  onToast,
  onDirtyChange,
}: {
  root: string;
  path: string;
  line?: number;
  column?: number;
  onToast: (message: string) => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [content, setContent] = useState('');
  const [savedContent, setSavedContent] = useState('');
  const [size, setSize] = useState(0);
  const [mtime, setMtime] = useState(0);
  const [loadRevision, setLoadRevision] = useState(0);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);

  // Renderable text files open as documents unless a source location was requested.
  const isMarkdown = /\.(md|markdown)$/i.test(path);
  const isHtml = isHtmlFileName(path);
  const isCode = isCodeFileName(path);
  const hasRenderedPreview = isMarkdown || isHtml;
  const [view, setView] = useState<FilePreviewMode>(hasRenderedPreview && !line ? 'rendered' : 'source');
  useEffect(
    () => setView(hasRenderedPreview && !line ? 'rendered' : 'source'),
    [hasRenderedPreview, line, path],
  );

  const dirty = phase.kind === 'ready' && content !== savedContent;
  useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange]);

  // Bumping the sequence orphans any in-flight load (path change or unmount).
  const seqRef = useRef(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const jumpedLocationRef = useRef('');
  const load = useCallback(async () => {
    const seq = ++seqRef.current;
    setPhase({ kind: 'loading' });
    setConflict(false);
    try {
      const r = await api.fileRead(root, path);
      if (seq !== seqRef.current) return;
      setContent(r.content);
      setSavedContent(r.content);
      setSize(r.size);
      setMtime(r.mtime);
      setLoadRevision((revision) => revision + 1);
      setPhase({ kind: 'ready' });
    } catch (err) {
      if (seq !== seqRef.current) return;
      const message = (err as Error).message;
      if (message === 'too-large') setPhase({ kind: 'too-large', size: errorSize(err) });
      else if (message === 'binary') setPhase({ kind: 'binary', size: errorSize(err) });
      else setPhase({ kind: 'error', message });
    }
  }, [root, path]);

  useEffect(() => {
    void load();
    return () => {
      seqRef.current += 1;
    };
  }, [load]);

  useEffect(() => {
    if (phase.kind !== 'ready' || view !== 'source' || isCode) return;
    const selection = textSelectionForLocation(content, { line, column });
    if (!selection) return;
    const jumpKey = `${path}:${line}:${column ?? ''}:${seqRef.current}`;
    if (jumpedLocationRef.current === jumpKey) return;
    const frame = window.requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      jumpedLocationRef.current = jumpKey;
      textarea.focus({ preventScroll: true });
      textarea.setSelectionRange(selection.start, selection.end);
      const lineHeight = Number.parseFloat(window.getComputedStyle(textarea).lineHeight) || 20;
      textarea.scrollTop = Math.max(0, selection.lineIndex * lineHeight - textarea.clientHeight / 3);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [column, content, isCode, line, path, phase.kind, view]);

  const save = useCallback(async () => {
    if (!dirty || saving) return;
    setSaving(true);
    try {
      const r = await api.fileWrite({ root, path, content, expectedMtime: mtime });
      setMtime(r.mtime);
      setSavedContent(content);
      setSize(new TextEncoder().encode(content).length);
      setConflict(false);
    } catch (err) {
      if ((err as Error).message === 'conflict') {
        // Keep our stale expectedMtime so re-saving still conflicts until the
        // user explicitly reloads.
        setConflict(true);
        onToast('This file changed on disk since you opened it.');
      } else {
        onToast(`Save failed: ${(err as Error).message}`);
      }
    } finally {
      setSaving(false);
    }
  }, [root, path, content, mtime, dirty, saving, onToast]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Tab') {
      // Tab indents (two spaces) instead of moving focus out of the editor.
      e.preventDefault();
      const el = e.currentTarget;
      el.setRangeText('  ', el.selectionStart, el.selectionEnd, 'end');
      setContent(el.value);
    }
  };

  const onEditorKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      void save();
    }
  };

  const name = path.split('/').pop() ?? path;

  if (phase.kind !== 'ready') {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-sm text-muted-foreground">
        {phase.kind === 'loading' ? (
          <p>Loading…</p>
        ) : phase.kind === 'error' ? (
          <p className="text-destructive">{phase.message}</p>
        ) : (
          <p>
            {phase.kind === 'binary'
              ? `${name} looks like a binary file, so it can't be edited here`
              : `${name} is too large to edit here (limit 2 MB)`}
            {phase.size != null ? ` — ${formatBytes(phase.size)}.` : '.'}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" onKeyDownCapture={onEditorKeyDown}>
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <p className="min-w-0 flex-1 truncate text-sm font-medium">
          {name}
          {dirty ? (
            <span className="ml-1.5 inline-block size-2 rounded-full bg-brand align-middle" aria-label="Unsaved changes" />
          ) : null}
        </p>
        {hasRenderedPreview ? (
          <FilePreviewModeToggle
            value={view}
            onChange={setView}
            renderedLabel={isMarkdown ? 'Preview' : 'Rendered'}
            sourceLabel={isMarkdown ? 'Text' : 'Source'}
          />
        ) : null}
        <Button size="sm" className="rounded-lg" onPointerUp={() => void save()} disabled={!dirty || saving}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>

      {conflict ? (
        <div className="flex items-center gap-2 border-b bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          <span className="min-w-0 flex-1">This file changed on disk. Reload to pick up the new version (discards your edits).</span>
          <Button variant="outline" size="sm" className="shrink-0 rounded-lg" onPointerUp={() => void load()}>
            <RotateCw />
            Reload from disk
          </Button>
        </div>
      ) : null}

      {isMarkdown && view === 'rendered' ? (
        <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
          <Markdown markdown={content} />
        </div>
      ) : isHtml && view === 'rendered' ? (
        <HtmlPreviewFrame html={content} title={name} />
      ) : isCode ? (
        <Suspense
          fallback={<p className="p-4 text-sm text-muted-foreground">Preparing code editor…</p>}
        >
          <CodeFileEditorSurface
            key={`${root}:${path}:${loadRevision}`}
            fileName={name}
            content={content}
            cacheKey={`${root}:${path}:${loadRevision}`}
            line={line}
            column={column}
            onChange={setContent}
          />
        </Suspense>
      ) : (
        <textarea
          ref={textareaRef}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          onKeyDown={onKeyDown}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          aria-label={`Contents of ${name}`}
          className="min-h-0 w-full flex-1 resize-none bg-transparent px-3 py-2.5 font-mono text-sm outline-none"
        />
      )}

      <div className="flex items-center justify-between gap-2 border-t px-3 py-1.5 text-xs text-muted-foreground">
        <span>{formatBytes(size)}</span>
        <span>{formatRelativeMtime(mtime)}</span>
      </div>
    </div>
  );
}
