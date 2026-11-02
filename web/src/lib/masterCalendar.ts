import { useSyncExternalStore } from 'react';
import { requestJson } from './api';
import { DESKTOP_QUERY } from '../hooks/useMediaQuery';

/** The phone sheet covers the screen, so only the desktop panel's open state is remembered across devices. */
const isDesktop = () => typeof window !== 'undefined' && window.matchMedia?.(DESKTOP_QUERY).matches === true;

export type Response = 'accepted' | 'declined' | 'tentative' | 'needsAction';
export interface CalEvent {
  key: string;
  connectorId: number;
  account: string;
  calendarId: string;
  calendarName: string;
  color: string;
  eventId: string;
  iCalUID: string;
  occurrenceKey: string;
  recurring: boolean;
  status: string;
  title: string;
  allDay: boolean;
  start: string;
  end: string;
  startMs: number;
  endMs: number;
  location: string | null;
  description: string | null;
  joinUrl: string | null;
  htmlLink: string | null;
  organizer: string | null;
  organizerSelf: boolean;
  attendees: { email: string; name: string | null; response: Response; self: boolean; organizer: boolean }[];
  selfResponse: Response | null;
  canEdit: boolean;
  canRespond: boolean;
  alsoOn: string[];
  /** Present only when this event has its own reminder setting. */
  leadOverride?: number | null;
}
export interface UpcomingEvent extends CalEvent {
  leadMinutes: number | null;
  dueMs: number | null;
  reminderState: 'dismissed' | 'snoozed' | null;
}
export interface CalendarSettings {
  panelOpen: boolean;
  viewDays: 1 | 3;
  defaultLeadMinutes: number | null;
  visibility: Record<string, boolean>;
  calendarLeads: Record<string, number | null>;
}
export interface CalendarAccount {
  connectorId: number;
  account: string;
  color: string;
  readOnly: boolean;
  error: string | null;
  calendars: { key: string; id: string; name: string; primary: boolean; writable: boolean; shown: boolean; leadMinutes: number | null | undefined }[];
}
export const LEAD_CHOICES: { value: number | null; label: string }[] = [
  { value: null, label: 'No reminder' },
  { value: 0, label: 'At start' },
  { value: 5, label: '5 min before' },
  { value: 10, label: '10 min before' },
  { value: 15, label: '15 min before' },
  { value: 30, label: '30 min before' },
  { value: 60, label: '1 hour before' },
];

const base = '/api/master-calendar';
const json = (method: string, body?: unknown): RequestInit => ({ method, body: body === undefined ? undefined : JSON.stringify(body) });
const eventPath = (e: Pick<CalEvent, 'connectorId' | 'calendarId' | 'eventId'>) =>
  `${base}/events/${e.connectorId}/${encodeURIComponent(e.calendarId)}/${encodeURIComponent(e.eventId)}`;

export interface EventInput {
  title: string;
  allDay: boolean;
  start: string;
  end: string;
  location?: string;
  description?: string;
  attendees?: string[];
  timeZone: string;
  notifyGuests: boolean;
}

export const calendarApi = {
  settings: () => requestJson<CalendarSettings>(`${base}/settings`),
  updateSettings: (patch: Partial<Omit<CalendarSettings, 'calendarLeads'>> & { calendarLeads?: Record<string, number | null | 'default'> }) => requestJson<CalendarSettings>(`${base}/settings`, json('PUT', patch)),
  accounts: () => requestJson<{ accounts: CalendarAccount[] }>(`${base}/accounts`),
  events: (fromMs: number, toMs: number, fresh = false) =>
    requestJson<{ events: CalEvent[]; errors: string[] }>(
      `${base}/events?from=${encodeURIComponent(new Date(fromMs).toISOString())}&to=${encodeURIComponent(new Date(toMs).toISOString())}${fresh ? '&fresh=1' : ''}`,
    ),
  upcoming: (fresh = false) => requestJson<{ events: UpcomingEvent[]; errors: string[] }>(`${base}/upcoming${fresh ? '?fresh=1' : ''}`),
  create: (input: EventInput & { connectorId: number; calendarId: string; addMeet?: boolean }) => requestJson<{ event: CalEvent }>(`${base}/events`, json('POST', input)),
  update: (e: CalEvent, input: Partial<EventInput> & { timeZone: string; notifyGuests: boolean }) => requestJson<{ event: CalEvent }>(eventPath(e), json('PATCH', input)),
  respond: (e: CalEvent, response: Exclude<Response, 'needsAction'>) => requestJson<{ event: CalEvent }>(`${eventPath(e)}/rsvp`, json('POST', { response })),
  remove: (e: CalEvent, notifyGuests: boolean) => requestJson<{ deleted: true }>(`${eventPath(e)}${notifyGuests ? '?notify=1' : ''}`, json('DELETE')),
  setEventLead: (occurrenceKey: string, leadMinutes: number | null | 'default') => requestJson(`${base}/event-lead`, json('PUT', { occurrenceKey, leadMinutes })),
  reminder: (occurrenceKey: string, action: 'dismiss' | 'snooze') => requestJson(`${base}/reminders`, json('POST', { occurrenceKey, action })),
};

