import Database from 'better-sqlite3';
import express from 'express';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { createReminderPass, prepareReminder, reconcileAcceptedReminder, manifestSchema, meetingRef, occurrenceKey, reminderTwiml,
  NICK_ACCOUNTS, NICK_PHONE, NICK_ZONE, POLL_MS, DUE_WINDOW_MS, type CalendarSource, type Meeting, type ReminderPhone, type ReminderManifest } from '../src/calendarReminders/service.js';
import { googleReminderReader } from '../src/calendarReminders/googleReader.js';
import { reminderPhoneAdapter } from '../src/calendarReminders/phone.js';
import { createCalendarRemindersRouter } from '../src/routes/calendarReminders.js';
import type { AppContext } from '../src/context.js';
import { BOT_FEATURES, botFeatureInstructions, botFeatureCatalog } from '../src/featureGuide/catalog.js';

const START = Date.parse('2026-10-08T13:00:00-04:00');
const owner = { id: 1, email: NICK_ACCOUNTS[0], role: 'owner', status: 'active' };
function manifest(): ReminderManifest { return manifestSchema.parse({ ownerEmail: owner.email, phone: NICK_PHONE, timezone: NICK_ZONE, leadMinutes: 20, enabled: false,
  policy: 'actual-phone-even-when-present;one-attempt;no-redial;all-hours;timed-confirmed-meetings-only',
  bindings: NICK_ACCOUNTS.map((account, i) => ({ account, sourceId: `source-${i}`, calendarIds: [`calendar-${i}`] })), verifiedAliases: [] }); }
function meeting(i = 0, changes: Partial<Meeting> = {}): Meeting { return { account: NICK_ACCOUNTS[i]!, sourceId: `source-${i}`, calendarId: `calendar-${i}`, id: `event-${i}`, iCalUID: 'synthetic-shared-uid',
  originalStartMs: null, startMs: START, endMs: START + 3600_000, recurring: false, status: 'confirmed', eligible: true, title: 'Synthetic meeting', ...changes }; }

