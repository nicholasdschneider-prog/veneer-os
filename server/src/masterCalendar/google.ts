import { Composio } from '@composio/core';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { effectiveApiKey } from '../secrets/apiKeys.js';

/** The only calendar tools the master calendar may run. */
export type CalendarTool =
  | 'GOOGLECALENDAR_LIST_CALENDARS'
  | 'GOOGLECALENDAR_EVENTS_LIST'
  | 'GOOGLECALENDAR_EVENTS_GET'
  | 'GOOGLECALENDAR_CREATE_EVENT'
  | 'GOOGLECALENDAR_PATCH_EVENT'
  | 'GOOGLECALENDAR_DELETE_EVENT';

export interface CalendarConnector {
  id: number;
  /** The account the person signed in with, as they labeled the install. */
  account: string;
  readOnly: boolean;
  sessionId: string;
}

/** A tool call failed. `uncertain` means Google may have applied a write anyway. */
export class CalendarToolError extends Error {
  constructor(message: string, readonly uncertain = false, readonly notFound = false) {
    super(message);
  }
}

export type CalendarExecute = (connector: CalendarConnector, tool: CalendarTool, args: Record<string, unknown>) => Promise<Record<string, unknown>>;

const configSchema = z.object({ sessionId: z.string().min(1) }).passthrough();

/** The person's own connected Google Calendar installs. Shared installs belong to someone else. */
export function calendarConnectors(db: Database.Database, userId: number): CalendarConnector[] {
  const rows = db
    .prepare(
      `SELECT id, label, access_mode, config_json FROM user_connectors
        WHERE user_id = ? AND connector_slug = 'googlecalendar' AND status = 'connected'
        ORDER BY id`,
    )
    .all(userId) as { id: number; label: string | null; access_mode: string | null; config_json: string }[];
  return rows.flatMap((row) => {
    let sessionId: string;
    try {
      sessionId = configSchema.parse(JSON.parse(row.config_json)).sessionId;
    } catch {
      return [];
    }
    return [{ id: row.id, account: (row.label ?? 'Google Calendar').toLowerCase(), readOnly: row.access_mode === 'read_only', sessionId }];
  });
}

const WRITES = new Set<CalendarTool>(['GOOGLECALENDAR_CREATE_EVENT', 'GOOGLECALENDAR_PATCH_EVENT', 'GOOGLECALENDAR_DELETE_EVENT']);

/** Runs through each install's own Composio session; Google tokens never leave Composio. */
export function composioCalendarExecute(ctx: Pick<AppContext, 'secrets' | 'config' | 'doppler'>): CalendarExecute {
  // One client per key: each new client prints an SDK banner, and this runs every 30 s.
  let client: { apiKey: string; composio: Composio } | null = null;
  return async (connector, tool, args) => {
    if (WRITES.has(tool) && connector.readOnly) throw new CalendarToolError('This calendar is connected read-only. Reconnect it with Full access to make changes.');
    const apiKey = effectiveApiKey('composio', ctx.secrets, ctx.config, ctx.doppler).value;
    if (!apiKey) throw new CalendarToolError('The connector service is not configured.');
    let result: { data?: unknown; error?: unknown };
    try {
      if (client?.apiKey !== apiKey) client = { apiKey, composio: new Composio({ apiKey, allowTracking: false }) };
      const session = await client.composio.sessions.use(connector.sessionId);
      let timer: NodeJS.Timeout | undefined;
      result = await Promise.race([
        session.execute(tool, args),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('timeout')), 20_000);
        }),
      ]).finally(() => clearTimeout(timer));
    } catch {
      // A timeout or dropped connection after sending can still have changed the calendar.
      throw new CalendarToolError('Google did not answer in time.', WRITES.has(tool));
    }
    if (result.error) {
      const text = typeof result.error === 'string' ? result.error : JSON.stringify(result.error);
      throw new CalendarToolError(friendlyError(text), false, /\b(404|410|not ?found|deleted)\b/i.test(text));
    }
    const data = result.data;
    return data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
  };
}

function friendlyError(text: string): string {
  if (/\b403\b|forbidden|insufficient|permission/i.test(text)) return 'Google refused: you do not have permission to change this calendar or event.';
  if (/\b(404|410)\b|not ?found/i.test(text)) return 'Google could not find that event. It may have been moved or deleted.';
  if (/rate ?limit|\b429\b/i.test(text)) return 'Google is rate limiting this account. Wait a minute and try again.';
  if (/timeRangeEmpty|end.*before|after start/i.test(text)) return 'The end time must be after the start time.';
  return 'Google rejected the change.';
}