export const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Panel state lives outside React so it survives every route change and shell remount. */
const STORAGE_KEY = 'veneer:calendar-panel';
type PanelState = { open: boolean; dayMs: number; viewDays: 1 | 3; scrollTop: number | null; changed: number };
function startOfDay(ms: number) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
let state: PanelState = { open: false, dayMs: startOfDay(Date.now()), viewDays: 1, scrollTop: null, changed: 0 };
try {
  const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as { open?: boolean; viewDays?: 1 | 3 } | null;
  if (saved) state = { ...state, open: Boolean(saved.open) && isDesktop(), viewDays: saved.viewDays === 3 ? 3 : 1 };
} catch {
  // A private window without storage starts closed.
}
const listeners = new Set<() => void>();
function emit(next: Partial<PanelState>, persist = false) {
  state = { ...state, ...next, changed: state.changed + 1 };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ open: state.open, viewDays: state.viewDays }));
  } catch {
    // Ignore storage failures.
  }
  if (persist) void calendarApi.updateSettings(isDesktop() ? { panelOpen: state.open, viewDays: state.viewDays } : { viewDays: state.viewDays }).catch(() => undefined);
  for (const l of listeners) l();
}
export const calendarPanel = {
  get: () => state,
  subscribe: (l: () => void) => {
    listeners.add(l);
    return () => void listeners.delete(l);
  },
  setOpen: (open: boolean) => emit({ open }, true),
  toggle: () => emit({ open: !state.open }, true),
  setViewDays: (viewDays: 1 | 3) => emit({ viewDays }, true),
  shiftDays: (days: number) => emit({ dayMs: startOfDay(state.dayMs + days * 86_400_000 + 12 * 3_600_000) }),
  today: () => emit({ dayMs: startOfDay(Date.now()), scrollTop: null }),
  rememberScroll: (scrollTop: number) => {
    state = { ...state, scrollTop };
  },
  /** The server copy wins on first load, so the choice follows the person between devices. */
  adopt: (s: Pick<CalendarSettings, 'panelOpen' | 'viewDays'>) => emit(isDesktop() ? { open: s.panelOpen, viewDays: s.viewDays } : { viewDays: s.viewDays }),
  /** Tell open views their data changed (after an edit or reminder action). */
  refresh: () => emit({}),
};
export function useCalendarPanel() {
  return useSyncExternalStore(calendarPanel.subscribe, calendarPanel.get, calendarPanel.get);
}
export { startOfDay };

/** Side-by-side columns for overlapping timed events, Google style. */
export function layoutDay<T extends { startMs: number; endMs: number }>(events: T[]): (T & { column: number; columns: number })[] {
  const sorted = [...events].sort((a, b) => a.startMs - b.startMs || b.endMs - a.endMs);
  const out: (T & { column: number; columns: number })[] = [];
  let cluster: (T & { column: number; columns: number })[] = [];
  let clusterEnd = -Infinity;
  const flush = () => {
    const columns = Math.max(1, ...cluster.map((e) => e.column + 1));
    for (const e of cluster) e.columns = columns;
    out.push(...cluster);
    cluster = [];
  };
  for (const e of sorted) {
    const end = Math.max(e.endMs, e.startMs + 15 * 60_000);
    if (e.startMs >= clusterEnd) {
      flush();
      clusterEnd = -Infinity;
    }
    const used = new Set(cluster.filter((c) => Math.max(c.endMs, c.startMs + 15 * 60_000) > e.startMs).map((c) => c.column));
    let column = 0;
    while (used.has(column)) column++;
    cluster.push({ ...e, column, columns: 1 });
    clusterEnd = Math.max(clusterEnd, end);
  }
  flush();
  return out;
}

export function formatTime(ms: number) {
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
export function formatRange(e: Pick<CalEvent, 'allDay' | 'startMs' | 'endMs'>) {
  if (e.allDay) {
    const days = Math.round((e.endMs - e.startMs) / 86_400_000);
    const first = new Date(e.startMs).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
    return days > 1 ? `${first} – ${new Date(e.endMs - 1).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}` : `${first} · All day`;
  }
  const day = new Date(e.startMs).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  return `${day} · ${formatTime(e.startMs)} – ${formatTime(e.endMs)}`;
}
