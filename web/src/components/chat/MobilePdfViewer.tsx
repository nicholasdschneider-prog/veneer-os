import { useEffect, useState } from 'react';
import { CircleAlert, LoaderCircle, ZoomIn, ZoomOut } from 'lucide-react';
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from 'pdfjs-dist';
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist/legacy/build/pdf.mjs';
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import { PdfPageCanvas } from './PdfPageCanvas';

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

interface MobilePdfViewerProps {
  title: string;
  url: string;
}

type ViewerState =
  | { status: 'loading' }
  | { status: 'ready'; document: PDFDocumentProxy }
  | { status: 'error'; message: string };

const MIN_ZOOM = 1;
const MAX_ZOOM = 2.5;
const ZOOM_STEP = 0.25;

export function MobilePdfViewer({ title, url }: MobilePdfViewerProps) {
  const [state, setState] = useState<ViewerState>({ status: 'loading' });
  const [zoom, setZoom] = useState(1);

  useEffect(() => {
    let stopped = false;
    let loadingTask: PDFDocumentLoadingTask | null = null;
    setState({ status: 'loading' });

    try {
      loadingTask = getDocument({ url });
      void loadingTask.promise
        .then((document) => {
          if (!stopped) setState({ status: 'ready', document });
        })
        .catch((error: unknown) => {
          if (stopped) return;
          setState({
            status: 'error',
            message: error instanceof Error ? error.message : 'The PDF could not be loaded.',
          });
        });
    } catch (error) {
      setState({
        status: 'error',
        message: error instanceof Error ? error.message : 'The PDF could not be loaded.',
      });
    }

    return () => {
      stopped = true;
      void loadingTask?.destroy();
    };
  }, [url]);

  if (state.status === 'loading') {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 bg-muted/30 px-6 text-sm text-muted-foreground">
        <LoaderCircle className="size-6 animate-spin" aria-hidden="true" />
        <p role="status">Loading PDF…</p>
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center bg-muted/30 p-6">
        <div className="max-w-sm text-center">
          <CircleAlert className="mx-auto size-8 text-destructive" aria-hidden="true" />
          <p className="mt-3 font-medium">Couldn’t display this PDF</p>
          <p className="mt-2 text-sm text-muted-foreground">{state.message}</p>
          <p className="mt-3 text-xs text-muted-foreground">You can still open or download it from the toolbar.</p>
        </div>
      </div>
    );
  }

  const numPages = state.document.numPages;
  const zoomOut = () => setZoom((z) => Math.max(MIN_ZOOM, Math.round((z - ZOOM_STEP) * 100) / 100));
  const zoomIn = () => setZoom((z) => Math.min(MAX_ZOOM, Math.round((z + ZOOM_STEP) * 100) / 100));

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-muted/30" aria-label={`${title} PDF viewer`}>
      <div className="flex items-center justify-between gap-2 border-b border-border/60 bg-background/70 px-3 py-1.5 text-xs text-muted-foreground backdrop-blur">
        <span>
          {numPages} {numPages === 1 ? 'page' : 'pages'}
        </span>
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            onClick={zoomOut}
            disabled={zoom <= MIN_ZOOM}
            aria-label="Zoom out"
            className="rounded-md p-1.5 hover:bg-accent disabled:opacity-40"
          >
            <ZoomOut className="size-4" aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => setZoom(1)}
            aria-label="Reset zoom"
            className="min-w-[3rem] rounded-md px-1.5 py-1 tabular-nums hover:bg-accent"
          >
            {Math.round(zoom * 100)}%
          </button>
          <button
            type="button"
            onClick={zoomIn}
            disabled={zoom >= MAX_ZOOM}
            aria-label="Zoom in"
            className="rounded-md p-1.5 hover:bg-accent disabled:opacity-40"
          >
            <ZoomIn className="size-4" aria-hidden="true" />
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto overscroll-contain px-2 pt-3 pb-[calc(env(safe-area-inset-bottom)+1rem)]">
        {/* Width drives zoom: at 100% the column caps at 48rem; above that it
            overflows and the container scrolls. PdfPageCanvas measures its own
            width, so pages stay crisp at any zoom. */}
        <div
          className="mx-auto flex flex-col"
          style={{ width: `${zoom * 100}%`, maxWidth: zoom <= 1 ? '48rem' : 'none' }}
        >
          {Array.from({ length: numPages }, (_, index) => (
            <PdfPageCanvas key={index + 1} document={state.document} pageNumber={index + 1} />
          ))}
        </div>
      </div>
    </div>
  );
}
