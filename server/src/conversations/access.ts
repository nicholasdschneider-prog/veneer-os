import { isEmployee } from '../bots/employeeAccess.js';
import type Database from 'better-sqlite3';
import type { ConversationRow, UserRow } from '../db/db.js';
type AccessRow = Pick<ConversationRow, 'user_id' | 'visibility'> &
  Partial<Pick<ConversationRow, 'id' | 'business_team_id'>>;

export function businessScopeSql(userId: number, alias = 'c'): string {
  if (!Number.isSafeInteger(userId)) return '0';
  return `(NOT EXISTS (SELECT 1 FROM team_room_workers rw WHERE rw.conversation_id=${alias}.id) AND (NOT EXISTS (SELECT 1 FROM employee_workspaces ew WHERE ew.user_id=${userId}) OR EXISTS (SELECT 1 FROM employee_bot_access ea WHERE ea.user_id=${userId} AND ea.conversation_id=${alias}.id)) AND (${alias}.business_team_id IS NULL OR EXISTS (SELECT 1 FROM business_teams bt WHERE bt.id=${alias}.business_team_id AND (bt.owner_id=${userId} OR EXISTS (SELECT 1 FROM business_team_members bm WHERE bm.team_id=bt.id AND bm.user_id=${userId})))))`;
}
export function businessAgentSql(
  db: Database.Database,
  sourceId: string | undefined,
  alias = 'c',
): string {
  if (!sourceId) return '1';
  const source = db
    .prepare('SELECT business_team_id FROM conversations WHERE id=?')
    .get(sourceId) as { business_team_id: string | null } | undefined;
  return source?.business_team_id
    ? `(${alias}.business_team_id IS NULL OR ${alias}.business_team_id='${source.business_team_id.replaceAll("'", "''")}')`
    : '1';
}
export function sameBusiness(
  db: Database.Database,
  sourceId: string | undefined,
  target: AccessRow,
): boolean {
  if (!sourceId || !target.business_team_id) return true;
  const source = db
    .prepare('SELECT business_team_id FROM conversations WHERE id=?')
    .get(sourceId) as { business_team_id: string | null } | undefined;
  return !source?.business_team_id || source.business_team_id === target.business_team_id;
}
function businessRole(
  user: Pick<UserRow, 'id'>,
  c: AccessRow,
  db?: Database.Database,
): string | null {
  if (!c.business_team_id) return 'legacy';
  if (!db) return null; // Missing context must fail closed for business-scoped chats.
  const team = db
    .prepare('SELECT owner_id FROM business_teams WHERE id=?')
    .get(c.business_team_id) as { owner_id: number } | undefined;
  if (team?.owner_id === user.id) return 'owner';
  return (
    (
      db
        .prepare('SELECT role FROM business_team_members WHERE team_id=? AND user_id=?')
        .get(c.business_team_id, user.id) as { role: string } | undefined
    )?.role ?? null
  );
}
export function canViewConversation(
  user: Pick<UserRow, 'id'>,
  c: AccessRow,
  db?: Database.Database,
): boolean {
  if (db) {
    if (c.id && db.prepare('SELECT 1 FROM team_room_workers WHERE conversation_id=?').get(c.id)) return false;
    const active = db.prepare('SELECT status FROM users WHERE id=?').get(user.id) as { status: string } | undefined;
    if (active?.status !== 'active') return false;
    if (isEmployee(db, user.id) && (!c.id || !db.prepare('SELECT 1 FROM employee_bot_access WHERE user_id=? AND conversation_id=?').get(user.id, c.id))) return false;
  }
  return (c.visibility === 'team' || c.user_id === user.id) && businessRole(user, c, db) !== null;
}
export function canSendToConversation(
  user: Pick<UserRow, 'id'>,
  c: AccessRow,
  db?: Database.Database,
): boolean {
  return canViewConversation(user, c, db) && businessRole(user, c, db) !== 'viewer';
}
export function canManageConversation(
  user: Pick<UserRow, 'id'>,
  c: AccessRow,
  db?: Database.Database,
): boolean {
  if (db && isEmployee(db, user.id)) return false;
  return (
    canViewConversation(user, c, db) &&
    ['legacy', 'owner', 'manager'].includes(businessRole(user, c, db) ?? '')
  );
}
export function canChangeConversationVisibility(user: Pick<UserRow, 'id'>, c: AccessRow): boolean {
  return c.user_id === user.id;
}

/** Training and queued project work in a shared business bot, without granting chat administration. */
export function canTrainBusinessBot(
  user: Pick<UserRow, 'id'>,
  c: AccessRow & { project_id?: string | null },
  db: Database.Database,
): boolean {
  return Boolean(c.id && c.project_id && c.business_team_id && !isEmployee(db, user.id)
    && canSendToConversation(user, c, db)
    && db.prepare(`SELECT 1 FROM bot_registrations r
      JOIN business_bot_members m ON m.conversation_id=r.conversation_id
      WHERE r.conversation_id=? AND r.active=1 AND m.team_id=?`).get(c.id, c.business_team_id));
}
