import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Hand, Minus } from 'lucide-react';
import { BotAvatar } from './BotIdentity';

export type PillPosition = { x: number; y: number };
export type PillState = { position: PillPosition | null; minimized: boolean };
type Size = { width: number; height: number };

const STORAGE_KEY = 'veneer.desk-pill.v1';
const MARGIN = 8;
/** Pointer travel, in CSS pixels, before a press becomes a drag instead of a click. */
export const DRAG_THRESHOLD = 6;

/** Keep the whole pill on screen, with a small margin, whatever was saved. */
export function clampPillPosition(position: PillPosition, size: Size, viewport: Size): PillPosition {
  const maxX = Math.max(MARGIN, viewport.width - size.width - MARGIN);
  const maxY = Math.max(MARGIN, viewport.height - size.height - MARGIN);
  return {
    x: Math.round(Math.min(Math.max(position.x, MARGIN), maxX)),
    y: Math.round(Math.min(Math.max(position.y, MARGIN), maxY)),
  };
}

export function isDrag(start: PillPosition, current: PillPosition): boolean {
  return Math.hypot(current.x - start.x, current.y - start.y) >= DRAG_THRESHOLD;
}

/** Per-device presentation state. Anything unreadable falls back to the default corner. */
export function readPillState(storage: Pick<Storage, 'getItem'> | null | undefined): PillState {
  try {
    const raw = JSON.parse(storage?.getItem(STORAGE_KEY) ?? 'null') as Partial<PillState> | null;
    const p = raw?.position;
    const position = p && Number.isFinite(p.x) && Number.isFinite(p.y) ? { x: p.x, y: p.y } : null;
    return { position, minimized: raw?.minimized === true };
  } catch {
    return { position: null, minimized: false };
  }
}

export function writePillState(storage: Pick<Storage, 'setItem'> | null | undefined, state: PillState): void {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* private mode or full storage: the pill still works for this visit */
  }
}

const localStore = () => (typeof window === 'undefined' ? null : window.localStorage);

/**
 * The always-available floating entry to the question desk: the bot at the
 * front of the question line, the waiting count, and the owner's chief of
 * staff. It can be dragged anywhere and minimized to a single avatar.
 */
export function DeskPill({
  front,
  total,
  error,
  chief,
  onOpenQuestions,
  onOpenList,
  onOpenChief,
  initialState,
}: {
  front: { id: string; name: string } | null;
  total: number;
  error: boolean;
  chief: { id: string; name: string } | null;
  onOpenQuestions: () => void;
  onOpenList: () => void;
  onOpenChief: () => void;
  /** Test seam; the stored per-device state is used when omitted. */
  initialState?: PillState;
}) {
  const [state, setState] = useState<PillState>(() => initialState ?? readPillState(localStore()));
  const ref = useRef<HTMLDivElement>(null);
  const stop = useRef<(() => void) | null>(null);
  const suppressClick = useRef(false);
  const update = (next: PillState) => {
    setState(next);
    writePillState(localStore(), next);
  };
  const clamp = (position: PillPosition): PillPosition => {
    const box = ref.current?.getBoundingClientRect();
    return clampPillPosition(
      position,
      { width: box?.width ?? 0, height: box?.height ?? 0 },
      { width: window.innerWidth, height: window.innerHeight },
    );
  };
  // A saved spot can fall off screen after a resize, a rotation, or when the
  // pill changes size (minimize, a longer name, a new count).
  useLayoutEffect(() => {
    const fit = () =>
      setState((current) => {
        if (!current.position) return current;
        const next = clamp(current.position);
        return next.x === current.position.x && next.y === current.position.y ? current : { ...current, position: next };
      });
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [state.minimized, front?.name, chief?.name, total]);
  useEffect(() => () => stop.current?.(), []);

  // Movement is tracked on the window: a quick drag leaves the pill before
  // it has moved, and capturing on press would swallow the buttons' clicks.
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const box = ref.current!.getBoundingClientRect();
    const id = e.pointerId;
    const p = { start: { x: e.clientX, y: e.clientY }, origin: { x: box.left, y: box.top }, dragging: false };
    stop.current?.();
    const move = (event: PointerEvent) => {
      if (event.pointerId !== id) return;
      const now = { x: event.clientX, y: event.clientY };
      if (!p.dragging && !isDrag(p.start, now)) return;
      p.dragging = true;
      setState((current) => ({ ...current, position: clamp({ x: p.origin.x + now.x - p.start.x, y: p.origin.y + now.y - p.start.y }) }));
    };
    const end = (event: PointerEvent) => {
      if (event.pointerId !== id) return;
      stop.current?.();
      if (!p.dragging) return;
      // The browser still fires a click on the button under the pointer.
      suppressClick.current = true;
      window.setTimeout(() => { suppressClick.current = false; }, 0);
      setState((current) => { writePillState(localStore(), current); return current; });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    stop.current = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      stop.current = null;
    };
  };

  const avatar = chief ?? front;
  const label = front ? `${front.name} has a question` : 'Open question desk';
  return (
    <div
      ref={ref}
      data-desk-pill
      data-minimized={state.minimized || undefined}
      style={state.position ? { left: state.position.x, top: state.position.y, right: 'auto', bottom: 'auto' } : undefined}
      className="fixed bottom-[calc(env(safe-area-inset-bottom)+4.5rem)] right-3 z-40 flex touch-none select-none items-center gap-1 rounded-full border bg-background p-1 lg:bottom-4"
      onPointerDown={onPointerDown}
      onClickCapture={(e) => {
        if (!suppressClick.current) return;
        suppressClick.current = false;
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      {state.minimized ? (
        <button
          type="button"
          className="relative flex min-h-12 min-w-12 items-center justify-center rounded-full hover:bg-muted"
          aria-label={`Show ${chief ? `${chief.name} and ` : ''}${total} waiting questions`}
          onClick={() => update({ ...state, minimized: false })}
        >
          {avatar ? <BotAvatar id={avatar.id} name={avatar.name} /> : <Hand className="size-4" />}
          {(total > 0 || error) && (
            <span className="absolute -top-1 -right-1 min-w-5 rounded-full border bg-background px-1 text-center text-xs tabular-nums">
              {error ? '!' : total}
            </span>
          )}
        </button>
      ) : (
        <>
          {chief && (
            <button
              type="button"
              className="flex min-h-12 items-center gap-2 rounded-full px-2 text-sm hover:bg-muted"
              aria-label={`Chat with ${chief.name}`}
              onClick={onOpenChief}
            >
              <BotAvatar id={chief.id} name={chief.name} />
              <span>{chief.name}</span>
            </button>
          )}
          {(front || total > 0 || error || !chief) && (
            <button type="button" className="flex min-h-12 items-center gap-2 rounded-full px-3 text-sm hover:bg-muted" onClick={onOpenQuestions} aria-label={label}>
              {front && front.id !== chief?.id ? <BotAvatar id={front.id} name={front.name} /> : null}
              <Hand className="size-4" />
              <span>{front?.name ?? 'Questions'}</span>
              {error && <span>!</span>}
            </button>
          )}
          <button type="button" className="min-h-12 min-w-12 rounded-full px-3 text-sm tabular-nums hover:bg-muted" aria-label={`Choose from ${total} waiting questions`} onClick={onOpenList}>
            {total}
          </button>
          <button type="button" className="flex min-h-12 min-w-10 items-center justify-center rounded-full text-muted-foreground hover:bg-muted" aria-label="Minimize" onClick={() => update({ ...state, minimized: true })}>
            <Minus className="size-4" />
          </button>
        </>
      )}
    </div>
  );
}
