import { canViewConversation } from './access.js';
import type Database from 'better-sqlite3';
import type { ConversationRow } from '../db/db.js';

type ConversationUnreadRow = Pick<ConversationRow, 'id' | 'user_id' | 'visibility'>;

export function isUnread(db: Database.Database, userId: number, conversationId: string): boolean {
  const row = db
    .prepare('SELECT unread FROM conversation_last_seen WHERE user_id = ? AND conversation_id = ?')
    .get(userId, conversationId) as { unread: number } | undefined;
  return row?.unread === 1;
}

export function markSeen(db: Database.Database, userId: number, conversationId: string): void {
  db.prepare(
    `INSERT INTO conversation_last_seen (user_id, conversation_id, last_seen_at, unread)
     VALUES (?, ?, datetime('now'), 0)
     ON CONFLICT(user_id, conversation_id) DO UPDATE SET
       last_seen_at = datetime('now'),
       unread = 0`,
  ).run(userId, conversationId);
}

function eligibleUserIds(db: Database.Database, conversation: ConversationUnreadRow): number[] {
  if (conversation.visibility === 'private') return [conversation.user_id];
  const current = db.prepare('SELECT * FROM conversations WHERE id=?').get(conversation.id) as ConversationRow | undefined;
  return (db.prepare("SELECT id FROM users WHERE status = 'active'").all() as { id: number }[])
    .filter(user => canViewConversation(user, current ?? conversation, db)).map(user => user.id);
}

/** After an assistant turn ends: viewers stay seen, everyone else who can see the chat is unread. */
export function markTurnFinished(
  db: Database.Database,
  conversation: ConversationUnreadRow,
  viewerUserIds: Iterable<number>,
): void {
  if (db.prepare('SELECT 1 FROM coordination_lanes WHERE conversation_id=?').get(conversation.id)) return;
  const viewers = new Set(viewerUserIds);
  const markUnread = db.prepare(
    `INSERT INTO conversation_last_seen (user_id, conversation_id, unread)
     VALUES (?, ?, 1)
     ON CONFLICT(user_id, conversation_id) DO UPDATE SET unread = 1`,
  );
  const tx = db.transaction(() => {
    for (const userId of eligibleUserIds(db, conversation)) {
      if (viewers.has(userId)) markSeen(db, userId, conversation.id);
      else markUnread.run(userId, conversation.id);
    }
  });
  // Acquire the WAL write lock before eligibleUserIds() establishes a read
  // snapshot. Otherwise another Veneer Pro process can commit between that
  // SELECT and our first UPSERT, which SQLite reports as BUSY_SNAPSHOT without
  // consulting busy_timeout.
  tx.immediate();
}
