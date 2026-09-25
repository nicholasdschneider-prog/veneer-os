import type Database from 'better-sqlite3';
import type { RequestHandler } from 'express';
import type { ConversationRow, UserRow } from '../db/db.js';
import { canViewConversation } from '../conversations/access.js';
import { describeSchedule, parseScheduleSpec } from '../scheduled/schedule.js';

export function isFocusedMember(db: Database.Database, userId: number): boolean {
  return Boolean(db.prepare('SELECT 1 FROM focused_workspaces WHERE user_id=?').get(userId));
}

/** Focus trims what a human browses. A bot turn acting for that human (agent
 * token or coordination lane) keeps the ordinary business reach, so assigned
 * bots can still find, message and coordinate with the rest of the team. */
export type FocusActor = Pick<UserRow, 'id'> & { botSession?: boolean };
export function focusApplies(db: Database.Database, user: FocusActor): boolean {
  return !user.botSession && isFocusedMember(db, user.id);
}

// This scope complements existing membership and visibility checks; it never grants access.
export function focusedScopeSql(actor: number | FocusActor, alias = 'c'): string {
  const userId = typeof actor === 'number' ? actor : actor.id;
  if (!Number.isSafeInteger(userId)) return '0';
  if (typeof actor !== 'number' && actor.botSession) return '1';
  return `(NOT EXISTS (SELECT 1 FROM focused_workspaces fw WHERE fw.user_id=${userId}) OR EXISTS (
    SELECT 1 FROM focused_bot_access fa JOIN focused_workspaces fw ON fw.user_id=fa.user_id
    JOIN business_bot_members bm ON bm.conversation_id=fa.conversation_id AND bm.team_id=fw.team_id
    JOIN bot_registrations br ON br.conversation_id=bm.conversation_id AND br.active=1
    WHERE fa.user_id=${userId} AND fa.conversation_id=${alias}.id AND ${alias}.business_team_id=fw.team_id AND ${alias}.archived=0))`;
}

export function focusedAutomations(db: Database.Database, user: UserRow) {
  const rows = db.prepare(`SELECT r.id, r.name, r.kind, r.schedule_json, r.timezone, r.enabled, r.next_run_at,
    r.conversation_id, b.name AS bot_name FROM bot_routines r
    JOIN bot_registrations b ON b.conversation_id=r.conversation_id AND b.active=1
    JOIN conversations c ON c.id=r.conversation_id WHERE c.archived=0 ORDER BY b.name,r.name`).all() as {
      id: string; name: string; kind: string; schedule_json: string | null; timezone: string;
      enabled: number; next_run_at: string | null; conversation_id: string; bot_name: string;
    }[];
  return rows.filter(row => canViewConversation(user, db.prepare('SELECT * FROM conversations WHERE id=?').get(row.conversation_id) as ConversationRow, db))
    .map(row => ({ id: row.id, name: row.name, botId: row.conversation_id, botName: row.bot_name,
      enabled: row.enabled === 1, nextRunAt: row.next_run_at, timezone: row.timezone,
      schedule: row.kind === 'schedule' && row.schedule_json ? describeSchedule(parseScheduleSpec(row.schedule_json), row.timezone)
        : row.kind === 'ticket.created' ? 'When a ticket arrives' : 'When a customer replies',
    }));
}

// The focused automation screen reads assigned bot routines. The general scheduler
// remains unavailable to this human UI; native bot execution retains its existing gates.
export function focusedApiBoundary(db: Database.Database): RequestHandler {
  return (req, res, next) => {
    if (!req.agentConversationId && isFocusedMember(db, req.user!.id) &&
      (/^\/scheduled-tasks(?:\/|$)/.test(req.path) || (req.method === 'POST' && /^\/conversations\/?$/.test(req.path)))) {
      res.status(403).json({ error: 'Use your assigned bots and their automations.' });
      return;
    }
    next();
  };
}
