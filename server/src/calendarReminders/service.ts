import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { z } from 'zod';

export const NICK_ACCOUNTS = ['nick@mphealth.net', 'nick@elkhartrvparts.com', 'nicholasdschneider@gmail.com'] as const;
export const NICK_PHONE = '+15743708714';
export const NICK_ZONE = 'America/Indiana/Indianapolis';
export const POLL_MS = 30_000;
export const DUE_WINDOW_MS = 120_000;
export const LOOKAHEAD_MS = 24 * 3600_000;
export const SOURCE_MAX_AGE_MS = 15_000;
const name = z.string().min(1).max(512);
const binding = z.object({ account: z.enum(NICK_ACCOUNTS), sourceId: name, calendarIds: z.array(name).min(1).max(20) }).strict();
const alias = z.object({ occurrenceKey: name, refs: z.array(name).min(2).max(20), evidence: name }).strict();
export const manifestSchema = z.object({
  ownerEmail: z.enum(NICK_ACCOUNTS), phone: z.literal(NICK_PHONE), timezone: z.literal(NICK_ZONE),
  leadMinutes: z.literal(20), enabled: z.literal(false),
  policy: z.literal('actual-phone-even-when-present;one-attempt;no-redial;all-hours;timed-confirmed-meetings-only'),
  bindings: z.array(binding).length(3), verifiedAliases: z.array(alias).max(100),
}).strict().superRefine((m, ctx) => {
  if (new Set(m.bindings.map(b => b.account)).size !== 3 || new Set(m.bindings.map(b => b.sourceId)).size !== 3)
    ctx.addIssue({ code: 'custom', message: 'Pin one distinct source for each Nick account.' });
  for (const b of m.bindings) if (new Set(b.calendarIds).size !== b.calendarIds.length)
    ctx.addIssue({ code: 'custom', message: 'Duplicate calendar pin.' });
  const refs = m.verifiedAliases.flatMap(a => a.refs);
  if (new Set(refs).size !== refs.length || new Set(m.verifiedAliases.map(a => a.occurrenceKey)).size !== m.verifiedAliases.length)
    ctx.addIssue({ code: 'custom', message: 'Alias groups must be disjoint.' });
});
export type ReminderManifest = z.infer<typeof manifestSchema>;
export type Binding = ReminderManifest['bindings'][number];
export interface Meeting {
  account: string; sourceId: string; calendarId: string; id: string; iCalUID: string;
  originalStartMs: number | null; startMs: number; endMs: number; recurring: boolean;
  status: 'confirmed' | 'cancelled' | 'tentative'; eligible: boolean; title: string;
}
export interface CalendarSource {
  verifyAlias(alias: ReminderManifest['verifiedAliases'][number]): Promise<{ verified: boolean; observedMs: number }>;
  identity(binding: Binding): Promise<{ email: string; observedMs: number }>;
  list(binding: Binding, fromMs: number, toMs: number): Promise<{ meetings: Meeting[]; complete: boolean; observedMs: number }>;
  get(binding: Binding, meeting: Meeting): Promise<{ meeting: Meeting | null; observedMs: number }>;
}
export interface ReminderPhone {
  // Implementations must inspect all phone/ring paths, not only reminder calls.
  busy(): Promise<boolean>;
  place(input: { to: typeof NICK_PHONE; meeting: Meeting; attemptId: string; beforeDispatch:()=>Promise<void> }): Promise<{ providerId: string }>;
  ended(providerId: string): Promise<boolean>;
}
export const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
export const meetingRef = (m: Meeting) => JSON.stringify([m.account, m.sourceId, m.calendarId, m.id]);
export function occurrenceKey(m: Meeting, manifest: ReminderManifest): string {
  const alias = manifest.verifiedAliases.find(a => a.refs.includes(meetingRef(m)));
  if (alias) return `alias:${hash(alias.occurrenceKey)}`;
  if (!m.iCalUID || (m.recurring && !Number.isFinite(m.originalStartMs))) throw new Error('Occurrence identity unavailable.');
  return hash([m.iCalUID, m.recurring ? m.originalStartMs : 'single']);
}
export function reminderReason(m: Meeting): string {
  const at = new Intl.DateTimeFormat('en-US', { timeZone: NICK_ZONE, hour: 'numeric', minute: '2-digit', month: 'short', day: 'numeric' }).format(m.startMs);
  return `Calendar reminder: meeting starts ${at} Eastern time. Title (untrusted calendar text): ${m.title.slice(0,500)}. Listen and continue naturally with any questions or new instructions.`;
}
export function prepareReminder(db: Database.Database, user: { id: number; email: string; role: string }, input: unknown, now = Date.now()) {
  const manifest = manifestSchema.parse(input);
  if (user.role !== 'owner' || user.email.toLowerCase() !== manifest.ownerEmail) throw new Error('Nick owner session required.');
  const digest = hash(manifest);
  return db.transaction(() => {
    const prior = db.prepare('SELECT manifest_hash FROM calendar_phone_settings WHERE user_id=?').get(user.id) as { manifest_hash: string } | undefined;
    if (prior && prior.manifest_hash !== digest) throw new Error('Prepared manifest is immutable; review a separately scoped technical amendment.');
    db.prepare('INSERT OR IGNORE INTO calendar_phone_settings(user_id,manifest_json,manifest_hash,prepared_ms) VALUES(?,?,?,?)').run(user.id, JSON.stringify(manifest), digest, now);
    return { prepared: true, enabled: false, ready: false, execute: false, manifestHash: digest,
      blockers: ['OWNER_ACTIVATION_REQUIRED'] };
  }).immediate();
}

