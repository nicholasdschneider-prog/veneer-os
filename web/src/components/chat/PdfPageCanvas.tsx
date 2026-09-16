import { useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from 'pdfjs-dist';

const DEFAULT_PAGE_RATIO = 8.5 / 11;
const MAX_OUTPUT_SCALE = 2;

interface PdfPageCanvasProps {
  document: PDFDocumentProxy;
  pageNumber: number;
}

function clearCanvas(canvas: HTMLCanvasElement | null): void {
  if (!canvas) return;
  canvas.width = 1;
  canvas.height = 1;
}

export function PdfPageCanvas({ document, pageNumber }: PdfPageCanvasProps) {
  const frameRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [nearViewport, setNearViewport] = useState(false);
  const [width, setWidth] = useState(0);
  const [pageRatio, setPageRatio] = useState(DEFAULT_PAGE_RATIO);
  const [rendering, setRendering] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        const next = entry?.isIntersecting === true;
        setNearViewport(next);
        if (!next) {
          setRendering(false);
          clearCanvas(canvasRef.current);
        }
      },
      { rootMargin: '1000px 0px' },
    );
    observer.observe(frame);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!nearViewport) return;
    const frame = frameRef.current;
    if (!frame) return;
    const measure = () => setWidth(Math.round(frame.getBoundingClientRect().width));
    const observer = new ResizeObserver(measure);
    observer.observe(frame);
    measure();
    return () => observer.disconnect();
  }, [nearViewport]);

  useEffect(() => {
    if (!nearViewport || width <= 0) return;
    let stopped = false;
    let page: PDFPageProxy | null = null;
    let renderTask: RenderTask | null = null;
    setRendering(true);
    setError(false);

    void document
      .getPage(pageNumber)
      .then((loadedPage) => {
        if (stopped) return;
        page = loadedPage;
        const naturalViewport = loadedPage.getViewport({ scale: 1 });
        const scale = width / naturalViewport.width;
        const viewport = loadedPage.getViewport({ scale });
        const outputScale = Math.min(window.devicePixelRatio || 1, MAX_OUTPUT_SCALE);
        const canvas = canvasRef.current;
        if (!canvas) return;

        setPageRatio(viewport.width / viewport.height);
        canvas.width = Math.max(1, Math.floor(viewport.width * outputScale));
        canvas.height = Math.max(1, Math.floor(viewport.height * outputScale));
        renderTask = loadedPage.render({
          canvas,
          viewport,
          transform: outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0],
        });
        return renderTask.promise;
      })
      .then(() => {
        if (!stopped) setRendering(false);
      })
      .catch((renderError: unknown) => {
        if (stopped || (renderError instanceof Error && renderError.name === 'RenderingCancelledException')) return;
        setRendering(false);
        setError(true);
      });

    return () => {
      stopped = true;
      renderTask?.cancel();
      page?.cleanup();
    };
  }, [document, nearViewport, pageNumber, width]);

  return (
    <section className="w-full" aria-label={`Page ${pageNumber}`}>
      <div
        ref={frameRef}
        className="relative w-full overflow-hidden rounded-sm border border-border/70 bg-white shadow-sm"
        style={{ aspectRatio: pageRatio }}
      >
        <canvas
          ref={canvasRef}
          className="block h-full w-full bg-white"
          role="img"
          aria-label={`Rendered PDF page ${pageNumber}`}
        />
        {!nearViewport || rendering ? (
          <div className="absolute inset-0 animate-pulse bg-muted/30" aria-hidden="true" />
        ) : null}
        {error ? (
          <div className="absolute inset-0 flex items-center justify-center bg-white px-6 text-center text-sm text-destructive">
            Page {pageNumber} could not be rendered.
          </div>
        ) : null}
      </div>
      <p className="py-2 text-center text-[11px] text-muted-foreground">Page {pageNumber}</p>
    </section>
  );
}
