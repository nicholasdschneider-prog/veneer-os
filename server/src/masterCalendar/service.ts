import type Database from 'better-sqlite3';
import { z } from 'zod';
import {
  calendarConnectors,
  CalendarToolError,
  mergeDuplicates,
  normalizeEvent,
  type CalendarConnector,
  type CalendarEvent,
  type CalendarExecute,
  type CalendarRef,
  type Response,
} from './google.js';

export const LEAD_CHOICES = [0, 5, 10, 15, 30, 60] as const;
export const DEFAULT_LEAD_MINUTES = 10;
export const SNOOZE_MINUTES = 5;
const CALENDAR_TTL_MS = 10 * 60_000;
const EVENTS_TTL_MS = 60_000;
const UPCOMING_TTL_MS = 2 * 60_000;
const MAX_RANGE_MS = 15 * 86_400_000;
/** A reminder that fired while every device was away still shows until the event ends, but push gives up after this. */
const PUSH_LATE_MS = 15 * 60_000;
const ACCOUNT_COLORS = ['#2563eb', '#16a34a', '#d97706', '#9333ea', '#dc2626', '#0891b2', '#db2777', '#65a30d'];

const lead = z.union([z.literal(0), z.literal(5), z.literal(10), z.literal(15), z.literal(30), z.literal(60)]).nullable();
export const SettingsPatch = z
  .object({
    panelOpen: z.boolean().optional(),
    viewDays: z.union([z.literal(1), z.literal(3)]).optional(),
    defaultLeadMinutes: lead.optional(),
    /** Calendar key -> shown. */
    visibility: z.record(z.string().max(600), z.boolean()).optional(),
    /** Calendar key -> minutes, null (no reminder) or 'default' to remove the override. */
    calendarLeads: z.record(z.string().max(600), lead.or(z.literal('default'))).optional(),
  })
  .strict();
export interface CalendarSettings {
  panelOpen: boolean;
  viewDays: 1 | 3;
  defaultLeadMinutes: number | null;
  visibility: Record<string, boolean>;
  calendarLeads: Record<string, number | null>;
}

const attendees = z.array(z.string().trim().toLowerCase().email().max(320)).max(100);
const instant = z.string().datetime({ offset: true });
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const timing = z.union([
  z.object({ allDay: z.literal(false), start: instant, end: instant }),
  z.object({ allDay: z.literal(true), start: day, end: day }),
]);
export const CreateInput = z
  .object({
    connectorId: z.number().int().positive(),
    calendarId: z.string().min(1).max(500),
    title: z.string().trim().min(1).max(1000),
    location: z.string().trim().max(2000).optional(),
    description: z.string().max(8000).optional(),
    attendees: attendees.optional(),
    timeZone: z.string().min(1).max(64),
    /** Email the guests. Only true when the person pressed the send button. */
    notifyGuests: z.boolean(),
    addMeet: z.boolean().optional(),
  })
  .and(timing);
export const UpdateInput = z
  .object({
    title: z.string().trim().min(1).max(1000).optional(),
    location: z.string().trim().max(2000).optional(),
    description: z.string().max(8000).optional(),
    attendees: attendees.optional(),
    timeZone: z.string().min(1).max(64),
    notifyGuests: z.boolean(),
  })
  .and(z.union([timing, z.object({ allDay: z.undefined().optional() })]));
export const RsvpInput = z.object({ response: z.enum(['accepted', 'declined', 'tentative']) }).strict();

export interface AccountView {
  connectorId: number;
  account: string;
  color: string;
  readOnly: boolean;
  error: string | null;
  calendars: { key: string; id: string; name: string; primary: boolean; writable: boolean; shown: boolean; leadMinutes: number | null | undefined }[];
}
export interface Upcoming extends CalendarEvent {
  leadMinutes: number | null;
  /** When the reminder shows, or null for none. */
  dueMs: number | null;
  reminderState: 'dismissed' | 'snoozed' | null;
}

export class CalendarInputError extends Error {}

const calendarKey = (connectorId: number, calendarId: string) => `${connectorId}:${calendarId}`;

interface CalendarInfo {
  id: string;
  name: string;
  primary: boolean;
  accessRole: string;
  selected: boolean;
  timeZone: string | null;
}

