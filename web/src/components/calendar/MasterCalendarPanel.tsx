import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { BellRing, ChevronLeft, ChevronRight, Mail, Plus, RefreshCw, Settings2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import {
  calendarApi,
  calendarPanel,
  formatTime,
  layoutDay,
  LEAD_CHOICES,
  localZone,
  startOfDay,
  useCalendarPanel,
  type CalEvent,
  type CalendarAccount,
  type CalendarSettings,
} from '@/lib/masterCalendar';
import { EventDetails, EventEditor, type Draft } from './EventDialogs';
import { enableCalendarPush } from './ReminderHost';

const HOUR_PX = 48;
const SNAP_MIN = 15;
const DAY_MS = 86_400_000;
const REFRESH_MS = 60_000;
const INVITES_REFRESH_MS = 5 * 60_000;
type SettingsPatch = Parameters<typeof calendarApi.updateSettings>[0];
const errorText = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong.');

type Drag = { key: string; mode: 'move' | 'resize'; originY: number; originX: number; startMs: number; endMs: number; dayShift: number; deltaMin: number; moved: boolean };

export function MasterCalendarPanel({ desktop }: { desktop: boolean }) {
  const panel = useCalendarPanel();
  if (!panel.open) return null;
  return <PanelBody desktop={desktop} />;
}

function PanelBody({ desktop }: { desktop: boolean }) {
  const panel = useCalendarPanel();
  const [events, setEvents] = useState<CalEvent[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [accounts, setAccounts] = useState<CalendarAccount[] | null>(null);
  const [settings, setSettings] = useState<CalendarSettings | null>(null);
  const [invites, setInvites] = useState<CalEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showInvites, setShowInvites] = useState(false);
  const [selected, setSelected] = useState<CalEvent | null>(null);
  const [editing, setEditing] = useState<{ event: CalEvent | null; draft: Draft | null } | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [pendingMove, setPendingMove] = useState<{ event: CalEvent; startMs: number; endMs: number } | null>(null);
  const [now, setNow] = useState(Date.now());
  const scroller = useRef<HTMLDivElement>(null);
  const columnsRef = useRef<HTMLDivElement>(null);
  const days = panel.viewDays;
  const fromMs = panel.dayMs;
  const toMs = startOfDay(fromMs + days * DAY_MS + 12 * 3_600_000);

  const load = useCallback(
    async (fresh = false) => {
      setLoading(true);
      try {
        const r = await calendarApi.events(fromMs, toMs, fresh);
        setEvents(r.events);
        setErrors(r.errors);
      } catch (e) {
        setErrors([errorText(e)]);
      } finally {
        setLoading(false);
      }
    },
    [fromMs, toMs],
  );
  const loadMeta = useCallback(async () => {
    try {
      const [a, s] = await Promise.all([calendarApi.accounts(), calendarApi.settings()]);
      setAccounts(a.accounts);
      setSettings(s);
    } catch (e) {
      setErrors([errorText(e)]);
    }
  }, []);
  const loadInvites = useCallback(async () => {
    try {
      const start = Date.now();
      const r = await calendarApi.events(start, start + 14 * DAY_MS);
      setInvites(r.events.filter((e) => e.canRespond && e.selfResponse === 'needsAction'));
    } catch {
      // The day view shows the error already.
    }
  }, []);

  useEffect(() => void loadMeta(), [loadMeta]);
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => !document.hidden && void load(), REFRESH_MS);
    const onVisible = () => !document.hidden && void load();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [load, panel.changed]);
  useEffect(() => {
    void loadInvites();
    const timer = window.setInterval(() => !document.hidden && void loadInvites(), INVITES_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [loadInvites, panel.changed]);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  const defaultScroll = () => Math.max(0, (new Date().getHours() - 1) * HOUR_PX);
  // The timeline remounts when settings close; put it back where it was.
  const scrollerRef = useCallback((el: HTMLDivElement | null) => {
    scroller.current = el;
    if (el) el.scrollTop = calendarPanel.get().scrollTop ?? defaultScroll();
  }, []);
  // "Today" clears the remembered position.
  useLayoutEffect(() => {
    if (panel.scrollTop === null && scroller.current) scroller.current.scrollTop = defaultScroll();
  }, [panel.scrollTop]);

  const dayStarts = useMemo(() => Array.from({ length: days }, (_, i) => startOfDay(fromMs + i * DAY_MS + 12 * 3_600_000)), [fromMs, days]);
  const allDay = events.filter((e) => e.allDay || e.endMs - e.startMs >= DAY_MS);
  const timed = events.filter((e) => !(e.allDay || e.endMs - e.startMs >= DAY_MS));

  const shown = (e: CalEvent) => {
    if (!drag || drag.key !== e.key) return e;
    const delta = drag.deltaMin * 60_000;
    return drag.mode === 'move'
      ? { ...e, startMs: drag.startMs + delta + drag.dayShift * DAY_MS, endMs: drag.endMs + delta + drag.dayShift * DAY_MS }
      : { ...e, endMs: Math.max(drag.startMs + SNAP_MIN * 60_000, drag.endMs + delta) };
  };

  const firstWritable = () => {
    for (const a of accounts ?? []) {
      const c = a.calendars.find((x) => x.writable && x.primary) ?? a.calendars.find((x) => x.writable);
      if (c) return { connectorId: a.connectorId, calendarId: c.id };
    }
    return null;
  };
  const newEvent = (startMs?: number) => {
    const target = firstWritable();
    if (!target) {
      setNotice('Connect a Google Calendar with Full access in Settings → Connectors to add events.');
      return;
    }
    const base = startMs ?? Math.ceil(Date.now() / (30 * 60_000)) * 30 * 60_000;
    setEditing({ event: null, draft: { ...target, startMs: base, endMs: base + 60 * 60_000, allDay: false } });
  };

  const onGridClick = (e: React.MouseEvent<HTMLDivElement>, day: number) => {
    if (drag) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const minutes = Math.floor(((e.clientY - rect.top) / HOUR_PX) * 2) * 30;
    newEvent(day + minutes * 60_000);
  };

  const startDrag = (ev: ReactPointerEvent, e: CalEvent, mode: Drag['mode']) => {
    if (!e.canEdit || !desktop) return;
    ev.stopPropagation();
    (ev.target as Element).setPointerCapture?.(ev.pointerId);
    setDrag({ key: e.key, mode, originY: ev.clientY, originX: ev.clientX, startMs: e.startMs, endMs: e.endMs, dayShift: 0, deltaMin: 0, moved: false });
  };
  const onPointerMove = (ev: ReactPointerEvent) => {
    if (!drag) return;
    const deltaMin = Math.round(((ev.clientY - drag.originY) / HOUR_PX) * (60 / SNAP_MIN)) * SNAP_MIN;
    const width = (columnsRef.current?.getBoundingClientRect().width ?? 1) / days;
    const dayShift = drag.mode === 'move' && days > 1 ? Math.round((ev.clientX - drag.originX) / width) : 0;
    const moved = drag.moved || Math.abs(ev.clientY - drag.originY) > 4 || Math.abs(ev.clientX - drag.originX) > 8;
    if (deltaMin !== drag.deltaMin || dayShift !== drag.dayShift || moved !== drag.moved) setDrag({ ...drag, deltaMin, dayShift, moved });
  };
  const onPointerUp = (e: CalEvent) => {
    if (!drag) return;
    const d = drag;
    setDrag(null);
    if (!d.moved) {
      setSelected(e);
      return;
    }
    const next = shown(e);
    if (next.startMs === e.startMs && next.endMs === e.endMs) return;
    setPendingMove({ event: e, startMs: next.startMs, endMs: next.endMs });
  };

  // A move with guests asks whether to email them; without guests it just saves.
  useEffect(() => {
    if (!pendingMove) return;
    if (pendingMove.event.attendees.some((a) => !a.self)) return;
    void commitMove(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingMove]);
  const commitMove = async (notifyGuests: boolean) => {
    const move = pendingMove;
    if (!move) return;
    setPendingMove(null);
    setEvents((list) => list.map((x) => (x.key === move.event.key ? { ...x, startMs: move.startMs, endMs: move.endMs } : x)));
    try {
      await calendarApi.update(move.event, {
        allDay: false,
        start: new Date(move.startMs).toISOString(),
        end: new Date(move.endMs).toISOString(),
        timeZone: localZone(),
        notifyGuests,
      });
      setNotice(null);
    } catch (err) {
      setNotice(errorText(err));
    }
    void load(true);
  };

  const updateSettings = async (patch: SettingsPatch) => {
    try {
      setSettings(await calendarApi.updateSettings(patch));
      await loadMeta();
      calendarPanel.refresh();
    } catch (e) {
      setNotice(errorText(e));
    }
  };

  const label = (() => {
    const first = new Date(dayStarts[0]!);
    const today = startOfDay(Date.now());
    if (days === 1) {
      const rel = dayStarts[0] === today ? 'Today' : dayStarts[0] === today + DAY_MS ? 'Tomorrow' : dayStarts[0] === today - DAY_MS ? 'Yesterday' : null;
      const date = first.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
      return rel ? `${rel} · ${date}` : date;
    }
    return `${first.toLocaleDateString([], { month: 'short', day: 'numeric' })} – ${new Date(dayStarts[days - 1]!).toLocaleDateString([], { month: 'short', day: 'numeric' })}`;
  })();

  const noAccounts = accounts !== null && accounts.length === 0;
  const selectedLead = selected && settings ? settings.calendarLeads[`${selected.connectorId}:${selected.calendarId}`] : undefined;

  return (
    <aside
      aria-label="Calendar"
      className={cn(
        'flex min-h-0 flex-col bg-background',
        desktop ? 'w-[360px] shrink-0 border-l border-border' : 'fixed inset-0 z-40 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]',
      )}
    >
      <header className="flex shrink-0 items-center gap-1 border-b px-2 py-2">
        <Button variant="ghost" size="icon-sm" onClick={() => calendarPanel.shiftDays(-days)} aria-label="Previous">
          <ChevronLeft />
        </Button>
        <Button variant="ghost" size="icon-sm" onClick={() => calendarPanel.shiftDays(days)} aria-label="Next">
          <ChevronRight />
        </Button>
        <button type="button" className="min-w-0 flex-1 truncate text-left text-sm font-medium" onClick={() => calendarPanel.today()} title="Go to today">
          {label}
        </button>
        <div className="flex rounded-lg border p-0.5 text-xs">
          {([1, 3] as const).map((n) => (
            <button key={n} type="button" onClick={() => calendarPanel.setViewDays(n)} className={cn('rounded-md px-1.5 py-0.5', days === n ? 'bg-muted font-medium' : 'text-muted-foreground')} aria-pressed={days === n}>
              {n}d
            </button>
          ))}
        </div>
        <Button variant="ghost" size="icon-sm" onClick={() => newEvent()} aria-label="New event">
          <Plus />
        </Button>
        <Button variant="ghost" size="icon-sm" onClick={() => setShowSettings((v) => !v)} aria-label="Calendar settings" aria-pressed={showSettings}>
          <Settings2 />
        </Button>
        <Button variant="ghost" size="icon-sm" onClick={() => calendarPanel.setOpen(false)} aria-label="Close calendar">
          <X />
        </Button>
      </header>

      {invites.length ? (
        <button type="button" onClick={() => setShowInvites((v) => !v)} className="flex shrink-0 items-center gap-2 border-b bg-amber-500/10 px-3 py-2 text-left text-sm">
          <Mail className="size-4 text-amber-600" />
          <span className="flex-1">
            {invites.length} invite{invites.length === 1 ? '' : 's'} waiting for your answer
          </span>
          <span className="text-xs text-muted-foreground">{showInvites ? 'Hide' : 'Review'}</span>
        </button>
      ) : null}
      {showInvites && invites.length ? (
        <ul className="max-h-48 shrink-0 overflow-y-auto border-b">
          {invites.map((e) => (
            <li key={e.key}>
              <button type="button" onClick={() => setSelected(e)} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted">
                <span className="size-2.5 shrink-0 rounded-full" style={{ background: e.color }} />
                <span className="min-w-0 flex-1 truncate">{e.title}</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {new Date(e.startMs).toLocaleDateString([], { month: 'short', day: 'numeric' })} {e.allDay ? '' : formatTime(e.startMs)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {notice ? (
        <div className="flex shrink-0 items-start gap-2 border-b bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <span className="flex-1">{notice}</span>
          <button type="button" onClick={() => setNotice(null)} aria-label="Dismiss">
            <X className="size-4" />
          </button>
        </div>
      ) : null}

      {showSettings ? (
        <SettingsView accounts={accounts} settings={settings} onChange={updateSettings} onRefresh={() => void (loadMeta(), load(true))} />
      ) : noAccounts ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted-foreground">
          <p>No Google Calendar is connected yet.</p>
          <a className="text-primary underline" href="#/settings/connections?tab=apps">
            Connect one in Settings → Connectors
          </a>
        </div>
      ) : (
        <>
          {errors.length ? (
            <details className="shrink-0 border-b px-3 py-1.5 text-xs text-muted-foreground">
              <summary className="cursor-pointer">Some calendars could not be read ({errors.length})</summary>
              <ul className="mt-1 space-y-0.5">
                {errors.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            </details>
          ) : null}
          {days > 1 ? (
            <div className="flex shrink-0 border-b pl-10 text-center text-xs">
              {dayStarts.map((d) => (
                <div key={d} className={cn('flex-1 py-1', d === startOfDay(now) && 'font-semibold text-primary')}>
                  {new Date(d).toLocaleDateString([], { weekday: 'short', day: 'numeric' })}
                </div>
              ))}
            </div>
          ) : null}
          {allDay.length ? (
            <div className="flex max-h-24 shrink-0 flex-col gap-0.5 overflow-y-auto border-b py-1 pr-1 pl-10">
              {allDay.map((e) => (
                <button
                  key={e.key}
                  type="button"
                  onClick={() => setSelected(e)}
                  className="truncate rounded px-1.5 py-0.5 text-left text-xs text-white"
                  style={{ background: e.color, opacity: e.selfResponse === 'declined' ? 0.5 : 1 }}
                >
                  {e.title}
                </button>
              ))}
            </div>
          ) : null}
          <div ref={scrollerRef} className="relative min-h-0 flex-1 overflow-y-auto" onScroll={(e) => calendarPanel.rememberScroll(e.currentTarget.scrollTop)}>
            <div className="relative flex" style={{ height: 24 * HOUR_PX }}>
              <div className="w-10 shrink-0 text-right text-[0.625rem] text-muted-foreground">
                {Array.from({ length: 24 }, (_, h) => (
                  <div key={h} className="relative pr-1" style={{ height: HOUR_PX }}>
                    {h ? <span className="-translate-y-1/2 absolute right-1">{new Date(2000, 0, 1, h).toLocaleTimeString([], { hour: 'numeric' })}</span> : null}
                  </div>
                ))}
              </div>
              <div ref={columnsRef} className="relative flex flex-1" onPointerMove={onPointerMove}>
                {dayStarts.map((day) => {
                  const dayEnd = day + DAY_MS;
                  const items = layoutDay(timed.map(shown).filter((e) => e.startMs < dayEnd && e.endMs > day));
                  return (
                    <div key={day} className="relative flex-1 border-l" onClick={(e) => onGridClick(e, day)}>
                      {Array.from({ length: 24 }, (_, h) => (
                        <div key={h} className="border-t border-border/60" style={{ height: HOUR_PX }} />
                      ))}
                      {now >= day && now < dayEnd ? (
                        <div className="pointer-events-none absolute right-0 left-0 z-20 h-0.5 bg-red-500" style={{ top: ((now - day) / 3_600_000) * HOUR_PX }}>
                          <span className="-left-1 -top-1 absolute size-2.5 rounded-full bg-red-500" />
                        </div>
                      ) : null}
                      {items.map((e) => {
                        const top = (Math.max(e.startMs, day) - day) / 60_000 / 60 * HOUR_PX;
                        const height = Math.max(18, ((Math.min(e.endMs, dayEnd) - Math.max(e.startMs, day)) / 3_600_000) * HOUR_PX - 1);
                        const declined = e.selfResponse === 'declined';
                        const invite = e.canRespond && e.selfResponse === 'needsAction';
                        const original = events.find((x) => x.key === e.key)!;
                        return (
                          <div
                            key={e.key}
                            role="button"
                            tabIndex={0}
                            aria-label={`${e.title}, ${formatTime(e.startMs)} to ${formatTime(e.endMs)}`}
                            onClick={(ev) => ev.stopPropagation()}
                            onKeyDown={(ev) => ev.key === 'Enter' && setSelected(original)}
                            onPointerDown={(ev) => startDrag(ev, original, 'move')}
                            onPointerUp={(ev) => {
                              ev.stopPropagation();
                              if (drag) onPointerUp(original);
                              else setSelected(original);
                            }}
                            className={cn(
                              'absolute z-10 overflow-hidden rounded-md border px-1.5 py-0.5 text-[0.7rem] leading-tight shadow-sm select-none',
                              original.canEdit && desktop ? 'cursor-grab touch-none' : 'cursor-pointer',
                              drag?.key === e.key && 'z-30 opacity-90 ring-2 ring-primary',
                              declined && 'line-through opacity-50',
                            )}
                            style={{
                              top,
                              height,
                              left: `calc(${(e.column / e.columns) * 100}% + 1px)`,
                              width: `calc(${100 / e.columns}% - 3px)`,
                              background: invite ? 'var(--background)' : `color-mix(in srgb, ${e.color} 22%, var(--background))`,
                              borderColor: e.color,
                              borderStyle: invite ? 'dashed' : 'solid',
                              borderLeftWidth: 3,
                            }}
                          >
                            <div className="truncate font-medium">{e.title}</div>
                            {height > 30 ? (
                              <div className="truncate text-muted-foreground">
                                {formatTime(e.startMs)}
                                {e.location ? ` · ${e.location}` : ''}
                              </div>
                            ) : null}
                            {original.canEdit && desktop ? (
                              <div className="absolute right-0 bottom-0 left-0 h-1.5 cursor-ns-resize" onPointerDown={(ev) => startDrag(ev, original, 'resize')} aria-hidden />
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
          <footer className="flex shrink-0 items-center justify-between border-t px-3 py-1 text-[0.65rem] text-muted-foreground">
            <span className="flex flex-wrap gap-x-2">
              {(accounts ?? []).map((a) => (
                <span key={a.connectorId} className="flex items-center gap-1">
                  <span className="size-2 rounded-full" style={{ background: a.color }} />
                  {a.account.split('@')[1] ?? a.account}
                </span>
              ))}
            </span>
            <button type="button" onClick={() => void load(true)} aria-label="Refresh calendar" className={cn(loading && 'animate-spin')}>
              <RefreshCw className="size-3.5" />
            </button>
          </footer>
        </>
      )}

      <EventDetails
        event={selected}
        defaultLead={selectedLead !== undefined ? selectedLead : (settings?.defaultLeadMinutes ?? 10)}
        leadOverride={selected && 'leadOverride' in selected ? selected.leadOverride : undefined}
        onClose={() => setSelected(null)}
        onEdit={(e) => {
          setSelected(null);
          setEditing({ event: e, draft: null });
        }}
        onChanged={(e) => {
          setSelected(e);
          void load(true);
          void loadInvites();
        }}
      />
      <EventEditor
        open={editing !== null}
        event={editing?.event ?? null}
        draft={editing?.draft ?? null}
        accounts={accounts ?? []}
        onClose={() => setEditing(null)}
        onSaved={(e) => {
          setEditing(null);
          setSelected(e);
          void load(true);
        }}
      />
      {pendingMove && pendingMove.event.attendees.some((a) => !a.self) ? (
        <div className="absolute inset-x-2 bottom-12 z-40 rounded-xl border bg-card p-3 text-sm shadow-lg">
          <p className="mb-2">
            Move “{pendingMove.event.title}” to {formatTime(pendingMove.startMs)}?
          </p>
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setPendingMove(null)}>
              Cancel
            </Button>
            <Button variant="outline" size="sm" onClick={() => void commitMove(false)}>
              Move, don’t email
            </Button>
            <Button size="sm" onClick={() => void commitMove(true)}>
              Move and email guests
            </Button>
          </div>
        </div>
      ) : null}
    </aside>
  );
}

function leadValue(v: number | null | undefined) {
  return v === undefined ? 'default' : String(v);
}
function parseLead(v: string): number | null {
  return v === 'null' ? null : Number(v);
}

function SettingsView({
  accounts,
  settings,
  onChange,
  onRefresh,
}: {
  accounts: CalendarAccount[] | null;
  settings: CalendarSettings | null;
  onChange: (patch: SettingsPatch) => Promise<void>;
  onRefresh: () => void;
}) {
  const [push, setPush] = useState<string | null>(null);
  if (!accounts || !settings) return <div className="p-4 text-sm text-muted-foreground">Loading…</div>;
  const permission = typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
  return (
    <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3 text-sm">
      <section className="space-y-2">
        <h3 className="font-medium">Reminders</h3>
        <label className="flex items-center justify-between gap-2">
          <span>Default</span>
          <select
            className="h-8 rounded-lg border bg-background px-2"
            value={String(settings.defaultLeadMinutes)}
            onChange={(e) => void onChange({ defaultLeadMinutes: parseLead(e.target.value) })}
          >
            {LEAD_CHOICES.map((c) => (
              <option key={String(c.value)} value={String(c.value)}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-2">
            <BellRing className="size-4" /> Notifications on this device
          </span>
          {permission === 'granted' && localStorage.getItem('veneer:push-device') ? (
            <span className="text-xs text-emerald-600">On</span>
          ) : (
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                void enableCalendarPush()
                  .then(() => setPush('Notifications are on for this device.'))
                  .catch((e: unknown) => setPush(errorText(e)))
              }
            >
              Turn on
            </Button>
          )}
        </div>
        {push ? <p className="text-xs text-muted-foreground">{push}</p> : null}
        <p className="text-xs text-muted-foreground">A reminder pops up in Veneer while it is open, and arrives as a notification on every device where you turned notifications on.</p>
      </section>
      {accounts.map((a) => (
        <section key={a.connectorId} className="space-y-1.5">
          <h3 className="flex items-center gap-2 font-medium">
            <span className="size-2.5 rounded-full" style={{ background: a.color }} />
            <span className="truncate">{a.account}</span>
            {a.readOnly ? <span className="text-xs font-normal text-muted-foreground">read-only</span> : null}
          </h3>
          {a.error ? <p className="text-xs text-destructive">{a.error}</p> : null}
          {a.calendars.map((c) => (
            <div key={c.key} className="flex items-center gap-2 pl-4">
              <Switch checked={c.shown} onCheckedChange={() => void onChange({ visibility: { [c.key]: !c.shown } })} aria-label={`Show ${c.name}`} />
              <span className="min-w-0 flex-1 truncate">{c.name}</span>
              <select
                className="h-7 max-w-28 rounded-md border bg-background px-1 text-xs"
                aria-label={`Reminder for ${c.name}`}
                value={leadValue(c.leadMinutes)}
                onChange={(e) => {
                  const v = e.target.value;
                  void onChange({ calendarLeads: { [c.key]: v === 'default' ? 'default' : parseLead(v) } });
                }}
              >
                <option value="default">Default</option>
                {LEAD_CHOICES.map((choice) => (
                  <option key={String(choice.value)} value={String(choice.value)}>
                    {choice.label}
                  </option>
                ))}
              </select>
            </div>
          ))}
        </section>
      ))}
      <div className="flex items-center justify-between border-t pt-3 text-xs text-muted-foreground">
        <a className="text-primary underline" href="#/settings/connections?tab=apps">
          Connect another calendar
        </a>
        <button type="button" onClick={onRefresh} className="flex items-center gap-1">
          <RefreshCw className="size-3" /> Refresh
        </button>
      </div>
    </div>
  );
}