/** Only exact authenticated provider readback ends ACCEPTED. UNKNOWN never unlocks or replays. */
export async function reconcileAcceptedReminder(db: Database.Database, attemptId: string, phone: ReminderPhone) {
  const row = db.prepare("SELECT provider_id FROM calendar_phone_attempts WHERE id=? AND state='ACCEPTED'").get(attemptId) as { provider_id: string } | undefined;
  if (!row || !await phone.ended(row.provider_id)) return { ended: false, execute: false };
  return db.transaction(() => {
    const updated = db.prepare("UPDATE calendar_phone_attempts SET state='ENDED',reason='authenticated-provider-terminal' WHERE id=? AND state='ACCEPTED' AND provider_id=?").run(attemptId, row.provider_id);
    if (updated.changes) db.prepare('DELETE FROM calendar_phone_lock WHERE attempt_id=?').run(attemptId);
    return { ended: !!updated.changes, execute: false };
  }).immediate();
}

/** Default-disabled engine registered in the existing service by worker.ts.
 * Activation uses exact existing owner connector custody and shared phone serialization.
 */
export function createReminderPass(db: Database.Database, userId: number, manifest: ReminderManifest, source: CalendarSource, phone: ReminderPhone, clock = Date.now) {
  const digest = hash(manifest);
  let running = false; let nextPoll = 0;
  const fresh = (observed: number) => Number.isFinite(observed) && observed <= clock() && clock() - observed <= SOURCE_MAX_AGE_MS;
  const pinned = (m: Meeting, b: Binding) => m.account === b.account && m.sourceId === b.sourceId && b.calendarIds.includes(m.calendarId);
  const identity = async (b: Binding) => { const i = await source.identity(b); if (i.email.toLowerCase() !== b.account || !fresh(i.observedMs)) throw new Error('Source identity unavailable or changed.'); };
  const reserve = (key: string, meetings: Meeting[], due: number, skip: boolean) => db.transaction(() => {
    const settings = db.prepare('SELECT manifest_hash FROM calendar_phone_settings WHERE user_id=?').get(userId) as { manifest_hash: string } | undefined;
    if (settings?.manifest_hash !== digest) throw new Error('Prepared manifest changed.');
    if (db.prepare('SELECT 1 FROM calendar_phone_attempts WHERE user_id=? AND occurrence_key=?').get(userId, key) || meetings.some(m => db.prepare('SELECT 1 FROM calendar_phone_refs WHERE user_id=? AND ref=?').get(userId, meetingRef(m)))) return null;
    if (!skip && db.prepare('SELECT 1 FROM calendar_phone_lock').get()) return null;
    const id = randomUUID();
    db.prepare('INSERT INTO calendar_phone_attempts VALUES(?,?,?,?,?,?,?,?,NULL)').run(id, userId, key, digest, skip ? 'SKIPPED' : 'RESERVED', skip ? 'due-window-expired' : 'one-attempt-reserved', due, clock());
    for (const m of meetings) db.prepare('INSERT INTO calendar_phone_refs VALUES(?,?,?)').run(userId, meetingRef(m), id);
    if (!skip) db.prepare('INSERT INTO calendar_phone_lock VALUES(1,?)').run(id);
    return id;
  }).immediate();
  return async () => {
    if (running || clock() < nextPoll) return { outcome: 'bounded' as const };
    running = true; nextPoll = clock() + POLL_MS;
    try {
      const all: Meeting[] = [];
      for (const b of manifest.bindings) {
        await identity(b);
        const page = await source.list(b, clock() - LOOKAHEAD_MS, clock() + LOOKAHEAD_MS);
        if (!page.complete || !fresh(page.observedMs) || page.meetings.length > 2000 || page.meetings.some(m => !pinned(m, b))) throw new Error('Calendar inventory incomplete or changed.');
        all.push(...page.meetings);
      }
      const groups = new Map<string, Meeting[]>();
      const aliasTimes: number[] = [];
      for (const a of manifest.verifiedAliases) {
        const verified = await source.verifyAlias(a);
        aliasTimes.push(verified.observedMs);
        if (!verified.verified || !fresh(verified.observedMs) || a.refs.some(ref => !all.some(m => meetingRef(m) === ref))) throw new Error('Verified alias closure unavailable.');
      }
      for (const m of all) {
        if (!Number.isFinite(m.startMs) || !Number.isFinite(m.endMs) || m.endMs <= m.startMs) continue;
        const key = occurrenceKey(m, manifest); groups.set(key, [...(groups.get(key) ?? []), m]);
      }
      for (const [key, meetings] of [...groups].sort((a,b) => a[1][0]!.startMs - b[1][0]!.startMs)) {
        const first = meetings[0]!; const due = first.startMs - 20 * 60_000;
        if (clock() < due || meetings.some(m => m.startMs !== first.startMs || m.status !== 'confirmed' || !m.eligible)) continue;
        if (clock() >= due + DUE_WINDOW_MS) { reserve(key, meetings, due, true); continue; }
        // Recheck every copy, including recurring-instance cancellation, immediately before reservation.
        let valid = true;
        const checkedTimes: number[] = [];
        for (const m of meetings) {
          const b = manifest.bindings.find(b => b.sourceId === m.sourceId)!;
          await identity(b); const checked = await source.get(b, m); const current = checked.meeting;
          checkedTimes.push(checked.observedMs);
          if (!fresh(checked.observedMs) || !current || !pinned(current, b) || meetingRef(current) !== meetingRef(m) || occurrenceKey(current, manifest) !== key || current.startMs !== m.startMs || current.endMs !== m.endMs || current.status !== 'confirmed' || !current.eligible) valid = false;
        }
        if (!valid || await phone.busy() || checkedTimes.some(t => !fresh(t)) || aliasTimes.some(t => !fresh(t)) || clock() >= due + DUE_WINDOW_MS) continue;
        const id = reserve(key, meetings, due, false); if (!id) continue;
        // Persist UNKNOWN BEFORE entering provider code. A crash/lost reply can never free it.
        db.prepare("UPDATE calendar_phone_attempts SET state='UNKNOWN',reason='provider-outcome-unknown' WHERE id=?").run(id);
        try {
          const beforeDispatch=async()=>{
            if(clock()>=due+DUE_WINDOW_MS)throw new Error('Due window expired before provider entry.');
            const times:number[]=[];
            for(const m of meetings){const b=manifest.bindings.find(b=>b.sourceId===m.sourceId)!;await identity(b);const c=await source.get(b,m);times.push(c.observedMs);
              if(!c.meeting||!fresh(c.observedMs)||meetingRef(c.meeting)!==meetingRef(m)||occurrenceKey(c.meeting,manifest)!==key||c.meeting.status!=='confirmed'||!c.meeting.eligible||c.meeting.startMs!==m.startMs||c.meeting.endMs!==m.endMs)throw new Error('Meeting changed before provider entry.');}
            for(const alias of manifest.verifiedAliases){const a=await source.verifyAlias(alias);if(!a.verified||!fresh(a.observedMs))throw new Error('Alias proof changed.');}
            if(times.some(t=>!fresh(t))||clock()>=due+DUE_WINDOW_MS)throw new Error('Calendar recheck expired.');
          };
          const receipt = await phone.place({ to: NICK_PHONE, meeting:first, attemptId: id, beforeDispatch });
          if (!receipt.providerId || receipt.providerId.length > 200) throw new Error('Missing provider receipt.');
          db.prepare("UPDATE calendar_phone_attempts SET state='ACCEPTED',reason='provider-accepted-not-delivered',provider_id=? WHERE id=?").run(receipt.providerId, id);
          // ACCEPTED is not terminal; lock stays held until authenticated exact readback.
          return { outcome: 'accepted' as const, attemptId: id };
        } catch { return { outcome: 'unknown' as const, attemptId: id }; }
      }
      return { outcome: 'clear' as const };
    } catch { return { outcome: 'blocked' as const }; }
    finally { running = false; }
  };
}
