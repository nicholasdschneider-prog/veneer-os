import { z } from 'zod';
import { NICK_ZONE, type Binding, type CalendarSource, type Meeting } from './service.js';

const instant = z.string().datetime({ offset: true });
const eventSchema = z.object({
  id: z.string().min(1).max(512), iCalUID: z.string().min(1).max(1024),
  status: z.enum(['confirmed', 'cancelled', 'tentative']), summary: z.string().max(4096).optional(),
  eventType: z.string().optional(), recurringEventId: z.string().optional(),
  originalStartTime: z.object({ dateTime: instant.optional(), date: z.string().optional() }).optional(),
  start: z.object({ dateTime: instant.optional(), date: z.string().optional() }),
  end: z.object({ dateTime: instant.optional(), date: z.string().optional() }),
  attendeesOmitted: z.boolean().optional(),
  attendees: z.array(z.object({ self: z.boolean().optional(), responseStatus: z.string().optional() })).optional(),
});
const pageSchema = z.object({ items: z.array(z.unknown()), nextPageToken: z.string().min(1).max(2048).optional() });
function parseMeeting(raw: unknown, b: Binding, calendarId: string): Meeting | null {
  const e = eventSchema.parse(raw);
  if (!e.start.dateTime || !e.end.dateTime) return null; // All-day dates are never converted to midnight calls.
  if (e.recurringEventId && !e.originalStartTime?.dateTime) throw new Error('Recurring occurrence identity missing.');
  return { account: b.account, sourceId: b.sourceId, calendarId, id: e.id, iCalUID: e.iCalUID,
    startMs: Date.parse(e.start.dateTime), endMs: Date.parse(e.end.dateTime),
    originalStartMs: e.originalStartTime?.dateTime ? Date.parse(e.originalStartTime.dateTime) : null,
    recurring: !!e.recurringEventId, status: e.status, title: e.summary ?? 'Meeting',
    eligible: (!e.eventType || e.eventType === 'default') && !e.attendeesOmitted && !e.attendees?.some(a => a.self && a.responseStatus === 'declined') };
}

/** Dedicated read-only Google adapter. No connector token export or borrowed bot identity.
 * The accepted source custodian must bind this token reader to each immutable sourceId.
 * Tokens exist only at use time in the Authorization header; no caching or logging here.
 * This factory is NOT instantiated in the running app.
 */
export function googleReminderReader(tokenAtUse: (binding: Binding) => Promise<string>, fetcher: typeof fetch = fetch, clock = Date.now): CalendarSource {
  const read = async (b: Binding, pathname: string, params?: URLSearchParams) => {
    const url = new URL(pathname, 'https://www.googleapis.com');
    if (params) url.search = params.toString();
    const response = await fetcher(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(10_000),
      headers: { authorization: `Bearer ${await tokenAtUse(b)}` } });
    if (response.status === 404 || response.status === 410) return null;
    if (!response.ok) throw new Error('Calendar read unavailable.');
    return response.json() as Promise<unknown>;
  };
  return calendarReminderReader(read,clock);
}
export type CalendarRead = (b: Binding, pathname: string, params?: URLSearchParams) => Promise<unknown>;
/** Shared event/inventory validation for direct synthetic and existing connector transports. */
export function calendarReminderReader(read: CalendarRead, clock = Date.now): CalendarSource {
  const identity = async (b: Binding) => {
    const i = z.object({ email: z.string().email(), verified_email: z.boolean().optional() }).parse(await read(b, '/oauth2/v2/userinfo'));
    if (i.verified_email === false) throw new Error('Calendar identity is unverified.');
    if (i.email.toLowerCase() !== b.account) throw new Error('Calendar account identity mismatch.');
    return { email: i.email.toLowerCase(), observedMs: clock() };
  };
  return {
    // Differing Google UIDs need a separately accepted authenticated alias producer.
    // Owner-supplied prose or a matching title/time never establishes an alias.
    async verifyAlias() { return { verified: false, observedMs: clock() }; },
    identity,
    async list(b, from, to) {
      await identity(b);
      const meetings: Meeting[] = []; const started = clock();
      let inventoryToken: string | undefined; const inventory = new Set<string>(); const inventoryPages = new Set<string>();
      for (let n = 0; ; n++) {
        if (n >= 10) throw new Error('Calendar inventory bound exceeded.');
        const params = new URLSearchParams({ showHidden: 'true', maxResults: '250' });
        if (inventoryToken) params.set('pageToken', inventoryToken);
        const page = z.object({ items: z.array(z.object({ id: z.string().min(1), accessRole: z.enum(['owner','writer','reader','freeBusyReader','none']) })), nextPageToken: z.string().min(1).max(2048).optional() }).parse(await read(b, '/calendar/v3/users/me/calendarList', params));
        for (const c of page.items) {
          if (c.accessRole === 'freeBusyReader' || c.accessRole === 'none') throw new Error('Meeting details unavailable on an account calendar.');
          inventory.add(c.id);
        }
        inventoryToken = page.nextPageToken;
        if (!inventoryToken) break;
        if (inventoryPages.has(inventoryToken)) throw new Error('Calendar inventory pagination repeated.');
        inventoryPages.add(inventoryToken);
      }
      if (inventory.size !== b.calendarIds.length || b.calendarIds.some(id => !inventory.has(id))) throw new Error('Pinned calendar inventory changed.');
      for (const calendar of b.calendarIds) {
        let token: string | undefined; const seen = new Set<string>(); let pages = 0;
        do {
          if (++pages > 10 || clock() - started > 60_000) throw new Error('Calendar read bound exceeded.');
          const params = new URLSearchParams({ timeMin: new Date(from).toISOString(), timeMax: new Date(to).toISOString(),
            singleEvents: 'true', showDeleted: 'true', timeZone: NICK_ZONE, maxResults: '250' });
          if (token) params.set('pageToken', token);
          const page = pageSchema.parse(await read(b, `/calendar/v3/calendars/${encodeURIComponent(calendar)}/events`, params));
          for (const raw of page.items) { const m = parseMeeting(raw, b, calendar); if (m) meetings.push(m); }
          if (meetings.length > 2000) throw new Error('Calendar inventory bound exceeded.');
          token = page.nextPageToken;
          if (token && seen.has(token)) throw new Error('Calendar pagination repeated.');
          if (token) seen.add(token);
        } while (token);
      }
      await identity(b);
      return { meetings, complete: true, observedMs: started };
    },
    async get(b, m) {
      await identity(b);
      if (m.sourceId !== b.sourceId || m.account !== b.account || !b.calendarIds.includes(m.calendarId)) throw new Error('Calendar scope mismatch.');
      const started = clock();
      const raw = await read(b, `/calendar/v3/calendars/${encodeURIComponent(m.calendarId)}/events/${encodeURIComponent(m.id)}`);
      return { meeting: raw === null ? null : parseMeeting(raw, b, m.calendarId), observedMs: started };
    },
  };
}