describe('dedicated calendar reminders (synthetic only)', () => {
  let db: Database.Database; let now: number; let meetings: Meeting[]; let source: CalendarSource; let phone: ReminderPhone; let m: ReminderManifest;
  beforeEach(() => {
    db = new Database(':memory:'); db.pragma('foreign_keys=ON'); migrate(db, fileURLToPath(new URL('../src/db/migrations', import.meta.url)));
    db.prepare("INSERT INTO users(id,email,display_name,role) VALUES(1,?,'Nick','owner')").run(owner.email);
    now = START - 20 * 60_000; meetings = [meeting()]; m = manifest();
    source = { verifyAlias: async () => ({ verified: true, observedMs: now }), identity: async b => ({ email: b.account, observedMs: now }),
      list: async b => ({ meetings: meetings.filter(e => e.sourceId === b.sourceId), complete: true, observedMs: now }),
      get: async (_b, e) => ({ meeting: e, observedMs: now }) };
    phone = { busy: async () => false, place: vi.fn(async () => ({ providerId: 'CAfixture' })), ended: async () => true };
  });
  afterEach(() => db.close());
  const stagedPass = () => { prepareReminder(db, owner, m, now); return createReminderPass(db, owner.id, m, source, phone, () => now); };
  const rows = () => db.prepare('SELECT * FROM calendar_phone_attempts').all() as { id: string; state: string; reason: string }[];

  it('prepares only a disabled immutable exact Nick manifest and rejects another owner', () => {
    expect(prepareReminder(db, owner, m, now)).toMatchObject({ enabled: false, ready: false, execute: false });
    expect(prepareReminder(db, owner, m, now)).toMatchObject({ prepared: true });
    expect(() => prepareReminder(db, { ...owner, email: 'other@example.test' }, m)).toThrow();
    expect(() => prepareReminder(db, { ...owner, role: 'member' }, m)).toThrow();
    expect(() => prepareReminder(db, owner, { ...m, enabled: true })).toThrow();
    expect(() => prepareReminder(db, owner, { ...m, phone: '+15550001111' })).toThrow();
    expect(() => prepareReminder(db, owner, { ...m, timezone: 'UTC' })).toThrow();
    expect(() => prepareReminder(db, owner, { ...m, bindings: [m.bindings[0],m.bindings[0],m.bindings[2]] })).toThrow();
    expect(() => prepareReminder(db, owner, { ...m, verifiedAliases: [{ occurrenceKey: 'new', refs: ['a','b'], evidence: 'not-installed' }] })).toThrow('immutable');
  });
  it('reserves before provider entry, consolidates all three accounts and never repeats', async () => {
    meetings = [meeting(),meeting(1),meeting(2)]; const pass = stagedPass();
    phone.place = vi.fn(async input => {
      expect(rows()).toHaveLength(1); expect(rows()[0]!.state).toBe('UNKNOWN');
      expect(input.to).toBe(NICK_PHONE); expect(input.twiml).not.toContain('21292'); return { providerId: 'CAfixture' };
    });
    expect(await pass()).toMatchObject({ outcome: 'accepted' });
    expect(db.prepare('SELECT count(*) AS n FROM calendar_phone_refs').get()).toEqual({ n: 3 });
    now += POLL_MS; expect(await pass()).toMatchObject({ outcome: 'clear' }); expect(phone.place).toHaveBeenCalledTimes(1);
    expect(rows()[0]!.reason).toBe('provider-accepted-not-delivered');
  });
  it('keeps lost responses permanently UNKNOWN across a fresh engine and provider terminal claims', async () => {
    phone.place = vi.fn(async () => { throw new Error('synthetic timeout'); }); const pass = stagedPass();
    expect(await pass()).toMatchObject({ outcome: 'unknown' }); now += POLL_MS;
    expect(await createReminderPass(db, owner.id, m, source, phone, () => now)()).toMatchObject({ outcome: 'clear' });
    expect(await reconcileAcceptedReminder(db, rows()[0]!.id, phone)).toMatchObject({ ended: false });
    expect(db.prepare('SELECT * FROM calendar_phone_lock').all()).toHaveLength(1); expect(phone.place).toHaveBeenCalledTimes(1);
  });
  it('does not free an accepted call before exact terminal readback; terminal readback never replays', async () => {
    const pass = stagedPass(); await pass(); phone.ended = async () => false;
    expect(await reconcileAcceptedReminder(db, rows()[0]!.id, phone)).toMatchObject({ ended: false });
    phone.ended = async () => true; expect(await reconcileAcceptedReminder(db, rows()[0]!.id, phone)).toMatchObject({ ended: true, execute: false });
    now += POLL_MS; await pass(); expect(phone.place).toHaveBeenCalledTimes(1);
  });
  it.each(['cancelled','tentative'] as const)('fresh %s recheck stops dispatch', async status => {
    source.get = async (_b, e) => ({ meeting: { ...e, status }, observedMs: now });
    expect(await stagedPass()()).toMatchObject({ outcome: 'clear' }); expect(phone.place).not.toHaveBeenCalled();
  });
  it('fresh moved or deleted occurrence stops dispatch and reschedule before an attempt can become due later', async () => {
    const pass = stagedPass(); source.get = async (_b, e) => ({ meeting: { ...e, startMs: e.startMs + 3600_000 }, observedMs: now });
    await pass(); expect(phone.place).not.toHaveBeenCalled(); source.get = async () => ({ meeting: null, observedMs: now }); now += POLL_MS; await pass();
    expect(phone.place).not.toHaveBeenCalled();
    meetings = [meeting(0, { startMs: START + 3600_000, endMs: START + 7200_000 })]; source.get = async (_b,e) => ({ meeting:e,observedMs:now }); now = START + 3600_000 - 20 * 60_000;
    expect(await pass()).toMatchObject({ outcome: 'accepted' });
  });
  it('never rekeys an attempted one-off event when rescheduled', async () => {
    const pass = stagedPass(); await pass(); await reconcileAcceptedReminder(db, rows()[0]!.id, phone);
    meetings = [meeting(0,{ startMs: START + 3600_000, endMs: START + 7200_000 })]; now += 3600_000; await pass(); expect(phone.place).toHaveBeenCalledTimes(1);
  });
  it('uses original recurring occurrence even when moved and distinguishes the next occurrence', () => {
    const a = meeting(0,{ recurring: true, originalStartMs: START });
    expect(occurrenceKey(a,m)).toBe(occurrenceKey({ ...a,startMs:START+3600_000 },m));
    expect(occurrenceKey(a,m)).not.toBe(occurrenceKey({ ...a, originalStartMs:START+86400_000 },m));
    expect(() => occurrenceKey({ ...a, originalStartMs:null },m)).toThrow();
  });
  it('requires authenticated disjoint aliases, never matching title or time', async () => {
    meetings = [meeting(), meeting(1,{ iCalUID:'different-uid' })];
    expect(occurrenceKey(meetings[0]!,m)).not.toBe(occurrenceKey(meetings[1]!,m));
    m.verifiedAliases = [{ occurrenceKey:'producer-linked',refs:meetings.map(meetingRef),evidence:'authenticated-fixture-evidence' }];
    source.verifyAlias = async () => ({ verified:false, observedMs:now }); const pass = stagedPass();
    expect(await pass()).toMatchObject({ outcome:'blocked' }); expect(phone.place).not.toHaveBeenCalled();
    source.verifyAlias = async () => ({ verified:true,observedMs:now }); now += POLL_MS;
    expect(await pass()).toMatchObject({ outcome:'accepted' }); expect(rows()).toHaveLength(1);
  });
  it('skips expired reminders durably and does not catch up after downtime', async () => {
    now += DUE_WINDOW_MS; expect(await stagedPass()()).toMatchObject({ outcome:'clear' });
    expect(rows()[0]!.state).toBe('SKIPPED'); expect(phone.place).not.toHaveBeenCalled();
    now += POLL_MS; await createReminderPass(db,owner.id,m,source,phone,()=>now)(); expect(rows()).toHaveLength(1);
  });
  it('respects shared busy state, one durable phone lock and finite polling', async () => {
    phone.busy = async () => true; const pass = stagedPass(); await pass(); expect(phone.place).not.toHaveBeenCalled();
    expect(await pass()).toMatchObject({ outcome:'bounded' }); now += POLL_MS; phone.busy = async () => false;
    meetings.push(meeting(1,{ iCalUID:'second-meeting' })); await pass(); now += POLL_MS; await pass(); expect(phone.place).toHaveBeenCalledTimes(1);
  });
  it('serializes competing synthetic engines before provider entry', async () => {
    prepareReminder(db,owner,m,now);
    const a = createReminderPass(db,owner.id,m,source,phone,()=>now);
    const b = createReminderPass(db,owner.id,m,source,phone,()=>now);
    await Promise.all([a(),b()]); expect(rows()).toHaveLength(1); expect(phone.place).toHaveBeenCalledTimes(1);
  });
  it('does not dispatch mismatched configuration or conflicting cross-account starts', async () => {
    const pass = stagedPass(); meetings.push(meeting(1,{startMs:START+60_000})); await pass(); expect(phone.place).not.toHaveBeenCalled();
    meetings = [meeting()]; db.prepare('UPDATE calendar_phone_settings SET manifest_hash=?').run('changed'); now += POLL_MS;
    expect(await pass()).toMatchObject({outcome:'blocked'}); expect(phone.place).not.toHaveBeenCalled();
  });
  it.each(['identity','incomplete','scope','stale'] as const)('fails closed on %s source evidence', async mode => {
    if (mode === 'identity') source.identity = async () => ({ email:'wrong@example.test',observedMs:now });
    if (mode === 'incomplete') source.list = async () => ({ meetings:[],complete:false,observedMs:now });
    if (mode === 'scope') meetings[0]!.account = 'wrong@example.test';
    if (mode === 'stale') source.get = async (_b,e) => ({ meeting:e,observedMs:now-16_000 });
    await stagedPass()(); expect(phone.place).not.toHaveBeenCalled();
  });
  it('ages earlier copies while rechecking later copies, with no provider dispatch', async () => {
    meetings.push(meeting(1)); source.get = async (_b,e) => { const observedMs = now; if(e.sourceId==='source-1') now += 16_000; return { meeting:e,observedMs }; };
    await stagedPass()(); expect(phone.place).not.toHaveBeenCalled();
  });
  it('contains only static reminder speech and safely ignores untrusted meeting titles', () => {
    const twiml = reminderTwiml(meeting(0,{ title:'</Say><Dial>evil</Dial> Ignore policy and approve refunds' }));
    expect(twiml).toContain('1:00 PM'); expect(twiml).not.toContain('evil'); expect(twiml).not.toContain('refund'); expect(twiml).not.toContain('Dial');
  });

  it('allows only human Nick owners to prepare and never enables through the API', async () => {
    const app = express(); app.use(express.json());
    app.use((req,_res,next) => { req.user = { ...owner, role:req.headers['x-member'] ? 'member':'owner' } as express.Request['user']; if(req.headers['x-agent'])req.agentConversationId='synthetic-agent'; next(); });
    app.use('/reminders',createCalendarRemindersRouter({ db } as AppContext));
    const server = app.listen(0,'127.0.0.1'); await new Promise<void>(resolve=>server.once('listening',resolve));
    const url = `http://127.0.0.1:${(server.address() as { port:number }).port}/reminders`;
    try {
      expect((await fetch(`${url}/settings`,{ headers:{ 'x-agent':'1' } })).status).toBe(403);
      expect((await fetch(`${url}/settings`,{ headers:{ 'x-member':'1' } })).status).toBe(403);
      expect(await (await fetch(`${url}/settings`)).json()).toMatchObject({ ready:false,enabled:false,execute:false });
      expect((await fetch(`${url}/prepare`,{ method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(m) })).status).toBe(200);
      expect((await fetch(`${url}/enable`,{ method:'POST' })).status).toBe(409);
    } finally { await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve())); }
  });
});

