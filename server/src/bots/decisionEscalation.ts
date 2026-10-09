import crypto from 'node:crypto';
import type { UserRow } from '../db/db.js';
import { queueNotification } from '../botWorkflows/notifications.js';
import { botCalls } from './botCalls.js';

/**
 * Stale question escalation. A question card still waiting for a human after more than four
 * business hours is escalated once per business day to its assignee and the install owner,
 * through the existing push outbox and the existing bot call rings. Nothing here answers,
 * approves, revises or reorders a decision, and no new channel is opened: every notification
 * preference, quiet hour, calling hour, do-not-disturb and stopped ring still applies.
 */

export const BUSINESS_ZONE = 'America/New_York';
export const BUSINESS_START_HOUR = 8;
export const BUSINESS_END_HOUR = 18;
export const ESCALATE_AFTER_MS = 4 * 3600_000;
const DAY_MS = 86_400_000;

const zoned = new Intl.DateTimeFormat('en-US', {
  timeZone: BUSINESS_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', weekday: 'short',
});
function local(ms: number) {
  const o: Record<string, string> = {};
  for (const p of zoned.formatToParts(new Date(ms))) o[p.type] = p.value;
  return { y: +o.year!, m: +o.month!, d: +o.day!, h: +o.hour!, min: +o.minute!, s: +o.second!, weekend: o.weekday === 'Sat' || o.weekday === 'Sun' };
}
/** UTC instant of a whole-hour New York wall time. Business hours never fall in a DST gap. */
function zonedHour(y: number, m: number, d: number, hour: number) {
  const wall = Date.UTC(y, m - 1, d, hour);
  const offset = (at: number) => { const p = local(at); return Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s) - Math.floor(at / 1000) * 1000; };
  const first = wall - offset(wall);
  return wall - offset(first);
}

/** Business time (Mon-Fri 08:00-18:00 New York) between two instants, in ms. */
export function businessMsBetween(startMs: number, endMs: number): number {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return 0;
  const s = local(startMs), e = local(endMs);
  const last = Date.UTC(e.y, e.m - 1, e.d);
  let total = 0;
  // Calendar dates are walked as UTC midnights, which have no DST, so +1 day is always exact.
  for (let day = Date.UTC(s.y, s.m - 1, s.d), guard = 0; day <= last && guard < 4000; day += DAY_MS, guard++) {
    const date = new Date(day);
    const dow = date.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    const [y, m, d] = [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()];
    const open = zonedHour(y, m, d, BUSINESS_START_HOUR), close = zonedHour(y, m, d, BUSINESS_END_HOUR);
    total += Math.max(0, Math.min(close, endMs) - Math.max(open, startMs));
  }
  return total;
}

