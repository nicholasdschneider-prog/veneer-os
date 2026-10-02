import { z } from 'zod';
import type { AppContext } from '../context.js';
import type { UserRow } from '../db/db.js';
import { createBotService } from './service.js';
import { questionLine } from './questionLine.js';

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

const time = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
export const callSettingsSchema = z.object({
  dnd: z.boolean().optional(),
  windowStart: time.optional(),
  windowEnd: time.optional(),
  bot: z.object({ conversationId: z.string().min(1).max(100), enabled: z.boolean() }).strict().optional(),
}).strict();

interface SettingsRow { dnd: number; window_start: string; window_end: string; timezone: string; active_ms: number; idle_ms: number }
interface RingRow { decision_id: string; state: 'ringing' | 'missed' | 'answered' | 'stopped'; attempts: number; ring_started_ms: number; next_attempt_ms: number; pushed: number }
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
export function botCalls(ctx: Pick<AppContext, 'db' | 'liveVoice'>, user: UserRow) {
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
    db.prepare("UPDATE bot_call_rings SET state='missed',next_attempt_ms=? WHERE user_id=? AND decision_id=? AND state='ringing'").run(now + RETRY_MS, user.id, decisionId);
    db.prepare('UPDATE bot_call_settings SET idle_ms=? WHERE user_id=?').run(now, user.id);
  };
  const onCall = () => !!ctx.liveVoice?.status(user.id);
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
    if (!ringing && (s.dnd || busy || !bots.size)) return null;
    const line = answerable();
    if (ringing) {
      const d = line.find(q => q.id === ringing.decision_id);
      if (d && bots.has(d.conversation_id) && !s.dnd && !busy && now - ringing.ring_started_ms < RING_MS) return view(ringing, d, now);
      miss(ringing.decision_id, now);
      return null;
    }
    if (!inCallWindow(s, now) && now - s.active_ms > ACTIVE_MS) return null;
    const lastCall = (db.prepare('SELECT max(ended_ms) AS at FROM voice_sessions WHERE user_id=?').get(user.id) as { at: number | null }).at ?? 0;
    if (now - Math.max(s.idle_ms, lastCall) < PAUSE_MS) return null;
    const rings = new Map((db.prepare('SELECT * FROM bot_call_rings WHERE user_id=?').all(user.id) as RingRow[]).map(r => [r.decision_id, r]));
    const next = line.find(d => {
      if (!bots.has(d.conversation_id)) return false;
      const r = rings.get(d.id);
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
  const settings = () => { const s = row(); return { dnd: !!s.dnd, windowStart: s.window_start, windowEnd: s.window_end, timezone: s.timezone, bots: bots() }; };
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
        db.prepare("UPDATE bot_call_rings SET state='answered',next_attempt_ms=? WHERE user_id=? AND decision_id=?").run(now + RETRY_MS, user.id, decisionId);
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
        if (!d || !r || r.state === 'stopped' || onCall() || !enabledBots().has(d.conversation_id)) return null;
        const other = db.prepare("SELECT decision_id FROM bot_call_rings WHERE user_id=? AND state='ringing' AND decision_id<>?").get(user.id, decisionId) as { decision_id: string } | undefined;
        if (other) miss(other.decision_id, now);
        return view(startRing(decisionId, now, false), d, now);
      })();
    },
    /** "I can't do that now": the card stays on the desk and this question never rings again. */
    stop(decisionId: string) {
      db.prepare(`INSERT INTO bot_call_rings(user_id,decision_id,state) VALUES(?,?,'stopped')
        ON CONFLICT(user_id,decision_id) DO UPDATE SET state='stopped'`).run(user.id, decisionId);
      return { ok: true, stopped: true };
    },
  };
}

/** Rings that started while the person was not using Veneer and have not been pushed to their devices yet. */
export function tickBotCalls(ctx: Pick<AppContext, 'db' | 'liveVoice'>, now = Date.now()) {
  const users = ctx.db.prepare(`SELECT u.* FROM users u WHERE u.status='active'
    AND EXISTS (SELECT 1 FROM bot_call_bots b WHERE b.user_id=u.id AND b.enabled=1)`).all() as UserRow[];
  const pushes: { userId: number; ring: Ring }[] = [];
  for (const user of users) {
    try {
      const ring = botCalls(ctx, user).advance(now);
      if (!ring) continue;
      const s = ctx.db.prepare('SELECT active_ms FROM bot_call_settings WHERE user_id=?').get(user.id) as { active_ms: number };
      if (now - s.active_ms <= PRESENT_MS) continue;
      const claimed = ctx.db.prepare("UPDATE bot_call_rings SET pushed=1 WHERE user_id=? AND decision_id=? AND state='ringing' AND pushed=0").run(user.id, ring.decisionId);
      if (claimed.changes) pushes.push({ userId: user.id, ring });
    } catch { /* one person's unreadable line must not stop the others */ }
  }
  return pushes;
}