export function createMasterCalendar(db: Database.Database, execute: CalendarExecute, clock = Date.now) {
  const calendarCache = new Map<number, { at: number; calendars: CalendarInfo[] }>();
  const eventCache = new Map<string, { at: number; items: unknown[] }>();
  const upcomingCache = new Map<number, { at: number; events: CalendarEvent[]; errors: string[] }>();
  const serverZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  function settings(userId: number): CalendarSettings {
    const row = db.prepare('SELECT * FROM master_calendar_settings WHERE user_id=?').get(userId) as
      | { panel_open: number; view_days: number; default_lead_minutes: number | null; visibility_json: string; calendar_leads_json: string }
      | undefined;
    if (!row) return { panelOpen: false, viewDays: 1, defaultLeadMinutes: DEFAULT_LEAD_MINUTES, visibility: {}, calendarLeads: {} };
    return {
      panelOpen: row.panel_open === 1,
      viewDays: row.view_days === 3 ? 3 : 1,
      defaultLeadMinutes: row.default_lead_minutes,
      visibility: JSON.parse(row.visibility_json) as Record<string, boolean>,
      calendarLeads: JSON.parse(row.calendar_leads_json) as Record<string, number | null>,
    };
  }

  function updateSettings(userId: number, input: unknown): CalendarSettings {
    const patch = SettingsPatch.parse(input);
    const current = settings(userId);
    const next: CalendarSettings = {
      panelOpen: patch.panelOpen ?? current.panelOpen,
      viewDays: patch.viewDays ?? current.viewDays,
      defaultLeadMinutes: patch.defaultLeadMinutes !== undefined ? patch.defaultLeadMinutes : current.defaultLeadMinutes,
      visibility: { ...current.visibility, ...patch.visibility },
      calendarLeads: { ...current.calendarLeads },
    };
    for (const [key, value] of Object.entries(patch.calendarLeads ?? {})) {
      if (value === 'default') delete next.calendarLeads[key];
      else next.calendarLeads[key] = value;
    }
    db.prepare(
      `INSERT INTO master_calendar_settings(user_id,panel_open,view_days,default_lead_minutes,visibility_json,calendar_leads_json,updated_ms)
       VALUES(?,?,?,?,?,?,?)
       ON CONFLICT(user_id) DO UPDATE SET panel_open=excluded.panel_open, view_days=excluded.view_days,
         default_lead_minutes=excluded.default_lead_minutes, visibility_json=excluded.visibility_json,
         calendar_leads_json=excluded.calendar_leads_json, updated_ms=excluded.updated_ms`,
    ).run(userId, next.panelOpen ? 1 : 0, next.viewDays, next.defaultLeadMinutes, JSON.stringify(next.visibility), JSON.stringify(next.calendarLeads), clock());
    return next;
  }

  async function calendarsFor(connector: CalendarConnector): Promise<CalendarInfo[]> {
    const hit = calendarCache.get(connector.id);
    if (hit && clock() - hit.at < CALENDAR_TTL_MS) return hit.calendars;
    const calendars: CalendarInfo[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < 5; page++) {
      const data = await execute(connector, 'GOOGLECALENDAR_LIST_CALENDARS', { max_results: 250, ...(pageToken ? { page_token: pageToken } : {}) });
      const items = (Array.isArray(data.calendars) ? data.calendars : Array.isArray(data.items) ? data.items : []) as Record<string, unknown>[];
      for (const c of items) {
        if (typeof c.id !== 'string' || c.accessRole === 'freeBusyReader' || c.accessRole === 'none' || c.deleted === true) continue;
        calendars.push({
          id: c.id,
          name: String(c.summaryOverride ?? c.summary ?? c.id).slice(0, 200),
          primary: c.primary === true,
          accessRole: String(c.accessRole ?? 'reader'),
          selected: c.selected !== false,
          timeZone: typeof c.timeZone === 'string' ? c.timeZone : null,
        });
      }
      pageToken = typeof data.next_page_token === 'string' && data.next_page_token ? data.next_page_token : typeof data.nextPageToken === 'string' && data.nextPageToken ? data.nextPageToken : undefined;
      if (!pageToken) break;
    }
    calendars.sort((a, b) => Number(b.primary) - Number(a.primary) || a.name.localeCompare(b.name));
    calendarCache.set(connector.id, { at: clock(), calendars });
    return calendars;
  }

  async function accounts(userId: number): Promise<AccountView[]> {
    const s = settings(userId);
    return Promise.all(
      calendarConnectors(db, userId).map(async (connector, index): Promise<AccountView> => {
        const base = { connectorId: connector.id, account: connector.account, color: ACCOUNT_COLORS[index % ACCOUNT_COLORS.length]!, readOnly: connector.readOnly };
        try {
          const calendars = await calendarsFor(connector);
          return {
            ...base,
            error: null,
            calendars: calendars.map((c) => {
              const key = calendarKey(connector.id, c.id);
              return {
                key,
                id: c.id,
                name: c.name,
                primary: c.primary,
                writable: !connector.readOnly && (c.accessRole === 'owner' || c.accessRole === 'writer'),
                shown: s.visibility[key] ?? c.selected,
                leadMinutes: key in s.calendarLeads ? s.calendarLeads[key] : undefined,
              };
            }),
          };
        } catch (e) {
          return { ...base, error: e instanceof CalendarToolError ? e.message : 'Calendar unavailable.', calendars: [] };
        }
      }),
    );
  }

  async function eventsFor(connector: CalendarConnector, calendarId: string, fromMs: number, toMs: number, fresh: boolean): Promise<unknown[]> {
    const key = `${connector.id}|${calendarId}|${fromMs}|${toMs}`;
    const hit = eventCache.get(key);
    if (!fresh && hit && clock() - hit.at < EVENTS_TTL_MS) return hit.items;
    const items: unknown[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < 4; page++) {
      const data = await execute(connector, 'GOOGLECALENDAR_EVENTS_LIST', {
        calendarId,
        timeMin: new Date(fromMs).toISOString(),
        timeMax: new Date(toMs).toISOString(),
        singleEvents: true,
        orderBy: 'startTime',
        maxResults: 250,
        ...(pageToken ? { pageToken } : {}),
      });
      if (Array.isArray(data.items)) items.push(...data.items);
      pageToken = typeof data.nextPageToken === 'string' && data.nextPageToken ? data.nextPageToken : undefined;
      if (!pageToken) break;
    }
    for (const [k, v] of eventCache) if (clock() - v.at > 10 * 60_000) eventCache.delete(k);
    eventCache.set(key, { at: clock(), items });
    return items;
  }

  async function collect(userId: number, fromMs: number, toMs: number, fresh = false) {
    if (!(toMs > fromMs) || toMs - fromMs > MAX_RANGE_MS) throw new CalendarInputError('Choose a range of up to 15 days.');
    const views = await accounts(userId);
    const connectors = new Map(calendarConnectors(db, userId).map((c) => [c.id, c]));
    const errors = views.filter((v) => v.error).map((v) => `${v.account}: ${v.error}`);
    const events: CalendarEvent[] = [];
    await Promise.all(
      views.flatMap((view) =>
        view.calendars
          .filter((c) => c.shown)
          .map(async (c) => {
            const connector = connectors.get(view.connectorId);
            if (!connector) return;
            const ref: CalendarRef = { connectorId: view.connectorId, account: view.account, calendarId: c.id, calendarName: c.name, color: view.color, writable: c.writable };
            try {
              for (const raw of await eventsFor(connector, c.id, fromMs, toMs, fresh)) {
                const e = normalizeEvent(raw, ref, serverZone);
                if (e && e.status !== 'cancelled' && e.endMs > fromMs && e.startMs < toMs) events.push(e);
              }
            } catch (err) {
              errors.push(`${view.account} · ${c.name}: ${err instanceof CalendarToolError && !err.notFound ? err.message : 'Google could not read this calendar.'}`);
            }
          }),
      ),
    );
    const own = db.prepare('SELECT lead_minutes FROM master_calendar_event_leads WHERE user_id=? AND event_key=?');
    const merged = mergeDuplicates(events).map((e) => {
      const row = own.get(userId, e.occurrenceKey) as { lead_minutes: number | null } | undefined;
      return row ? { ...e, leadOverride: row.lead_minutes } : e;
    });
    return { events: merged as (CalendarEvent & { leadOverride?: number | null })[], errors };
  }

  function leadFor(userId: number, s: CalendarSettings, e: CalendarEvent): number | null {
    const own = db.prepare('SELECT lead_minutes FROM master_calendar_event_leads WHERE user_id=? AND event_key=?').get(userId, e.occurrenceKey) as
      | { lead_minutes: number | null }
      | undefined;
    if (own) return own.lead_minutes;
    const key = calendarKey(e.connectorId, e.calendarId);
    if (key in s.calendarLeads) return s.calendarLeads[key] ?? null;
    return s.defaultLeadMinutes;
  }

  function withReminders(userId: number, events: CalendarEvent[]): Upcoming[] {
    const s = settings(userId);
    const state = db.prepare('SELECT state,snooze_until_ms FROM master_calendar_reminder_state WHERE user_id=? AND occurrence_key=?');
    return events.map((e) => {
      const leadMinutes = e.allDay || e.selfResponse === 'declined' ? null : leadFor(userId, s, e);
      const st = state.get(userId, e.occurrenceKey) as { state: 'dismissed' | 'snoozed'; snooze_until_ms: number | null } | undefined;
      const dueMs = leadMinutes === null || st?.state === 'dismissed' ? null : st?.state === 'snoozed' && st.snooze_until_ms ? st.snooze_until_ms : e.startMs - leadMinutes * 60_000;
      return { ...e, leadMinutes, dueMs, reminderState: st?.state ?? null };
    });
  }

  /** The next day of events with their reminders; shared by every open tab and the push worker. */
  async function upcoming(userId: number, fresh = false): Promise<{ events: Upcoming[]; errors: string[] }> {
    let hit = upcomingCache.get(userId);
    if (fresh || !hit || clock() - hit.at >= UPCOMING_TTL_MS) {
      const now = clock();
      const { events, errors } = await collect(userId, now - 60 * 60_000, now + 26 * 3_600_000, fresh);
      hit = { at: clock(), events, errors };
      upcomingCache.set(userId, hit);
    }
    const now = clock();
    return { events: withReminders(userId, hit.events.filter((e) => e.endMs > now)), errors: hit.errors };
  }

  function forget(userId: number, connectorId?: number) {
    upcomingCache.delete(userId);
    for (const k of eventCache.keys()) if (connectorId === undefined || k.startsWith(`${connectorId}|`)) eventCache.delete(k);
  }

  function connectorFor(userId: number, connectorId: number) {
    const connector = calendarConnectors(db, userId).find((c) => c.id === connectorId);
    if (!connector) throw new CalendarInputError('That calendar account is not connected.');
    return connector;
  }

  async function refFor(userId: number, connectorId: number, calendarId: string): Promise<{ connector: CalendarConnector; ref: CalendarRef }> {
    const connector = connectorFor(userId, connectorId);
    const view = (await accounts(userId)).find((a) => a.connectorId === connectorId);
    const cal = view?.calendars.find((c) => c.id === calendarId);
    if (!view || !cal) throw new CalendarInputError('That calendar is not available.');
    return { connector, ref: { connectorId, account: view.account, calendarId, calendarName: cal.name, color: view.color, writable: cal.writable } };
  }

  async function writableRef(userId: number, connectorId: number, calendarId: string) {
    const found = await refFor(userId, connectorId, calendarId);
    if (!found.ref.writable) throw new CalendarInputError('That calendar is read-only here. Reconnect it with Full access to make changes.');
    return found;
  }

  async function readBack(connector: CalendarConnector, ref: CalendarRef, eventId: string) {
    const data = await execute(connector, 'GOOGLECALENDAR_EVENTS_GET', { calendar_id: ref.calendarId, event_id: eventId });
    const raw = data.response_data ?? data.event ?? data;
    const event = normalizeEvent(raw, ref, serverZone);
    if (!event) throw new CalendarToolError('Google saved the change but the event could not be read back.', true);
    return event;
  }

  function timingArgs(input: { allDay?: boolean; start?: string; end?: string }, create: boolean) {
    if (input.allDay === undefined || !input.start || !input.end) return {};
    if (input.allDay) {
      if (input.end <= input.start) throw new CalendarInputError('The end date must be after the start date.');
      return create ? { start_date: input.start, end_date: input.end } : { start_time: input.start, end_time: input.end };
    }
    if (Date.parse(input.end) <= Date.parse(input.start)) throw new CalendarInputError('The end time must be after the start time.');
    return create ? { start_datetime: input.start, end_datetime: input.end } : { start_time: input.start, end_time: input.end };
  }

  async function create(userId: number, input: unknown) {
    const body = CreateInput.parse(input);
    const { connector, ref } = await refFor(userId, body.connectorId, body.calendarId);
    if (!ref.writable) throw new CalendarInputError('You cannot add events to that calendar.');
    try {
      const data = await execute(connector, 'GOOGLECALENDAR_CREATE_EVENT', {
        calendar_id: body.calendarId,
        summary: body.title,
        ...(body.location ? { location: body.location } : {}),
        ...(body.description ? { description: body.description } : {}),
        ...(body.attendees?.length ? { attendees: body.attendees } : {}),
        ...timingArgs(body, true),
        timezone: body.timeZone,
        send_updates: body.notifyGuests ? 'all' : 'none',
        create_meeting_room: Boolean(body.addMeet),
      });
      const created = (data.response_data ?? data) as { id?: unknown };
      if (typeof created.id !== 'string') throw new CalendarToolError('Google did not return the new event.', true);
      return await readBack(connector, ref, created.id);
    } finally {
      forget(userId, connector.id);
    }
  }

  async function update(userId: number, connectorId: number, calendarId: string, eventId: string, input: unknown) {
    const body = UpdateInput.parse(input);
    const { connector, ref } = await writableRef(userId, connectorId, calendarId);
    try {
      await execute(connector, 'GOOGLECALENDAR_PATCH_EVENT', {
        calendar_id: calendarId,
        event_id: eventId,
        ...(body.title !== undefined ? { summary: body.title } : {}),
        ...(body.location !== undefined ? { location: body.location } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.attendees !== undefined ? { attendees: body.attendees } : {}),
        ...timingArgs(body as { allDay?: boolean; start?: string; end?: string }, false),
        timezone: body.timeZone,
        send_updates: body.notifyGuests ? 'all' : 'none',
      });
      return await readBack(connector, ref, eventId);
    } finally {
      forget(userId, connector.id);
    }
  }

  async function respond(userId: number, connectorId: number, calendarId: string, eventId: string, input: unknown) {
    const { response } = RsvpInput.parse(input);
    const { connector, ref } = await writableRef(userId, connectorId, calendarId);
    try {
      await execute(connector, 'GOOGLECALENDAR_PATCH_EVENT', { calendar_id: calendarId, event_id: eventId, rsvp_response: response });
      const event = await readBack(connector, ref, eventId);
      if (event.selfResponse !== (response as Response)) throw new CalendarToolError('Google did not record your response. Check the event before trying again.', true);
      return event;
    } finally {
      forget(userId, connector.id);
    }
  }

  async function remove(userId: number, connectorId: number, calendarId: string, eventId: string, notifyGuests: boolean) {
    const { connector, ref } = await writableRef(userId, connectorId, calendarId);
    try {
      await execute(connector, 'GOOGLECALENDAR_DELETE_EVENT', { calendar_id: calendarId, event_id: eventId, send_updates: notifyGuests ? 'all' : 'none' });
      try {
        const after = await readBack(connector, ref, eventId);
        if (after.status !== 'cancelled') throw new CalendarToolError('Google still shows the event. Check the calendar before trying again.', true);
      } catch (e) {
        if (!(e instanceof CalendarToolError && e.notFound)) throw e;
      }
      return { deleted: true };
    } finally {
      forget(userId, connector.id);
    }
  }

  function setEventLead(userId: number, input: unknown) {
    const body = z.object({ occurrenceKey: z.string().min(1).max(1200), leadMinutes: lead.or(z.literal('default')) }).strict().parse(input);
    if (body.leadMinutes === 'default') db.prepare('DELETE FROM master_calendar_event_leads WHERE user_id=? AND event_key=?').run(userId, body.occurrenceKey);
    else
      db.prepare(
        'INSERT INTO master_calendar_event_leads(user_id,event_key,lead_minutes,updated_ms) VALUES(?,?,?,?) ON CONFLICT(user_id,event_key) DO UPDATE SET lead_minutes=excluded.lead_minutes, updated_ms=excluded.updated_ms',
      ).run(userId, body.occurrenceKey, body.leadMinutes, clock());
    // A new lead time is a new reminder; an earlier dismiss or snooze no longer applies.
    db.prepare('DELETE FROM master_calendar_reminder_state WHERE user_id=? AND occurrence_key=?').run(userId, body.occurrenceKey);
  }

  function setReminderState(userId: number, input: unknown) {
    const body = z.object({ occurrenceKey: z.string().min(1).max(1200), action: z.enum(['dismiss', 'snooze']) }).strict().parse(input);
    const snoozeUntil = body.action === 'snooze' ? clock() + SNOOZE_MINUTES * 60_000 : null;
    db.prepare(
      `INSERT INTO master_calendar_reminder_state(user_id,occurrence_key,state,snooze_until_ms,updated_ms) VALUES(?,?,?,?,?)
       ON CONFLICT(user_id,occurrence_key) DO UPDATE SET state=excluded.state, snooze_until_ms=excluded.snooze_until_ms, updated_ms=excluded.updated_ms`,
    ).run(userId, body.occurrenceKey, body.action === 'dismiss' ? 'dismissed' : 'snoozed', snoozeUntil, clock());
    return { state: body.action === 'dismiss' ? 'dismissed' : 'snoozed', snoozeUntilMs: snoozeUntil };
  }

  /** Reminders due right now, for the push worker. */
  async function dueReminders(userId: number) {
    const now = clock();
    const { events } = await upcoming(userId);
    return events.filter((e) => e.dueMs !== null && e.dueMs <= now && now - e.dueMs < PUSH_LATE_MS && e.startMs + 5 * 60_000 > now);
  }

  return { settings, updateSettings, accounts, events: collect, upcoming, create, update, respond, remove, setEventLead, setReminderState, dueReminders, forget };
}
export type MasterCalendar = ReturnType<typeof createMasterCalendar>;
