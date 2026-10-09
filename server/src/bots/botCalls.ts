import { z } from 'zod';
import type { AppContext } from '../context.js';
import type { UserRow } from '../db/db.js';
import { createBotService } from './service.js';
import { questionLine } from './questionLine.js';
import { randomUUID } from 'node:crypto';
import { E164, phoneConfigured } from '../voice/phone.js';
import { phoneBusy, reservePhone, releaseUnstartedPhone } from '../voice/phoneReservation.js';

/** How long one call rings before it counts as missed. */
export const RING_MS = 25_000;
/** A missed or unfinished call is tried again after this long, with no cap. */
export const RETRY_MS = 15 * 60_000;
/** Breathing room after a ring or a call before the next bot may ring. */
export const PAUSE_MS = 60_000;
/** Outside the calling hours a person can still be called this long after real input. */
export const ACTIVE_MS = 5 * 60_000;
/** A person who touched Veneer this recently sees the ring in the app, so no push is sent. */
export const PRESENT_MS = 60_000;
/** At most this many phone calls to one person in any hour, whatever the retries ask for. */
export const PHONE_CALLS_PER_HOUR = 6;

const time = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
export const callSettingsSchema = z.object({
  dnd: z.boolean().optional(),
  windowStart: time.optional(),
  windowEnd: time.optional(),
  bot: z.object({ conversationId: z.string().min(1).max(100), enabled: z.boolean() }).strict().optional(),
  /** Empty string forgets the number. */
  phone: z.string().trim().max(20).optional(),
  phoneEnabled: z.boolean().optional(),
}).strict();
/** "(574) 555-0100" and "574-555-0100" are read as US numbers; anything else must already be +country form. */
export function normalizePhone(input: string): string | null {
  const digits = input.replace(/[^\d+]/g, '');
  const value = digits.startsWith('+') ? digits : digits.length === 10 ? `+1${digits}` : digits.length === 11 && digits.startsWith('1') ? `+${digits}` : digits;
  return E164.test(value) ? value : null;
}

interface SettingsRow { dnd: number; window_start: string; window_end: string; timezone: string; active_ms: number; idle_ms: number; phone: string | null; phone_enabled: number }
type Ctx = Pick<AppContext, 'db' | 'liveVoice'> & { doppler?: Pick<AppContext['doppler'], 'get'> };
export interface PhoneCall { userId: number; logId: string; to: string; conversationId: string; decisionId: string | null }
interface RingRow { decision_id: string; state: 'ringing' | 'missed' | 'answered' | 'stopped'; attempts: number; ring_started_ms: number; next_attempt_ms: number; pushed: number; escalated: number }
export interface Ring { decisionId: string; conversationId: string; botName: string; question: string; remainingMs: number }

