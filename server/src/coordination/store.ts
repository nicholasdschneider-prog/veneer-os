import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import type { ConversationRow } from '../db/db.js';

export interface CoordinationLane {
  conversation_id: string;
  thread_id: string;
  owner_id: string;
}
export interface CoordinationThread {
  id: string;
  left_id: string;
  right_id: string;
}
export function coordinationLane(
  db: Database.Database,
  id: string,
): CoordinationLane | undefined {
  return db
    .prepare('SELECT * FROM coordination_lanes WHERE conversation_id=?')
    .get(id) as CoordinationLane | undefined;
}
export function coordinationOwner(db: Database.Database, id: string): string {
  return coordinationLane(db, id)?.owner_id ?? id;
}
export function coordinationFamily(
  db: Database.Database,
  id: string,
): string[] {
  const owner = coordinationOwner(db, id);
  return [
    owner,
    ...(
      db
        .prepare(
          'SELECT conversation_id FROM coordination_lanes WHERE owner_id=? ORDER BY rowid',
        )
        .all(owner) as CoordinationLane[]
    ).map((r) => r.conversation_id),
  ];
}

/** Only called after both canonical conversations pass current send/view checks.
 * Workers are internal execution records, never new bot registrations or grants. */
export function ensureCoordination(
  db: Database.Database,
  source: ConversationRow,
  target: ConversationRow,
): { thread: CoordinationThread; lane: CoordinationLane } {
  if (
    source.id === target.id ||
    coordinationLane(db, source.id) ||
    coordinationLane(db, target.id)
  )
    throw new Error('Expected distinct original conversations');
  return db.transaction(() => {
    const [left, right] = [source.id, target.id].sort();
    db.prepare(
      'INSERT OR IGNORE INTO coordination_threads(id,left_id,right_id) VALUES(?,?,?)',
    ).run(crypto.randomUUID(), left, right);
    const thread = db
      .prepare(
        'SELECT * FROM coordination_threads WHERE left_id=? AND right_id=?',
      )
      .get(left, right) as CoordinationThread;
    let lane = db
      .prepare(
        'SELECT * FROM coordination_lanes WHERE thread_id=? AND owner_id=?',
      )
      .get(thread.id, target.id) as CoordinationLane | undefined;
    if (!lane) {
      const id = crypto.randomUUID();
      db.prepare(
        `INSERT INTO conversations(id,assistant_id,user_id,visibility,business_team_id,project_id,title,title_auto,provider,model,effort,approval_mode,native_session_id,channel,side_chat_of,instruction_snapshot_json,instruction_snapshot_at)
        VALUES(?,?,?,?,?,?,?,0,?,?,?,?,?,'web',?,?,?)`,
      ).run(
        id,
        target.assistant_id,
        target.user_id,
        'private',
        target.business_team_id ?? null,
        target.project_id,
        'Bot coordination',
        target.provider,
        target.model,
        target.effort,
        target.approval_mode,
        crypto.randomUUID(),
        target.id,
        target.instruction_snapshot_json,
        target.instruction_snapshot_at,
      );
      db.prepare(
        'INSERT INTO coordination_lanes(conversation_id,thread_id,owner_id) VALUES(?,?,?)',
      ).run(id, thread.id, target.id);
      lane = { conversation_id: id, thread_id: thread.id, owner_id: target.id };
    }
    return { thread, lane };
  })();
}