/** The New York date (YYYY-MM-DD) when `ms` is inside business hours, otherwise null. */
export function businessDay(ms: number): string | null {
  const p = local(ms);
  if (p.weekend || p.h < BUSINESS_START_HOUR || p.h >= BUSINESS_END_HOUR) return null;
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

/** On unless VP_DECISION_ESCALATION is 0, false, off or no. Read on every pass. */
export function escalationEnabled(env: NodeJS.ProcessEnv = process.env) {
  return !['0', 'false', 'off', 'no'].includes((env.VP_DECISION_ESCALATION ?? '').trim().toLowerCase());
}

function sqliteMs(at: string) {
  return Date.parse(at.replace(' ', 'T') + (/Z$|[+-]\d\d:\d\d$/.test(at) ? '' : 'Z'));
}

export interface EscalationCard { id: string; conversation_id: string; version: number; assignee_id: number; waiting_since: string }
export type RingOutcome = ReturnType<ReturnType<typeof botCalls>['rearm']> | 'error';
export interface EscalationAdapters {
  /** Queue the usual "a bot needs your input" push for one person. Returns devices queued. */
  notify(user: UserRow, card: EscalationCard, eventKey: string, now: number): number;
  /** Make one re-ring due for one person through the existing call ring. */
  ring(user: UserRow, card: EscalationCard, now: number): RingOutcome;
}
type Ctx = Parameters<typeof botCalls>[0];

export function defaultEscalationAdapters(ctx: Ctx): EscalationAdapters {
  return {
    notify: (user, card, key, now) => queueNotification(ctx, card.conversation_id, key, 'input', `#/bots/${encodeURIComponent(card.id)}`, new Date(now).toISOString(), [user.id]),
    ring: (user, card, now) => botCalls(ctx, user).rearm(card.id, now),
  };
}

/** Questions waiting for a human answer on their current version: not parked, stale, answered or settled. */
export function waitingCards(db: Ctx['db'], day: string): EscalationCard[] {
  return db.prepare(`SELECT d.id,d.conversation_id,d.version,d.assignee_id,
      COALESCE((SELECT max(e.created_at) FROM bot_decision_events e WHERE e.decision_id=d.id AND e.version=d.version AND e.kind IN ('raised','revised')),
        CASE WHEN d.version=1 THEN d.created_at ELSE d.updated_at END) AS waiting_since
    FROM bot_decisions d
    WHERE d.state='needs_input' AND d.parked_json IS NULL AND d.stale_json IS NULL
      AND NOT EXISTS (SELECT 1 FROM bot_decision_events a WHERE a.decision_id=d.id AND a.version=d.version AND a.kind='answered')
      AND NOT EXISTS (SELECT 1 FROM bot_decision_escalations x WHERE x.decision_id=d.id AND x.business_day=?)
    ORDER BY d.created_at,d.id`).all(day) as EscalationCard[];
}

/**
 * One pass. Fires only inside business hours, so each business day gets at most one
 * escalation per card, enforced by UNIQUE(decision_id, business_day).
 */
export function escalateStaleDecisions(ctx: Ctx, now = Date.now(), adapters: EscalationAdapters = defaultEscalationAdapters(ctx), log: (line: string) => void = console.log) {
  const day = businessDay(now);
  if (!day) return [];
  const db = ctx.db;
  const owners = () => db.prepare("SELECT * FROM users WHERE role='owner' AND status='active' ORDER BY id").all() as UserRow[];
  const done: { decisionId: string; version: number; recipients: number[] }[] = [];
  for (const card of waitingCards(db, day)) {
    const since = sqliteMs(card.waiting_since);
    const waited = businessMsBetween(since, now);
    if (!Number.isFinite(since) || waited <= ESCALATE_AFTER_MS) continue;
    const recipients = new Map<number, { user: UserRow; roles: string[] }>();
    const assignee = db.prepare("SELECT * FROM users WHERE id=? AND status='active'").get(card.assignee_id) as UserRow | undefined;
    if (assignee) recipients.set(assignee.id, { user: assignee, roles: ['assignee'] });
    for (const o of owners()) {
      const r = recipients.get(o.id);
      if (r) r.roles.push('owner'); else recipients.set(o.id, { user: o, roles: ['owner'] });
    }
    const minutes = Math.floor(waited / 60_000);
    const result = db.transaction(() => {
      const id = crypto.randomUUID();
      const claimed = db.prepare(`INSERT OR IGNORE INTO bot_decision_escalations(id,decision_id,decision_version,business_day,waiting_since,business_minutes,recipients_json)
        VALUES(?,?,?,?,?,?,?)`).run(id, card.id, card.version, day, card.waiting_since, minutes, JSON.stringify([...recipients.keys()]));
      if (!claimed.changes) return null;
      const key = `escalation:${card.id}:${card.version}:${day}`;
      const outcomes = [...recipients.values()].map(({ user, roles }) => {
        let pushes = 0; let ring: RingOutcome;
        try { pushes = adapters.notify(user, card, key, now); } catch { pushes = -1; }
        try { ring = adapters.ring(user, card, now); } catch { ring = 'error'; }
        return { user_id: user.id, roles, pushes, ring };
      });
      const queued = outcomes.reduce((n, o) => n + Math.max(0, o.pushes), 0);
      const rearmed = outcomes.filter(o => o.ring === 'rearmed' || o.ring === 'due').length;
      db.prepare('UPDATE bot_decision_escalations SET notifications_queued=?,rings_rearmed=?,outcome_json=? WHERE id=?').run(queued, rearmed, JSON.stringify(outcomes), id);
      return { outcomes, queued };
    })();
    if (!result) continue;
    // Ids, counts and outcome categories only: never question, customer or proposal text.
    log(`[decision-escalation] decision=${card.id} version=${card.version} day=${day} waited_business_minutes=${minutes} ` +
      `recipients=${result.outcomes.map(o => `${o.user_id}:${o.roles.join('+')}:push=${o.pushes}:ring=${o.ring}`).join(',') || 'none'} pushes=${result.queued}`);
    done.push({ decisionId: card.id, version: card.version, recipients: [...recipients.keys()] });
  }
  return done;
}