export function inCallWindow(s: Pick<SettingsRow, 'window_start' | 'window_end' | 'timezone'>, now: number) {
  if (s.window_start === s.window_end) return false;
  const t = new Intl.DateTimeFormat('en-GB', { timeZone: s.timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(now));
  return s.window_start < s.window_end ? t >= s.window_start && t < s.window_end : t >= s.window_start || t < s.window_end;
}

/**
 * A bot with a waiting question may ring the person before the question waits as text.
 * The question card is always the record; a ring only offers a faster way to answer it,
 * and nothing here answers, approves or changes a decision.
 */
export function botCalls(ctx: Ctx, user: UserRow) {
  const db = ctx.db;
  const row = () => {
    db.prepare('INSERT OR IGNORE INTO bot_call_settings(user_id) VALUES(?)').run(user.id);
    return db.prepare('SELECT * FROM bot_call_settings WHERE user_id=?').get(user.id) as SettingsRow;
  };
  const enabledBots = () => new Set((db.prepare('SELECT conversation_id FROM bot_call_bots WHERE user_id=? AND enabled=1').all(user.id) as { conversation_id: string }[]).map(r => r.conversation_id));
  const ringRow = (decisionId: string) => db.prepare('SELECT * FROM bot_call_rings WHERE user_id=? AND decision_id=?').get(user.id, decisionId) as RingRow | undefined;
  /** Questions this person can answer right now, in the line's fair order. */
  const answerable = () => questionLine(ctx, user).snapshot().decisions.filter(d => !d.stale);
  const view = (r: RingRow, d: ReturnType<typeof answerable>[number], now: number): Ring => ({
    decisionId: d.id, conversationId: d.conversation_id, botName: d.bot_name,
    question: String(d.proposal.review_summary?.request || d.proposal.question).slice(0, 300),
    remainingMs: Math.max(0, r.ring_started_ms + RING_MS - now),
  });
  const miss = (decisionId: string, now: number) => {
    db.prepare("UPDATE bot_call_rings SET state='missed',next_attempt_ms=?,escalated=0 WHERE user_id=? AND decision_id=? AND state='ringing'").run(now + RETRY_MS, user.id, decisionId);
    db.prepare('UPDATE bot_call_settings SET idle_ms=? WHERE user_id=?').run(now, user.id);
  };
  const onCall = () => !!ctx.liveVoice?.status(user.id) || phoneBusy(db,user.id);
  const startRing = (decisionId: string, now: number, attempt: boolean) => {
    db.prepare(`INSERT INTO bot_call_rings(user_id,decision_id,state,attempts,ring_started_ms,pushed) VALUES(?,?,'ringing',1,?,0)
      ON CONFLICT(user_id,decision_id) DO UPDATE SET state='ringing',attempts=attempts+?,ring_started_ms=excluded.ring_started_ms,pushed=0`).run(user.id, decisionId, now, Number(attempt));
    return ringRow(decisionId)!;
  };
  /** Keep, end or start this person's one ring. Safe to call from every poll and from the background pass. */
  const advance = (now = Date.now()): Ring | null => db.transaction(() => {
    const s = row();
    const bots = enabledBots();
    const busy = onCall();
    const ringing = db.prepare("SELECT * FROM bot_call_rings WHERE user_id=? AND state='ringing'").get(user.id) as RingRow | undefined;
    const escalatedWaiting = () => !!db.prepare("SELECT 1 FROM bot_call_rings WHERE user_id=? AND escalated=1 AND state<>'stopped'").get(user.id);
    if (!ringing && (s.dnd || busy || (!bots.size && !escalatedWaiting()))) return null;
    const line = answerable();
    if (ringing) {
      const d = line.find(q => q.id === ringing.decision_id);
      if (d && (bots.has(d.conversation_id) || ringing.escalated) && !s.dnd && !busy && now - ringing.ring_started_ms < RING_MS) return view(ringing, d, now);
      miss(ringing.decision_id, now);
      return null;
    }
    if (!inCallWindow(s, now) && now - s.active_ms > ACTIVE_MS) return null;
    const lastCall = (db.prepare('SELECT max(ended_ms) AS at FROM voice_sessions WHERE user_id=?').get(user.id) as { at: number | null }).at ?? 0;
    if (now - Math.max(s.idle_ms, lastCall) < PAUSE_MS) return null;
    const rings = new Map((db.prepare('SELECT * FROM bot_call_rings WHERE user_id=?').all(user.id) as RingRow[]).map(r => [r.decision_id, r]));
    const next = line.find(d => {
      const r = rings.get(d.id);
      // An escalated question rings once even when this person never turned calls on for its bot.
      if (!bots.has(d.conversation_id) && !r?.escalated) return false;
      return !r || (r.state !== 'stopped' && r.next_attempt_ms <= now);
    });
    return next ? view(startRing(next.id, now, true), next, now) : null;
  })();
  const bots = () => {
    const service = createBotService(db);
    const enabled = enabledBots();
    return (db.prepare('SELECT conversation_id,name FROM bot_registrations WHERE active=1 ORDER BY name COLLATE NOCASE').all() as { conversation_id: string; name: string }[])
      .filter(b => { try { service.chat({ user }, b.conversation_id); return true; } catch { return false; } })
      .map(b => ({ conversationId: b.conversation_id, name: b.name, enabled: enabled.has(b.conversation_id) }));
  };
  const phoneAvailable = () => !!ctx.doppler && phoneConfigured(ctx.doppler);
  const settings = () => { const s = row(); return { dnd: !!s.dnd, windowStart: s.window_start, windowEnd: s.window_end, timezone: s.timezone, bots: bots(),
    phone: s.phone, phoneEnabled: !!s.phone_enabled && !!s.phone, phoneAvailable: phoneAvailable() }; };
  const phoneCallsLastHour = (now: number) => (db.prepare('SELECT count(*) AS n FROM bot_phone_calls WHERE user_id=? AND started_ms>?').get(user.id, now - 3600_000) as { n: number }).n;
  const logPhoneCall = (decisionId: string | null, now: number) => reservePhone(db,user.id,row().phone!,decisionId,now);
  return {
    advance,
    settings,
    update(input: unknown) {
      const a = callSettingsSchema.parse(input);
      db.transaction(() => {
        row();
        if (a.dnd !== undefined) db.prepare('UPDATE bot_call_settings SET dnd=? WHERE user_id=?').run(Number(a.dnd), user.id);
        if (a.windowStart) db.prepare('UPDATE bot_call_settings SET window_start=? WHERE user_id=?').run(a.windowStart, user.id);
        if (a.windowEnd) db.prepare('UPDATE bot_call_settings SET window_end=? WHERE user_id=?').run(a.windowEnd, user.id);
        if (a.phone !== undefined) {
          const phone = a.phone ? normalizePhone(a.phone) : null;
          if (a.phone && !phone) throw new Error('Enter the phone number with its area code, for example (574) 555-0100.');
          db.prepare('UPDATE bot_call_settings SET phone=?,phone_enabled=CASE WHEN ? IS NULL THEN 0 ELSE phone_enabled END WHERE user_id=?').run(phone, phone, user.id);
        }
        if (a.phoneEnabled !== undefined) {
          if (a.phoneEnabled && !row().phone) throw new Error('Add your phone number first.');
          db.prepare('UPDATE bot_call_settings SET phone_enabled=? WHERE user_id=?').run(Number(a.phoneEnabled), user.id);
        }
        if (a.bot) {
          // Only a bot whose chat this person can reach may be turned on.
          createBotService(db).chat({ user }, a.bot.conversationId);
          db.prepare('INSERT INTO bot_call_bots(user_id,conversation_id,enabled) VALUES(?,?,?) ON CONFLICT(user_id,conversation_id) DO UPDATE SET enabled=excluded.enabled')
            .run(user.id, a.bot.conversationId, Number(a.bot.enabled));
        }
      })();
      return settings();
    },
    /** An open, visible tab checks in. `active` means real input since its last check. */
    poll(active: boolean, now = Date.now()) {
      row();
      if (active) db.prepare('UPDATE bot_call_settings SET active_ms=? WHERE user_id=?').run(now, user.id);
      return { ring: advance(now) };
    },
    /** The person picked up. The live call itself starts through the normal voice route. */
    answer(decisionId: string, now = Date.now()) {
      return db.transaction(() => {
        const r = ringRow(decisionId);
        const d = answerable().find(q => q.id === decisionId);
        if (!r || r.state === 'stopped' || !d) throw new Error('That call is no longer waiting. The question is still on your desk.');
        // If the call ends without an answer, the bot may try again after the usual gap.
        db.prepare("UPDATE bot_call_rings SET state='answered',next_attempt_ms=?,escalated=0 WHERE user_id=? AND decision_id=?").run(now + RETRY_MS, user.id, decisionId);
        db.prepare('UPDATE bot_call_settings SET idle_ms=? WHERE user_id=?').run(now, user.id);
        return { conversationId: d.conversation_id, decisionId };
      })();
    },
    decline(decisionId: string, now = Date.now()) { db.transaction(() => miss(decisionId, now))(); },
    /** A tapped call notification rings again in the app, without counting as another attempt. */
    ring(decisionId: string, now = Date.now()): Ring | null {
      return db.transaction(() => {
        const d = answerable().find(q => q.id === decisionId);
        const r = ringRow(decisionId);
        if (!d || !r || r.state === 'stopped' || onCall() || (!enabledBots().has(d.conversation_id) && !r.escalated)) return null;
        const other = db.prepare("SELECT decision_id FROM bot_call_rings WHERE user_id=? AND state='ringing' AND decision_id<>?").get(user.id, decisionId) as { decision_id: string } | undefined;
        if (other) miss(other.decision_id, now);
        return view(startRing(decisionId, now, false), d, now);
      })();
    },
    /**
     * Turn this person's current ring into a phone call when they are away from Veneer, have their
     * phone turned on, and it is inside their calling hours. Recent activity never widens the hours
     * for a phone call. The ring is reserved exactly like an answered one, so a call that ends
     * without an answer is tried again after the usual gap.
     */
    phoneFor(ring: Ring, now = Date.now()): PhoneCall | null {
      return db.transaction(() => {
        const s = row();
        if (!s.phone_enabled || !s.phone || !phoneAvailable() || onCall()) return null;
        if (now - s.active_ms <= PRESENT_MS || !inCallWindow(s, now) || phoneCallsLastHour(now) >= PHONE_CALLS_PER_HOUR) return null;
        const reserved = db.prepare("UPDATE bot_call_rings SET state='answered',next_attempt_ms=?,pushed=1,escalated=0 WHERE user_id=? AND decision_id=? AND state='ringing'").run(now + RETRY_MS, user.id, ring.decisionId);
        if (!reserved.changes) return null;
        db.prepare('UPDATE bot_call_settings SET idle_ms=? WHERE user_id=?').run(now, user.id);
        return { userId: user.id, logId: logPhoneCall(ring.decisionId, now), to: s.phone, conversationId: ring.conversationId, decisionId: ring.decisionId };
      })();
    },
    /** A call the person asks for from settings, to hear how it works. Uses the first bot they turned on. */
    testPhone(now = Date.now()): PhoneCall {
      return db.transaction(() => {
        const s = row();
        if (!s.phone) throw new Error('Add your phone number first.');
        if (!phoneAvailable()) throw new Error('Phone calling is not set up on this install.');
        if (onCall()) throw new Error('You are already on a call.');
        if (phoneCallsLastHour(now) >= PHONE_CALLS_PER_HOUR) throw new Error('That is enough calls for this hour. Try again later.');
        const bot = bots().find(b => b.enabled);
        if (!bot) throw new Error('Turn on at least one bot that can call you first.');
        return { userId: user.id, logId: logPhoneCall(null, now), to: s.phone, conversationId: bot.conversationId, decisionId: null };
      })();
    },
    /** "I can't do that now": the card stays on the desk and this question never rings again. */
    stop(decisionId: string) {
      db.prepare(`INSERT INTO bot_call_rings(user_id,decision_id,state) VALUES(?,?,'stopped')
        ON CONFLICT(user_id,decision_id) DO UPDATE SET state='stopped'`).run(user.id, decisionId);
      return { ok: true, stopped: true };
    },
    /**
     * A question waited too long: make its next ring due now instead of after the retry gap.
     * Nothing rings here. advance() and phoneFor() still decide whether and how to ring, so do not
     * disturb, calling hours, the pause, the hourly phone cap and a stopped question all still apply.
     * With `override` (the install owner's escalation) the question rings once even if this person
     * never turned calls on for its bot; the flag clears when that ring ends.
     */
    rearm(decisionId: string, now = Date.now(), opts: { override?: boolean } = {}): 'rearmed' | 'due' | 'ringing' | 'stopped' | 'calls_off' | 'not_answerable' {
      return db.transaction(() => {
        const d = answerable().find(q => q.id === decisionId);
        if (!d) return 'not_answerable';
        const enabled = enabledBots().has(d.conversation_id);
        if (!enabled && !opts.override) return 'calls_off';
        const r = ringRow(decisionId);
        if (!r) {
          if (enabled) return 'due';
          db.prepare("INSERT INTO bot_call_rings(user_id,decision_id,state,attempts,next_attempt_ms,escalated) VALUES(?,?,'missed',0,?,1)").run(user.id, decisionId, now);
          return 'rearmed';
        }
        if (r.state === 'stopped' || r.state === 'ringing') return r.state;
        const flag = enabled ? r.escalated : 1;
        if (r.next_attempt_ms <= now && flag === r.escalated) return 'due';
        db.prepare("UPDATE bot_call_rings SET next_attempt_ms=?,escalated=? WHERE user_id=? AND decision_id=? AND state IN ('missed','answered')").run(Math.min(now, r.next_attempt_ms), flag, user.id, decisionId);
        return 'rearmed';
      })();
    },
  };
}

/**
 * Rings that started while the person was not using Veneer: each becomes a phone call when their
 * phone is turned on and it is inside their hours, and otherwise one push to their devices.
 */
export function tickBotCalls(ctx: Ctx, now = Date.now()) {
  const users = ctx.db.prepare(`SELECT u.* FROM users u WHERE u.status='active'
    AND (EXISTS (SELECT 1 FROM bot_call_bots b WHERE b.user_id=u.id AND b.enabled=1)
      OR EXISTS (SELECT 1 FROM bot_call_rings r WHERE r.user_id=u.id AND r.escalated=1 AND r.state<>'stopped'))`).all() as UserRow[];
  const pushes: { userId: number; ring: Ring }[] = [];
  const phones: PhoneCall[] = [];
  for (const user of users) {
    try {
      const ring = botCalls(ctx, user).advance(now);
      if (!ring) continue;
      const s = ctx.db.prepare('SELECT active_ms FROM bot_call_settings WHERE user_id=?').get(user.id) as { active_ms: number };
      if (now - s.active_ms <= PRESENT_MS) continue;
      const phone = botCalls(ctx, user).phoneFor(ring, now);
      if (phone) { phones.push(phone); continue; }
      const claimed = ctx.db.prepare("UPDATE bot_call_rings SET pushed=1 WHERE user_id=? AND decision_id=? AND state='ringing' AND pushed=0").run(user.id, ring.decisionId);
      if (claimed.changes) pushes.push({ userId: user.id, ring });
    } catch { /* one person's unreadable line must not stop the others */ }
  }
  return { pushes, phones };
}

/** Place one reserved phone call. A call that cannot start is recorded and retried after the usual gap. */
export function startPhoneCall(ctx: Pick<AppContext, 'db' | 'liveVoice'>, call: PhoneCall): Promise<boolean> {
  const failed = () => {
    const consumed = ctx.db.prepare("SELECT 1 FROM phone_call_locks WHERE log_id=? AND phase<>'RESERVED'").get(call.logId);
    ctx.db.prepare('UPDATE bot_phone_calls SET status=?,ended_ms=? WHERE id=? AND ended_ms IS NULL').run(consumed ? 'unknown' : 'not_started',Date.now(),call.logId);
    releaseUnstartedPhone(ctx.db,call.logId); return false;
  };
  if (!ctx.liveVoice) return Promise.resolve(failed());
  return ctx.liveVoice.start(call.userId, { botConversationId: call.conversationId, ...(call.decisionId ? { decisionId: call.decisionId, incoming: true } : {}), phone: { to: call.to, logId: call.logId } })
    .then(() => true).catch(() => failed());
}
