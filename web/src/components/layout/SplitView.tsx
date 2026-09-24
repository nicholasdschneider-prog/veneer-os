import { useEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { DESKTOP_QUERY, useMediaQuery } from '../../hooks/useMediaQuery';
import { VeneerMark } from '../VeneerMark';

/**
 * Generic master/detail shell. On desktop (md+) it renders `sidebar` at a
 * persisted, drag-resizable width next to the detail pane. On mobile it
 * renders ONLY the pane named by `mobileShows` — routing keeps swapping whole
 * screens there, exactly as before this component existed.
 *
 * The divider is a 7px hit area drawn as a 1px line; drag to resize (pointer
 * capture), double-click to reset, arrow keys when focused. The width is
 * per-device, persisted to localStorage under `storageKey` so each consumer
 * (chats, settings, …) remembers its own size.
 */
export function SplitView({
  storageKey,
  sidebar,
  children,
  mobileShows = 'sidebar',
  defaultWidth = 320,
  minWidth = 240,
  maxWidth = 520,
  side = 'left',
  sidebarHidden = false,
  detailMinWidth = 0,
  separatorLabel = 'Resize sidebar',
  keepDetailMountedOnMobile = false,
}: {
  storageKey: string;
  sidebar: ReactNode;
  children: ReactNode;
  mobileShows?: 'sidebar' | 'detail';
  defaultWidth?: number;
  minWidth?: number;
  maxWidth?: number;
  side?: 'left' | 'right';
  sidebarHidden?: boolean;
  detailMinWidth?: number;
  separatorLabel?: string;
  keepDetailMountedOnMobile?: boolean;
}) {
  const isDesktop = useMediaQuery(DESKTOP_QUERY);
  const clamp = (w: number) => Math.min(maxWidth, Math.max(minWidth, Math.round(w)));
  const [width, setWidth] = useState(() => {
    const stored = Number(localStorage.getItem(storageKey));
    return clamp(Number.isFinite(stored) && stored > 0 ? stored : defaultWidth);
  });
  const [dragging, setDragging] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const sidebarPaneRef = useRef<HTMLDivElement>(null);
  const dragFrom = useRef<{ x: number; width: number } | null>(null);
  const widthRef = useRef(width);
  widthRef.current = width;

  // CSS protects the detail pane when the viewport shrinks, which can make the
  // rendered sidebar narrower than its persisted width. Start interactions
  // from the rendered width and honor the live container size so the divider
  // never has a dead/stuck drag range after a resize.
  const clampVisible = (value: number): number => {
    const available = containerRef.current?.clientWidth;
    const liveMax = available && detailMinWidth ? Math.min(maxWidth, available - detailMinWidth) : maxWidth;
    const safeMax = Math.max(0, liveMax);
    const liveMin = Math.min(minWidth, safeMax);
    return Math.min(safeMax, Math.max(liveMin, Math.round(value)));
  };

  const persist = (w: number) => localStorage.setItem(storageKey, String(w));

  // Keep text unselectable while dragging — the pointer sweeps across both panes.
  useEffect(() => {
    if (!dragging) return;
    const prevSelect = document.body.style.userSelect;
    const prevCursor = document.body.style.cursor;
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
    return () => {
      document.body.style.userSelect = prevSelect;
      document.body.style.cursor = prevCursor;
    };
  }, [dragging]);

  if (!isDesktop) {
    if (!keepDetailMountedOnMobile) return <>{mobileShows === 'sidebar' ? sidebar : children}</>;
    return <div className="relative h-full min-h-0 min-w-0">
      <div className={cn('absolute inset-0 min-h-0',mobileShows!=='sidebar'&&'invisible pointer-events-none')} inert={mobileShows!=='sidebar'?true:undefined}>{sidebar}</div>
      <div className={cn('absolute inset-0 min-h-0',mobileShows!=='detail'&&'invisible pointer-events-none')} inert={mobileShows!=='detail'?true:undefined}>{children}</div>
    </div>;
  }

  const sidebarPane = (
    <div
      ref={sidebarPaneRef}
      aria-hidden={sidebarHidden}
      inert={sidebarHidden ? true : undefined}
      className={cn(
        'h-full min-w-0 shrink-0 overflow-hidden bg-shell-sidebar transition-[width,opacity] duration-200 ease-out',
        sidebarHidden && 'pointer-events-none opacity-0',
        dragging && 'transition-none',
      )}
      style={{
        width: sidebarHidden ? 0 : width,
        maxWidth: detailMinWidth ? `calc(100% - ${detailMinWidth}px)` : undefined,
      }}
    >
      {sidebar}
    </div>
  );
  const divider = (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={separatorLabel}
      tabIndex={sidebarHidden ? -1 : 0}
      onPointerDown={(e) => {
        if (sidebarHidden) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        const renderedWidth = clampVisible(sidebarPaneRef.current?.getBoundingClientRect().width ?? widthRef.current);
        widthRef.current = renderedWidth;
        setWidth(renderedWidth);
        dragFrom.current = { x: e.clientX, width: renderedWidth };
        setDragging(true);
      }}
      onPointerMove={(e) => {
        if (!dragFrom.current) return;
        const delta = (e.clientX - dragFrom.current.x) * (side === 'left' ? 1 : -1);
        const next = clampVisible(dragFrom.current.width + delta);
        widthRef.current = next;
        setWidth(next);
      }}
      onPointerUp={() => {
        if (!dragFrom.current) return;
        dragFrom.current = null;
        setDragging(false);
        persist(widthRef.current);
      }}
      onDoubleClick={() => {
        const next = clampVisible(defaultWidth);
        widthRef.current = next;
        setWidth(next);
        persist(next);
      }}
      onKeyDown={(e) => {
        const direction = side === 'left' ? 1 : -1;
        const step = e.key === 'ArrowLeft' ? -16 * direction : e.key === 'ArrowRight' ? 16 * direction : 0;
        if (!step) return;
        e.preventDefault();
        const next = clampVisible(widthRef.current + step);
        widthRef.current = next;
        setWidth(next);
        persist(next);
      }}
      className={cn(
        'group relative z-10 -mx-[3px] w-[7px] shrink-0 cursor-col-resize outline-none',
        sidebarHidden && 'pointer-events-none mx-0 w-0 overflow-hidden opacity-0',
      )}
    >
      <div
        className={cn(
          'absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border transition-colors',
          'group-hover:w-[3px] group-hover:bg-primary/40 group-focus-visible:w-[3px] group-focus-visible:bg-primary/60',
          dragging && 'w-[3px] bg-primary/60',
        )}
      />
    </div>
  );
  const detailPane = <div className="h-full min-w-0 flex-1 bg-background">{children}</div>;

  return (
    <div ref={containerRef} className="flex h-full min-w-0">
      {side === 'left' ? (
        <>
          {sidebarPane}
          {divider}
          {detailPane}
        </>
      ) : (
        <>
          {detailPane}
          {divider}
          {sidebarPane}
        </>
      )}
    </div>
  );
}

/** Desktop-only detail pane filler for when nothing is selected yet. */
export function SplitPlaceholder({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1 px-8 text-center">
      <VeneerMark className="mb-4 size-9 text-muted-foreground/40" />
      <p className="text-lg font-medium text-muted-foreground">{title}</p>
      {hint ? <p className="text-sm text-muted-foreground/80">{hint}</p> : null}
    </div>
  );
}
