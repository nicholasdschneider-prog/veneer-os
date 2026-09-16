import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { Minimize2, Monitor, X } from 'lucide-react';
import { requestJson } from '../../lib/api';

/**
 * In-app picture-in-picture for the shared VM Desktop (the visible Chrome an
 * agent drives, watchable at /desktop). A floating self-view thumbnail pops up
 * when an agent starts browsing; tapping it goes fullscreen and interactive.
 *
 * Three states: hidden | mini | full. A desktop chat can register its right
 * column as the full-view surface; mobile and non-chat screens keep the global
 * full-screen overlay. The iframe is remounted on every state change because
 * the viewer reads its query params once at load.
 */

export type DesktopState = 'hidden' | 'mini' | 'full';
type Corner = 'tl' | 'tr' | 'bl' | 'br';

interface DesktopControls {
  state: DesktopState;
  show: (next: 'mini' | 'full') => void;
  hide: () => void;
  setDockAvailable: (available: boolean) => void;
}

const DesktopContext = createContext<DesktopControls | null>(null);

export function useFloatingDesktop(): DesktopControls {
  const ctx = useContext(DesktopContext);
  if (!ctx) throw new Error('useFloatingDesktop must be used within FloatingDesktopProvider');
  return ctx;
}

export function shouldDockDesktop(state: DesktopState, isDesktop: boolean): boolean {
  return state === 'full' && isDesktop;
}

const CORNER_KEY = 'vp:desktop-corner';
const MINI_W = 180;
const MINI_H = 120;
const EDGE = 12;
const ACTIVITY_FRESH_MS = 90_000;
const POLL_MS = 12_000;

// The CDP viewer at /desktop, which reads these once at load: view=only is the
// non-interactive thumbnail, chrome=off drops its heading because the overlay
// below already draws one. (This used to point at /usr/share/novnc, which the
// server stopped serving when the desktop moved to CDP.)
const MINI_SRC = '/desktop?view=only';
const FULL_SRC = '/desktop?chrome=off';

function readCorner(): Corner {
  const stored = localStorage.getItem(CORNER_KEY);
  return stored === 'tl' || stored === 'tr' || stored === 'bl' || stored === 'br' ? stored : 'br';
}

// env()/--vp-nav-h can't be read off custom properties via getComputedStyle, so
// measure the real safe-area insets from a throwaway probe element.
function safeInsets(): { top: number; right: number; bottom: number; left: number } {
  const probe = document.createElement('div');
  probe.style.cssText =
    'position:fixed;visibility:hidden;pointer-events:none;top:0;left:0;' +
    'padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);';
  document.body.appendChild(probe);
  const cs = getComputedStyle(probe);
  const insets = {
    top: parseFloat(cs.paddingTop) || 0,
    right: parseFloat(cs.paddingRight) || 0,
    bottom: parseFloat(cs.paddingBottom) || 0,
    left: parseFloat(cs.paddingLeft) || 0,
  };
  probe.remove();
  return insets;
}

// Pixel top-left for a corner, clearing safe-area insets and the mobile nav bar
// (a left rail on desktop, so no bottom clearance there).
function cornerToPos(corner: Corner): { x: number; y: number } {
  const insets = safeInsets();
  const navH = window.innerWidth >= 768 ? 0 : insets.bottom + 56; // 3.5rem bar
  const top = EDGE + insets.top;
  const left = EDGE + insets.left;
  const maxX = Math.max(left, window.innerWidth - MINI_W - insets.right - EDGE);
  const maxY = Math.max(top, window.innerHeight - MINI_H - navH - EDGE);
  return {
    x: corner === 'tl' || corner === 'bl' ? left : maxX,
    y: corner === 'tl' || corner === 'tr' ? top : maxY,
  };
}