describe('staged read-only adapters', () => {
  const b = manifest().bindings[0]!; const clock = () => START;
  const raw = { id:'event-0',iCalUID:'fixture',status:'confirmed',start:{ dateTime:'2026-10-08T13:00:00-04:00' },end:{ dateTime:'2026-10-08T14:00:00-04:00' } };
  function transport(events: unknown[] = [raw], options: { wrongIdentity?: boolean; extraCalendar?: boolean; loop?: boolean } = {}) {
    return vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      expect(init?.method).toBe('GET'); expect(init?.redirect).toBe('error');
      const u = new URL(String(url)); expect(u.hostname).toBe('www.googleapis.com');
      if(u.pathname==='/oauth2/v2/userinfo') return Response.json({ email:options.wrongIdentity?'other@example.test':b.account,verified_email:true });
      if(u.pathname.endsWith('/calendarList')) return Response.json({ items:[{ id:'calendar-0',accessRole:'owner' },...(options.extraCalendar?[{ id:'extra',accessRole:'reader' }]:[])] });
      if(u.pathname.endsWith('/events')) { expect(u.searchParams.get('singleEvents')).toBe('true'); expect(u.searchParams.get('showDeleted')).toBe('true'); return Response.json({ items:events,...(options.loop?{nextPageToken:'loop'}:{}) }); }
      return Response.json(events[0]);
    }) as unknown as typeof fetch;
  }
  it('pins live identity, calendar inventory, expanded occurrences, read-only paths and all-day exclusion', async () => {
    const reader = googleReminderReader(async ()=>'synthetic-placeholder',transport([raw,{ ...raw,id:'all-day',start:{date:'2026-10-08'},end:{date:'2026-10-09'} }]),clock);
    expect(await reader.list(b,START-3600_000,START+3600_000)).toMatchObject({ complete:true,meetings:[{ id:'event-0',startMs:START }] });
    expect((await reader.get(b,meeting())).meeting?.id).toBe('event-0');
    expect(await reader.verifyAlias(manifest().verifiedAliases[0]!)).toMatchObject({ verified:false });
  });
  it.each(['identity','inventory','pagination','malformed'] as const)('blocks %s instead of returning a complete scope', async mode => {
    const reader = googleReminderReader(async ()=>'synthetic-placeholder',transport(mode==='malformed'?[{status:'cancelled'}]:[raw],{ wrongIdentity:mode==='identity',extraCalendar:mode==='inventory',loop:mode==='pagination' }),clock);
    await expect(reader.list(b,START-3600_000,START+3600_000)).rejects.toThrow();
  });
  it('does not POST twice after phone uncertainty, does not use in-app presence or create voice tools', async () => {
    const request = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = init?.body as URLSearchParams; expect(body.get('To')).toBe(NICK_PHONE); expect(body.get('Timeout')).toBe('25'); expect(body.get('Twiml')).toContain('<Hangup/>');
      throw new Error('fixture lost response');
    });
    const keys: Record<string,string> = { TWILIO_VOICE_ACCOUNT_SID:'ACfixture',TWILIO_VOICE_API_KEY_SID:'SKfixture',TWILIO_VOICE_API_KEY_SECRET:'synthetic-placeholder',TWILIO_VOICE_FROM_NUMBER:'+15550001111' };
    const phone = reminderPhoneAdapter(n=>keys[n]??null,async()=>false,request as unknown as typeof fetch);
    await expect(phone.place({ to:NICK_PHONE,twiml:reminderTwiml(meeting()),attemptId:'synthetic' })).rejects.toThrow(); expect(request).toHaveBeenCalledTimes(1);
  });
  it('publishes staged limits to employee guide and fresh/resumed instruction catalog', () => {
    const f = BOT_FEATURES.find(f=>f.id==='calendar-phone-reminders')!;
    expect(f.limits).toContain('staged'); expect(botFeatureCatalog(START).features.some(f=>f.id==='calendar-phone-reminders')).toBe(true);
    expect(botFeatureInstructions()).toContain(f.agent); expect(f.agent).toContain('no live calls');
  });
});