const when = z.object({ dateTime: z.string().optional(), date: z.string().optional(), timeZone: z.string().optional() }).passthrough();
const rawEvent = z
  .object({
    id: z.string().min(1),
    iCalUID: z.string().optional(),
    status: z.string().optional(),
    summary: z.string().optional(),
    description: z.string().optional(),
    location: z.string().optional(),
    htmlLink: z.string().optional(),
    hangoutLink: z.string().optional(),
    eventType: z.string().optional(),
    recurringEventId: z.string().optional(),
    guestsCanModify: z.boolean().optional(),
    originalStartTime: when.optional(),
    start: when,
    end: when,
    organizer: z.object({ email: z.string().optional(), displayName: z.string().optional(), self: z.boolean().optional() }).passthrough().optional(),
    attendees: z
      .array(
        z
          .object({
            email: z.string().optional(),
            displayName: z.string().optional(),
            responseStatus: z.string().optional(),
            self: z.boolean().optional(),
            organizer: z.boolean().optional(),
            resource: z.boolean().optional(),
          })
          .passthrough(),
      )
      .optional(),
    conferenceData: z
      .object({ entryPoints: z.array(z.object({ entryPointType: z.string().optional(), uri: z.string().optional() }).passthrough()).optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();

export type Response = 'accepted' | 'declined' | 'tentative' | 'needsAction';
const RESPONSES = new Set<string>(['accepted', 'declined', 'tentative', 'needsAction']);

export interface CalendarRef {
  connectorId: number;
  account: string;
  calendarId: string;
  calendarName: string;
  color: string;
  /** owner/writer on a Full install. */
  writable: boolean;
}

export interface CalendarEvent {
  key: string;
  connectorId: number;
  account: string;
  calendarId: string;
  calendarName: string;
  color: string;
  eventId: string;
  iCalUID: string;
  /** One occurrence across every calendar it appears on. */
  occurrenceKey: string;
  recurring: boolean;
  status: string;
  title: string;
  allDay: boolean;
  /** RFC 3339 instant for timed events, YYYY-MM-DD for all-day events (end exclusive). */
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
}

const SAFE_LINK = /^https:\/\/[^\s<>"']+$/;
const MEETING_LINK = /https:\/\/[^\s<>"']*(zoom\.us|meet\.google\.com|teams\.microsoft\.com|teams\.live\.com|webex\.com|whereby\.com|gotomeeting\.com)[^\s<>"']*/i;

function joinUrl(e: z.infer<typeof rawEvent>): string | null {
  const video = e.conferenceData?.entryPoints?.find((p) => p.entryPointType === 'video')?.uri;
  for (const candidate of [e.hangoutLink, video]) if (candidate && SAFE_LINK.test(candidate)) return candidate;
  for (const text of [e.location, e.description]) {
    const match = text?.match(MEETING_LINK)?.[0];
    if (match) return match.replace(/[).,;]+$/, '');
  }
  return null;
}

/** Midnight in the given zone, for all-day dates. */
export function zonedMidnight(date: string, timeZone: string): number {
  const utc = Date.parse(`${date}T00:00:00Z`);
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(utc));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'));
  return utc - (asUtc - utc);
}

export function normalizeEvent(raw: unknown, cal: CalendarRef, timeZone: string): CalendarEvent | null {
  const parsed = rawEvent.safeParse(raw);
  if (!parsed.success) return null;
  const e = parsed.data;
  const allDay = !e.start.dateTime;
  const start = e.start.dateTime ?? e.start.date;
  const end = e.end.dateTime ?? e.end.date ?? start;
  if (!start || !end) return null;
  const startMs = allDay ? zonedMidnight(start, timeZone) : Date.parse(start);
  const endMs = allDay ? zonedMidnight(end, timeZone) : Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
  const attendees = (e.attendees ?? [])
    .filter((a) => a.email && !a.resource)
    .map((a) => ({
      email: a.email!.toLowerCase(),
      name: a.displayName ?? null,
      response: (RESPONSES.has(a.responseStatus ?? '') ? a.responseStatus : 'needsAction') as Response,
      self: Boolean(a.self),
      organizer: Boolean(a.organizer),
    }));
  const self = attendees.find((a) => a.self);
  // No organizer means the event lives only on this calendar, which makes the calendar's owner its organizer.
  const organizerSelf = e.organizer ? Boolean(e.organizer.self) : true;
  const originalStart = e.originalStartTime?.dateTime ?? e.originalStartTime?.date ?? start;
  const iCalUID = e.iCalUID ?? e.id;
  return {
    key: `${cal.connectorId}|${cal.calendarId}|${e.id}`,
    connectorId: cal.connectorId,
    account: cal.account,
    calendarId: cal.calendarId,
    calendarName: cal.calendarName,
    color: cal.color,
    eventId: e.id,
    iCalUID,
    occurrenceKey: `${iCalUID}@${allDay ? originalStart : new Date(Date.parse(originalStart)).toISOString()}`,
    recurring: Boolean(e.recurringEventId),
    status: e.status ?? 'confirmed',
    title: e.summary?.trim() || '(No title)',
    allDay,
    start,
    end,
    startMs,
    endMs,
    location: e.location?.trim() || null,
    description: e.description?.trim() || null,
    joinUrl: joinUrl(e),
    htmlLink: e.htmlLink && SAFE_LINK.test(e.htmlLink) ? e.htmlLink : null,
    organizer: e.organizer?.displayName ?? e.organizer?.email?.toLowerCase() ?? null,
    organizerSelf,
    attendees,
    selfResponse: self?.response ?? null,
    canEdit: cal.writable && (organizerSelf || Boolean(e.guestsCanModify)),
    canRespond: cal.writable && Boolean(self) && !organizerSelf && (!e.eventType || e.eventType === 'default'),
    alsoOn: [],
  };
}

/** The editable copy wins: the organizer's, then any writable one, then the first seen. */
export function mergeDuplicates(events: CalendarEvent[]): CalendarEvent[] {
  const groups = new Map<string, CalendarEvent[]>();
  for (const e of events) {
    const group = groups.get(e.occurrenceKey);
    if (group) group.push(e);
    else groups.set(e.occurrenceKey, [e]);
  }
  const rank = (e: CalendarEvent) => (e.canEdit && e.organizerSelf ? 0 : e.canEdit ? 1 : e.canRespond ? 2 : 3);
  return [...groups.values()]
    .map((group) => {
      const best = [...group].sort((a, b) => rank(a) - rank(b))[0]!;
      const alsoOn = [...new Set(group.filter((e) => e !== best).map((e) => e.account))].filter((a) => a !== best.account);
      return { ...best, alsoOn };
    })
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs || a.title.localeCompare(b.title));
}