function nearestCorner(x: number, y: number): Corner {
  const cx = x + MINI_W / 2;
  const cy = y + MINI_H / 2;
  const horiz = cx < window.innerWidth / 2 ? 'l' : 'r';
  const vert = cy < window.innerHeight / 2 ? 't' : 'b';
  return `${vert}${horiz}` as Corner;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

interface MiniViewProps {
  autoPopped: boolean;
  onExpand: () => void;
  onDismiss: () => void;
}

function MiniView({ autoPopped, onExpand, onDismiss }: MiniViewProps) {
  const [pos, setPos] = useState(() => cornerToPos(readCorner()));
  const drag = useRef<{ startX: number; startY: number; baseX: number; baseY: number; moved: boolean } | null>(null);

  // Re-anchor to the stored corner on viewport changes (rotation / resize).
  useEffect(() => {
    const onResize = () => {
      if (drag.current) return;
      setPos(cornerToPos(readCorner()));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    (event.target as HTMLElement).setPointerCapture(event.pointerId);
    drag.current = { startX: event.clientX, startY: event.clientY, baseX: pos.x, baseY: pos.y, moved: false };
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const dx = event.clientX - d.startX;
    const dy = event.clientY - d.startY;
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) d.moved = true;
    setPos({
      x: clamp(d.baseX + dx, EDGE, Math.max(EDGE, window.innerWidth - MINI_W - EDGE)),
      y: clamp(d.baseY + dy, EDGE, Math.max(EDGE, window.innerHeight - MINI_H - EDGE)),
    });
  };

  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (!d.moved) {
      onExpand();
      return;
    }
    // Snap to the nearest corner and persist it.
    setPos((current) => {
      const corner = nearestCorner(current.x, current.y);
      localStorage.setItem(CORNER_KEY, corner);
      return cornerToPos(corner);
    });
  };

  return (
    <div
      className="fixed z-40 overflow-hidden rounded-2xl border border-border bg-black shadow-xl"
      style={{ left: pos.x, top: pos.y, width: MINI_W, height: MINI_H }}
    >
      <iframe
        src={MINI_SRC}
        title="Agent's browser (live)"
        className="pointer-events-none h-full w-full border-0 bg-black"
        tabIndex={-1}
      />
      {/* Transparent layer so drag / tap gestures never reach the iframe. */}
      <div
        className="absolute inset-0 touch-none cursor-grab active:cursor-grabbing"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        role="button"
        aria-label="Watch the agent's browser — tap to expand"
      />
      {autoPopped ? (
        <span className="pointer-events-none absolute top-1.5 left-1.5 flex items-center gap-1 rounded-full bg-black/60 px-2 py-0.5 text-[10px] font-medium text-white">
          <span className="size-1.5 rounded-full bg-brand" />
          Agent browsing
        </span>
      ) : null}
      <button
        type="button"
        onPointerUp={(event) => {
          event.stopPropagation();
          onDismiss();
        }}
        className="absolute top-1 right-1 flex size-6 items-center justify-center rounded-full bg-black/60 text-white"
        aria-label="Dismiss live view"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}

interface FullViewProps {
  onMinimize: () => void;
  onHide: () => void;
}

export function FullView({ onMinimize, onHide }: FullViewProps) {
  return (
    <div className="fixed inset-0 z-[45] flex flex-col bg-black">
      <header className="flex items-center gap-2 border-b border-white/10 bg-neutral-900 py-2 pt-[calc(env(safe-area-inset-top)+0.5rem)] pr-[calc(env(safe-area-inset-right)+0.75rem)] pl-[calc(env(safe-area-inset-left)+0.75rem)] text-white">
        <Monitor className="size-5 shrink-0 text-white/70" />
        <p className="min-w-0 flex-1 truncate font-medium">VM Desktop</p>
        <button
          type="button"
          onPointerUp={onMinimize}
          className="flex size-[48px] shrink-0 items-center justify-center rounded-full text-white/80 hover:bg-white/10 md:size-9"
          aria-label="Minimize to thumbnail"
        >
          <Minimize2 className="size-5" />
        </button>
        <button
          type="button"
          onPointerUp={onHide}
          className="flex size-[48px] shrink-0 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20 md:size-9"
          aria-label="Close live view"
        >
          <X className="size-5" />
        </button>
      </header>
      <iframe
        src={FULL_SRC}
        title="VM Desktop (live)"
        className="min-h-0 flex-1 border-0 bg-black"
        allow="clipboard-read; clipboard-write"
      />
    </div>
  );
}

export function DesktopPanel({ onMinimize, onHide }: FullViewProps) {
  return (
    <div className="flex h-full min-w-0 flex-col bg-background">
      <header className="flex items-center gap-2 border-b border-border px-3 py-2">
        <Monitor className="size-5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">Agent Browser</p>
          <p className="truncate text-xs text-muted-foreground">Shared desktop · Live</p>
        </div>
        <button
          type="button"
          onPointerUp={onMinimize}
          className="flex size-9 items-center justify-center rounded-full text-muted-foreground hover:bg-accent"
          aria-label="Minimize browser to thumbnail"
        >
          <Minimize2 className="size-5" />
        </button>
        <button
          type="button"
          onPointerUp={onHide}
          className="flex size-9 items-center justify-center rounded-full text-muted-foreground hover:bg-accent"
          aria-label="Close browser panel"
        >
          <X className="size-5" />
        </button>
      </header>
      <iframe
        src={FULL_SRC}
        title="Agent Browser (live)"
        className="min-h-0 flex-1 border-0 bg-black"
        allow="clipboard-read; clipboard-write"
      />
    </div>
  );
}

export function FloatingDesktopProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<DesktopState>('hidden');
  const [autoPopped, setAutoPopped] = useState(false);
  const [dockAvailable, setDockAvailable] = useState(false);
  // Refs keep the polling effect stable while reading live values.
  const stateRef = useRef(state);
  stateRef.current = state;
  const dismissedAtRef = useRef(0);

  const show = useCallback((next: 'mini' | 'full') => {
    setAutoPopped(false);
    setState(next);
  }, []);

  const hide = useCallback(() => {
    dismissedAtRef.current = Date.now();
    setAutoPopped(false);
    setState('hidden');
  }, []);
  const updateDockAvailable = useCallback((available: boolean) => setDockAvailable(available), []);

  // Auto-pop the mini view while an agent is actively browsing. Polls only when
  // the tab is visible; a dismissal silences it until strictly newer activity.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;

    const poll = async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        const res = await requestJson<{ activeAt: string | null }>('/api/desktop/activity');
        const activeAt = res.activeAt ? Date.parse(res.activeAt) : NaN;
        if (
          Number.isFinite(activeAt) &&
          Date.now() - activeAt < ACTIVITY_FRESH_MS &&
          activeAt > dismissedAtRef.current &&
          stateRef.current === 'hidden'
        ) {
          setAutoPopped(true);
          setState('mini');
        }
      } catch {
        /* not signed in / member / offline — never pop */
      }
    };

    const loop = () => {
      timer = setTimeout(async () => {
        await poll();
        if (!stopped) loop();
      }, POLL_MS);
    };
    void poll();
    loop();

    const onVisible = () => {
      if (document.visibilityState === 'visible') void poll();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  const value = useMemo<DesktopControls>(
    () => ({ state, show, hide, setDockAvailable: updateDockAvailable }),
    [hide, show, state, updateDockAvailable],
  );

  return (
    <DesktopContext.Provider value={value}>
      {children}
      {state === 'mini' ? (
        <MiniView autoPopped={autoPopped} onExpand={() => show('full')} onDismiss={hide} />
      ) : null}
      {state === 'full' && !dockAvailable ? (
        <FullView onMinimize={() => show('mini')} onHide={hide} />
      ) : null}
    </DesktopContext.Provider>
  );
}
