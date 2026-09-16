import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { Clock3, Pencil, Play, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { PendingWakeup } from '@/lib/types';
import { QueuedMessageText } from './QueuedPeek';

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** A wake the user pulls in still needs a moment to be worth scheduling. */
const MIN_LEAD_MS = 60 * SECOND;
const TAP_SLOP_PX = 8;

export interface WakeupRelative {
  text: string;
  /** Seconds are ticking, so the label must not jitter in width. */
  tabular: boolean;
}

/**
 * Countdown bands: m:ss under two minutes, whole minutes up to 90, hours plus
 * minutes within a day, and a calendar label beyond that.
 */
export function formatWakeRelative(scheduledFor: string, now: Date = new Date()): WakeupRelative {
  const target = new Date(scheduledFor);
  if (Number.isNaN(target.getTime())) return { text: 'soon', tabular: false };
  const delta = target.getTime() - now.getTime();
  if (delta <= 0) return { text: 'now', tabular: false };
  if (delta < 2 * MINUTE) {
    const secs = Math.round(delta / SECOND);
    return { text: `in ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`, tabular: true };
  }
  if (delta < 90 * MINUTE) return { text: `in ${Math.round(delta / MINUTE)} min`, tabular: false };
  if (delta < DAY) {
    let hours = Math.floor(delta / HOUR);
    let mins = Math.round((delta - hours * HOUR) / MINUTE);
    if (mins === 60) {
      hours += 1;
      mins = 0;
    }
    return { text: mins ? `in ${hours} h ${mins} min` : `in ${hours} h`, tabular: false };
  }
  return { text: `${dayLabel(target, now)} ${clockLabel(target)}`, tabular: false };
}

/** How often the label changes: only the m:ss band needs a per-second tick. */
export function wakeTickMs(scheduledFor: string, now: Date = new Date()): number {
  const delta = new Date(scheduledFor).getTime() - now.getTime();
  return Number.isNaN(delta) || delta >= 2 * MINUTE ? 30 * SECOND : SECOND;
}

function clockLabel(date: Date): string {
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function dayLabel(target: Date, now: Date): string {
  const days = Math.round((startOfDay(target) - startOfDay(now)) / DAY);
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  return target.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

/** The absolute time shown next to the countdown, dated when it is not today. */
export function formatWakeClock(scheduledFor: string, now: Date = new Date()): string {
  const target = new Date(scheduledFor);
  if (Number.isNaN(target.getTime())) return '';
  const sameDay = startOfDay(target) === startOfDay(now);
  return sameDay ? clockLabel(target) : `${dayLabel(target, now)} ${clockLabel(target)}`;
}

/** Quick-chip arithmetic: relative to the edited time, never inside the lead. */
export function quickAdjust(currentIso: string, deltaMs: number, now: Date = new Date()): string {
  const base = new Date(currentIso).getTime();
  const floor = now.getTime() + MIN_LEAD_MS;
  return new Date(Math.max(floor, (Number.isNaN(base) ? now.getTime() : base) + deltaMs)).toISOString();
}

/** `<input type="datetime-local">` speaks local wall-clock with no zone. */
export function toLocalInputValue(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

export function fromLocalInputValue(value: string): string | null {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

const QUICK_STEPS: Array<{ label: string; ms: number }> = [
  { label: '−5m', ms: -5 * MINUTE },
  { label: '+5m', ms: 5 * MINUTE },
  { label: '+15m', ms: 15 * MINUTE },
  { label: '+1h', ms: HOUR },
  { label: '+1d', ms: DAY },
];

export function WakeupChip({
  wakeups,
  canManage = true,
  onFire,
  onCancel,
  onReschedule,
  defaultOpen = false,
  now,
}: {
  /** Pending only; the soonest is rendered collapsed. */
  wakeups: PendingWakeup[];
  canManage?: boolean;
  onFire: (id: string) => void;
  onCancel: (id: string) => void;
  onReschedule: (id: string, runAt: string) => Promise<{ ok: boolean; error?: string }>;
  /** Seeds the expanded state; the tap gesture owns it from then on. */
  defaultOpen?: boolean;
  /** Injectable clock so countdown bands are testable. */
  now?: Date;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [editError, setEditError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const pointerStart = useRef<{ x: number; y: number } | null>(null);

  const sorted = [...wakeups].sort((a, b) => a.scheduledFor.localeCompare(b.scheduledFor));
  const head = sorted[0];
  const clock = now ?? new Date();

  useEffect(() => {
    if (!head) return;
    const delay = wakeTickMs(head.scheduledFor);
    const timer = setInterval(() => setTick((value) => value + 1), delay);
    return () => clearInterval(timer);
    // `tick` is a dependency so the interval re-arms at the faster cadence
    // once the countdown crosses into the seconds band.
  }, [head?.scheduledFor, tick]);

  if (!head) return null;

  const relative = formatWakeRelative(head.scheduledFor, clock);
  const others = sorted.slice(1);

  const beginEdit = () => {
    setDraft(toLocalInputValue(head.scheduledFor));
    setEditError(null);
    setEditing(true);
  };

  const onTextPointerDown = (event: PointerEvent<HTMLElement>) => {
    pointerStart.current = { x: event.clientX, y: event.clientY };
  };

  const onTextPointerUp = (event: PointerEvent<HTMLElement>) => {
    const start = pointerStart.current;
    pointerStart.current = null;
    if (!start) return;
    if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > TAP_SLOP_PX) return;
    setOpen((value) => !value);
    setEditing(false);
  };

  const saveEdit = () => {
    const iso = fromLocalInputValue(draft);
    if (!iso) {
      setEditError('Pick a valid time.');
      return;
    }
    if (new Date(iso).getTime() <= Date.now()) {
      setEditError('That time has already passed.');
      return;
    }
    setBusy(head.id);
    void onReschedule(head.id, iso)
      .then((result) => {
        if (result.ok) {
          setEditing(false);
          setEditError(null);
        } else {
          setEditError(result.error ?? 'Could not move that wake-up.');
        }
      })
      .catch((err: Error) => setEditError(err.message))
      .finally(() => setBusy(null));
  };

  const progress = (() => {
    const start = new Date(head.createdAt).getTime();
    const end = new Date(head.scheduledFor).getTime();
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0;
    return Math.min(100, Math.max(0, ((clock.getTime() - start) / (end - start)) * 100));
  })();

  return (
    <div className="relative flex items-start gap-1.5 rounded-2xl bg-brand/[0.06] py-2 pr-1.5 pl-2">
      {/* A queued message waits on the agent; a wake waits on the clock. The
          marching dashes say "future action" at a glance. SVG because CSS
          borders cannot animate dash offset. */}
      <svg aria-hidden className="pointer-events-none absolute inset-0 size-full overflow-visible text-brand/40">
        <rect
          x="0.75"
          y="0.75"
          width="100%"
          height="100%"
          rx="21"
          // Attributes cannot use calc()/var(); CSS geometry properties can,
          // and browsers without them keep the plain attribute fallback above.
          style={{ width: 'calc(100% - 1.5px)', height: 'calc(100% - 1.5px)', rx: 'var(--radius-2xl)' }}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeDasharray="6 5"
          vectorEffect="non-scaling-stroke"
          className="vp-wake-march"
        />
      </svg>
      <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-brand/15 text-brand [&_svg]:size-4">
        <Clock3 />
      </span>
      <div className="min-w-0 flex-1 leading-tight">
        <div className="flex items-baseline gap-1.5">
          <button
            type="button"
            onPointerUp={() => (open && canManage ? beginEdit() : setOpen(true))}
            aria-label={open && canManage ? 'Change the wake-up time' : 'Show wake-up details'}
            className="shrink-0 text-left text-xs font-semibold whitespace-nowrap"
          >
            {sorted.length > 1 ? (
              `${sorted.length} wake-ups`
            ) : (
              <>
                Wakes <span className={cn(relative.tabular && 'tabular-nums')}>{relative.text}</span>
              </>
            )}
          </button>
          <span className="truncate text-[11px] text-muted-foreground">
            {sorted.length > 1
              ? `· next ${formatWakeClock(head.scheduledFor, clock)}`
              : `· ${formatWakeClock(head.scheduledFor, clock)}`}
          </span>
          {open && canManage ? (
            <button
              type="button"
              onPointerUp={beginEdit}
              aria-label="Edit wake-up time"
              title="Edit time"
              className="ml-auto flex size-7 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:text-foreground"
            >
              <Pencil className="size-3.5" />
            </button>
          ) : null}
        </div>
        <div onPointerDown={onTextPointerDown} onPointerUp={onTextPointerUp} className="cursor-pointer">
          {open ? (
            <QueuedMessageText
              text={head.reason}
              open
              subject="wake-up note"
              className="mt-1 text-xs text-muted-foreground"
            />
          ) : (
            <div className="mt-0.5 truncate text-xs text-muted-foreground">{head.reason}</div>
          )}
        </div>
        {open ? (
          <>
            <div className="mt-1.5 h-[3px] overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full bg-brand" style={{ width: `${progress}%` }} />
            </div>
            <p className="mt-1 truncate text-[10px] text-muted-foreground">key {head.key}</p>
          </>
        ) : null}
        {open && editing && canManage ? (
          <div className="mt-1.5 flex flex-wrap items-center gap-1">
            {QUICK_STEPS.map((step) => (
              <button
                key={step.label}
                type="button"
                onPointerUp={() => {
                  const next = quickAdjust(fromLocalInputValue(draft) ?? head.scheduledFor, step.ms);
                  setDraft(toLocalInputValue(next));
                  setEditError(null);
                }}
                className="rounded-full bg-foreground/8 px-2 py-0.5 text-[11px] font-medium text-muted-foreground hover:text-foreground"
              >
                {step.label}
              </button>
            ))}
            <input
              type="datetime-local"
              value={draft}
              onChange={(event) => {
                setDraft(event.target.value);
                setEditError(null);
              }}
              aria-label="Exact wake-up time"
              className="min-w-0 flex-1 rounded-md border bg-background px-1.5 py-0.5 text-[11px]"
            />
            <button
              type="button"
              onPointerUp={saveEdit}
              disabled={busy === head.id}
              className="rounded-full bg-brand/15 px-2.5 py-0.5 text-[11px] font-semibold text-brand disabled:opacity-40"
            >
              {busy === head.id ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              onPointerUp={() => {
                setEditing(false);
                setEditError(null);
              }}
              className="rounded-full px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground"
            >
              Cancel
            </button>
            {editError ? <p className="w-full text-[11px] text-destructive">{editError}</p> : null}
          </div>
        ) : null}
        {open && others.length ? (
          <ul className="mt-2 border-t border-foreground/5 pt-1.5">
            {others.map((wake) => (
              <li key={wake.id} className="flex items-center gap-1.5 py-0.5">
                <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground">
                  {formatWakeClock(wake.scheduledFor, clock)}
                </span>
                <span className="shrink-0 text-[11px] font-medium">{wake.key}</span>
                <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">{wake.reason}</span>
                {canManage ? (
                  <button
                    type="button"
                    onPointerUp={() => onCancel(wake.id)}
                    aria-label={`Cancel the ${wake.key} wake-up`}
                    className="flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:text-destructive"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                ) : null}
              </li>
            ))}
            {canManage ? (
              <li className="pt-1">
                <button
                  type="button"
                  onPointerUp={() => sorted.forEach((wake) => onCancel(wake.id))}
                  className="text-[11px] font-medium text-muted-foreground hover:text-destructive"
                >
                  Cancel all
                </button>
              </li>
            ) : null}
          </ul>
        ) : null}
      </div>
      {canManage ? (
        <>
          <button
            type="button"
            onPointerUp={() => {
              setBusy(head.id);
              onFire(head.id);
            }}
            disabled={busy === head.id}
            aria-label="Wake the agent now"
            title="Wake now"
            className="flex size-7 shrink-0 items-center justify-center rounded-full text-brand hover:bg-brand/10 disabled:opacity-40"
          >
            <Play className="size-4" />
          </button>
          <button
            type="button"
            onPointerUp={() => onCancel(head.id)}
            aria-label="Cancel the wake-up"
            title="Cancel"
            className="flex size-7 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:text-destructive"
          >
            <Trash2 className="size-4" />
          </button>
        </>
      ) : null}
    </div>
  );
}
