import { useEffect, useRef, useState } from 'react';
import { cn } from '../../lib/utils';
import { EmbeddedPreviewFrame } from '../ui/embedded-preview-frame';
import { FilePreviewModeToggle, type FilePreviewMode } from '../ui/file-preview-mode-toggle';

const HTML_FILE_RE = /\.html?$/i;

export interface HtmlSourcePreview {
  content?: string;
  truncated?: boolean;
  binary?: boolean;
}

type SourceState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; preview: HtmlSourcePreview };

export function isHtmlFileName(fileName: string): boolean {
  return HTML_FILE_RE.test(fileName);
}

type HtmlPreviewFrameProps = {
  title: string;
  className?: string;
} & ({ url: string; html?: never } | { html: string; url?: never });

/**
 * Active HTML always runs inside Veneer's opaque-origin sandbox. URL previews
 * use the existing inline endpoint and CSP. Editor previews use srcDoc and stay
 * intentionally self-contained; they never gain implicit access to sibling files.
 */
export function HtmlPreviewFrame({ title, className, ...source }: HtmlPreviewFrameProps) {
  const frameSource = 'url' in source ? { src: source.url } : { srcDoc: source.html };
  return (
    <EmbeddedPreviewFrame
      {...frameSource}
      title={title}
      className={cn('min-h-0 w-full flex-1 border-0 bg-white', className)}
    />
  );
}

export function HtmlFilePreview({
  title,
  url,
  loadSource,
  className,
}: {
  title: string;
  url: string;
  loadSource: () => Promise<HtmlSourcePreview>;
  className?: string;
}) {
  const [mode, setMode] = useState<FilePreviewMode>('rendered');
  const [source, setSource] = useState<SourceState>({ status: 'idle' });
  const requestRef = useRef(0);

  useEffect(
    () => () => {
      requestRef.current += 1;
    },
    [],
  );

  const changeMode = (next: FilePreviewMode) => {
    setMode(next);
    if (next !== 'source' || source.status !== 'idle') return;
    const request = ++requestRef.current;
    setSource({ status: 'loading' });
    void loadSource()
      .then((preview) => {
        if (requestRef.current === request) setSource({ status: 'ready', preview });
      })
      .catch((error: Error) => {
        if (requestRef.current === request) setSource({ status: 'error', message: error.message });
      });
  };

  return (
    <div className={cn('flex min-h-0 flex-1 flex-col bg-card', className)}>
      <div className="flex shrink-0 justify-end border-b px-2 py-1.5">
        <FilePreviewModeToggle value={mode} onChange={changeMode} />
      </div>
      {mode === 'rendered' ? (
        <HtmlPreviewFrame url={url} title={title} />
      ) : (
        <div className="min-h-0 flex-1 overflow-auto overscroll-contain">
          {source.status === 'idle' || source.status === 'loading' ? (
            <p className="p-4 text-sm text-muted-foreground">Loading source…</p>
          ) : source.status === 'error' ? (
            <p className="p-4 text-sm text-destructive">{source.message}</p>
          ) : source.preview.binary || source.preview.content === undefined ? (
            <p className="p-4 text-sm text-muted-foreground">No text source is available.</p>
          ) : (
            <pre className="p-3 text-xs whitespace-pre-wrap break-words">{source.preview.content}</pre>
          )}
          {source.status === 'ready' && source.preview.truncated ? (
            <p className="sticky bottom-0 border-t bg-background px-4 py-2 text-xs text-muted-foreground">
              Source shows the first part of this file. Download it to view everything.
            </p>
          ) : null}
        </div>
      )}
    </div>
  );
}
