import Database from 'better-sqlite3';
import express from 'express';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { CalendarToolError, normalizeEvent, zonedMidnight, type CalendarExecute, type CalendarTool } from '../src/masterCalendar/google.js';
import { createMasterCalendar } from '../src/masterCalendar/service.js';
import { createCalendarPushWorker } from '../src/masterCalendar/push.js';
import { createMasterCalendarRouter } from '../src/masterCalendar/routes.js';

const NOW = Date.parse('2026-11-02T14:00:00Z');
const at = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();

function event(id: string, startMin: number, extra: Record<string, unknown> = {}) {
  return { id, iCalUID: `${id}@google.com`, status: 'confirmed', summary: `Meeting ${id}`, start: { dateTime: at(startMin) }, end: { dateTime: at(startMin + 30) }, organizer: { email: 'nick@a.test', self: true }, ...extra };
}

describe('master calendar', () => {
  let db: Database.Database;
  let now: number;
  let calls: { connector: number; tool: CalendarTool; args: Record<string, unknown> }[];
  let events: Record<string, unknown[]>;
  let execute: CalendarExecute;
  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys=ON');
    migrate(db, fileURLToPath(new URL('../src/db/migrations', import.meta.url)));
    db.prepare("INSERT INTO users(id,email,display_name,role) VALUES(1,'nick@a.test','Nick','owner'),(2,'ali@a.test','Ali','member')").run();
    const add = db.prepare("INSERT INTO user_connectors(id,user_id,connector_slug,label,status,access_mode,config_json) VALUES(?,?,'googlecalendar',?,'connected',?,?)");
    add.run(8, 1, 'Nick@A.test', 'full', JSON.stringify({ sessionId: 's8', connectedAccountId: 'ca8' }));
    add.run(9, 1, 'Nick@B.test', 'read_only', JSON.stringify({ sessionId: 's9', connectedAccountId: 'ca9' }));
    add.run(10, 2, 'Ali@A.test', 'full', JSON.stringify({ sessionId: 's10', connectedAccountId: 'ca10' }));
    now = NOW;
    calls = [];
    events = {
      '8|primary': [
        event('e1', 30),
        event('shared', 120),
        event('invite', 300, { organizer: { email: 'boss@c.test' }, attendees: [{ email: 'nick@a.test', self: true, responseStatus: 'needsAction' }, { email: 'boss@c.test', organizer: true, responseStatus: 'accepted' }] }),
      ],
      '9|primary': [event('shared', 120, { organizer: { email: 'nick@a.test' }, attendees: [{ email: 'nick@b.test', self: true, responseStatus: 'needsAction' }] })],
      '9|holidays': [{ id: 'h', summary: 'Holiday', start: { date: '2026-11-03' }, end: { date: '2026-11-04' } }],
    };
    execute = vi.fn(async (connector, tool, args) => {
      calls.push({ connector: connector.id, tool, args });
      if (tool === 'GOOGLECALENDAR_LIST_CALENDARS')
        return { calendars: [{ id: 'primary', summary: connector.account, primary: true, accessRole: 'owner' }, ...(connector.id === 9 ? [{ id: 'holidays', summary: 'Holidays', accessRole: 'reader', selected: false }] : [])] };
      if (tool === 'GOOGLECALENDAR_EVENTS_LIST') return { items: events[`${connector.id}|${String(args.calendarId)}`] ?? [] };
      if (tool === 'GOOGLECALENDAR_CREATE_EVENT') {
        const created = event('new', 60, { summary: args.summary });
        events['8|primary']!.push(created);
        return { response_data: created };
      }
      if (tool === 'GOOGLECALENDAR_EVENTS_GET') {
        const found = (events[`${connector.id}|${String(args.calendar_id)}`] ?? []).find((e) => (e as { id: string }).id === args.event_id);
        if (!found) throw new CalendarToolError('not found', false, true);
        return found as Record<string, unknown>;
      }
      if (tool === 'GOOGLECALENDAR_DELETE_EVENT') {
        events['8|primary'] = events['8|primary']!.filter((e) => (e as { id: string }).id !== args.event_id);
        return {};
      }
      if (tool === 'GOOGLECALENDAR_PATCH_EVENT') {
        const list = events[`${connector.id}|${String(args.calendar_id)}`]!;
        const target = list.find((e) => (e as { id: string }).id === args.event_id) as Record<string, unknown>;
        if (args.summary) target.summary = args.summary;
        if (args.rsvp_response) (target.attendees as { self?: boolean; responseStatus?: string }[]).find((a) => a.self)!.responseStatus = String(args.rsvp_response);
        return {};
      }
      return {};
    }) as CalendarExecute;
  });
  afterEach(() => db.close());
  const make = () => createMasterCalendar(db, execute, () => now);

  it('lists only the person’s own installs, follows Google visibility, and colors by account', async () => {
    const accounts = await make().accounts(1);
    expect(accounts.map((a) => a.account)).toEqual(['nick@a.test', 'nick@b.test']);
    expect(accounts[0]!.color).not.toBe(accounts[1]!.color);
    expect(accounts[1]!.calendars.map((c) => [c.name, c.shown, c.writable])).toEqual([['nick@b.test', true, false], ['Holidays', false, false]]);
  });

  it('merges one event seen on two accounts and keeps the editable copy', async () => {
    const { events: list } = await make().events(1, NOW, NOW + 86_400_000);
    expect(list.map((e) => e.eventId)).toEqual(['e1', 'shared', 'invite']);
    const shared = list.find((e) => e.eventId === 'shared')!;
    expect([shared.connectorId, shared.canEdit, shared.alsoOn]).toEqual([8, true, ['nick@b.test']]);
    const invite = list.find((e) => e.eventId === 'invite')!;
    expect([invite.canEdit, invite.canRespond, invite.selfResponse]).toEqual([false, true, 'needsAction']);
  });

  it('caches reads for a minute and rejects huge ranges', async () => {
    const cal = make();
    await cal.events(1, NOW, NOW + 86_400_000);
    const reads = calls.length;
    await cal.events(1, NOW, NOW + 86_400_000);
    expect(calls.length).toBe(reads);
    now += 61_000;
    await cal.events(1, NOW, NOW + 86_400_000);
    expect(calls.length).toBeGreaterThan(reads);
    await expect(cal.events(1, NOW, NOW + 30 * 86_400_000)).rejects.toThrow(/15 days/);
  });

  it('shows hidden calendars when turned on', async () => {
    const cal = make();
    cal.updateSettings(1, { visibility: { '9:holidays': true } });
    const { events: list } = await cal.events(1, NOW, NOW + 2 * 86_400_000);
    expect(list.some((e) => e.allDay && e.title === 'Holiday')).toBe(true);
  });

  it('resolves reminder lead from event, then calendar, then the 10 minute default', async () => {
    const cal = make();
    let up = (await cal.upcoming(1)).events;
    expect(up.find((e) => e.eventId === 'e1')).toMatchObject({ leadMinutes: 10, dueMs: NOW + 20 * 60_000 });
    cal.updateSettings(1, { calendarLeads: { '8:primary': 30 } });
    up = (await cal.upcoming(1)).events;
    expect(up.find((e) => e.eventId === 'e1')).toMatchObject({ leadMinutes: 30, dueMs: NOW });
    const key = up.find((e) => e.eventId === 'e1')!.occurrenceKey;
    cal.setEventLead(1, { occurrenceKey: key, leadMinutes: null });
    expect((await cal.upcoming(1)).events.find((e) => e.eventId === 'e1')).toMatchObject({ leadMinutes: null, dueMs: null });
    cal.setEventLead(1, { occurrenceKey: key, leadMinutes: 'default' });
    expect((await cal.upcoming(1)).events.find((e) => e.eventId === 'e1')!.leadMinutes).toBe(30);
  });

  it('dismiss and snooze are shared state', async () => {
    const cal = make();
    const key = (await cal.upcoming(1)).events.find((e) => e.eventId === 'e1')!.occurrenceKey;
    cal.setReminderState(1, { occurrenceKey: key, action: 'snooze' });
    expect((await cal.upcoming(1)).events.find((e) => e.eventId === 'e1')).toMatchObject({ reminderState: 'snoozed', dueMs: NOW + 5 * 60_000 });
    cal.setReminderState(1, { occurrenceKey: key, action: 'dismiss' });
    expect((await cal.upcoming(1)).events.find((e) => e.eventId === 'e1')).toMatchObject({ reminderState: 'dismissed', dueMs: null });
  });

  it('creates through the owning account, reads back, and emails guests only when asked', async () => {
    const cal = make();
    const created = await cal.create(1, { connectorId: 8, calendarId: 'primary', title: 'Call Dana', allDay: false, start: at(60), end: at(90), timeZone: 'America/New_York', notifyGuests: false, attendees: ['dana@x.test'] });
    expect(created.title).toBe('Call Dana');
    const write = calls.find((c) => c.tool === 'GOOGLECALENDAR_CREATE_EVENT')!;
    expect(write.args).toMatchObject({ send_updates: 'none', create_meeting_room: false, attendees: ['dana@x.test'] });
    expect(calls.at(-1)!.tool).toBe('GOOGLECALENDAR_EVENTS_GET');
    await expect(cal.create(1, { connectorId: 9, calendarId: 'primary', title: 'x', allDay: false, start: at(60), end: at(90), timeZone: 'UTC', notifyGuests: false })).rejects.toThrow(/cannot add/);
    await expect(cal.create(1, { connectorId: 10, calendarId: 'primary', title: 'x', allDay: false, start: at(60), end: at(90), timeZone: 'UTC', notifyGuests: false })).rejects.toThrow(/not connected/);
    await expect(cal.create(1, { connectorId: 8, calendarId: 'primary', title: 'x', allDay: false, start: at(90), end: at(60), timeZone: 'UTC', notifyGuests: false })).rejects.toThrow(/after the start/);
  });

  it('edits, answers invites and deletes with read back', async () => {
    const cal = make();
    expect((await cal.update(1, 8, 'primary', 'e1', { title: 'Renamed', timeZone: 'UTC', notifyGuests: true })).title).toBe('Renamed');
    expect(calls.find((c) => c.tool === 'GOOGLECALENDAR_PATCH_EVENT')!.args).toMatchObject({ summary: 'Renamed', send_updates: 'all' });
    expect((await cal.respond(1, 8, 'primary', 'invite', { response: 'accepted' })).selfResponse).toBe('accepted');
    await expect(cal.respond(1, 9, 'primary', 'shared', { response: 'accepted' })).rejects.toThrow(/read-only/);
    expect(await cal.remove(1, 8, 'primary', 'e1', false)).toEqual({ deleted: true });
    expect(calls.find((c) => c.tool === 'GOOGLECALENDAR_DELETE_EVENT')!.args).toMatchObject({ send_updates: 'none' });
  });

  it('pushes each due reminder once per device', async () => {
    db.prepare("INSERT INTO bot_push_devices(id,user_id,endpoint_hash) VALUES('d1',1,'h1'),('d2',1,'h2')").run();
    const subscription = JSON.stringify({ endpoint: 'https://fcm.googleapis.com/x', keys: { p256dh: 'A'.repeat(87), auth: 'B'.repeat(22) } });
    const secrets = new Map<string, string>([['bot-push-device-d1', subscription], ['bot-push-device-d2', subscription], ['bot-push-vapid', JSON.stringify({ publicKey: 'p', privateKey: 'k' })]]);
    const store = { getApiKeyOverride: (k: string) => secrets.get(k) ?? null, setApiKeyOverride: (k: string, v: string) => void secrets.set(k, v), clearApiKeyOverride: (k: string) => void secrets.delete(k) };
    const cal = make();
    cal.updateSettings(1, {});
    const send = vi.fn(async () => ({}));
    const tick = createCalendarPushWorker({ db, secrets: store } as never, cal, send as never, () => now);
    await tick();
    expect(send).not.toHaveBeenCalled();
    now = NOW + 20 * 60_000;
    await tick();
    await tick();
    expect(send).toHaveBeenCalledTimes(2);
    expect(JSON.parse((send.mock.calls[0] as unknown[])[1] as string)).toMatchObject({ kind: 'calendar', title: 'Meeting e1', body: 'Starts in 10 min · nick@a.test' });
  });

  it('normalizes join links and all-day dates', () => {
    const ref = { connectorId: 1, account: 'a', calendarId: 'c', calendarName: 'C', color: '#000', writable: true };
    expect(normalizeEvent(event('z', 0, { location: 'https://zoom.us/j/123).' }), ref, 'UTC')!.joinUrl).toBe('https://zoom.us/j/123');
    expect(normalizeEvent(event('z', 0, { hangoutLink: 'javascript:alert(1)' }), ref, 'UTC')!.joinUrl).toBeNull();
    expect(zonedMidnight('2026-11-03', 'America/New_York')).toBe(Date.parse('2026-11-03T05:00:00Z'));
  });

  it('refuses agent sessions and reports uncertain writes plainly', async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = { id: 1, status: 'active' } as never;
      if (req.headers['x-agent']) req.agentConversationId = 'c1';
      next();
    });
    const failing: CalendarExecute = async (c, tool, args) => {
      if (tool === 'GOOGLECALENDAR_CREATE_EVENT') throw new CalendarToolError('Google did not answer in time.', true);
      return execute(c, tool, args);
    };
    app.use(createMasterCalendarRouter(createMasterCalendar(db, failing, () => now)));
    const server = app.listen(0);
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      expect((await fetch(`${base}/settings`, { headers: { 'x-agent': '1' } })).status).toBe(403);
      expect(await (await fetch(`${base}/settings`)).json()).toMatchObject({ defaultLeadMinutes: 10, panelOpen: false });
      const res = await fetch(`${base}/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ connectorId: 8, calendarId: 'primary', title: 'x', allDay: false, start: at(60), end: at(90), timeZone: 'UTC', notifyGuests: false }) });
      expect(res.status).toBe(502);
      expect(await res.json()).toMatchObject({ uncertain: true, error: expect.stringMatching(/Check the calendar/) });
    } finally {
      server.close();
    }
  });
});
