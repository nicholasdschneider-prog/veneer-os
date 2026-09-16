import type Database from 'better-sqlite3';

/**
 * A new prompt or build request makes an archived chat active again. Keep the
 * conversation and its linked todo in sync before work reaches the runner.
 */
export function createConversationReactivator(db: Database.Database): (conversationId: string) => boolean {
  const reactivateConversation = db.prepare(
    `UPDATE conversations
        SET archived = 0,
            last_active_at = datetime('now'),
            last_user_activity_at = datetime('now')
      WHERE id = ? AND archived = 1`,
  );
  const touchConversation = db.prepare(
    "UPDATE conversations SET last_user_activity_at = datetime('now') WHERE id = ?",
  );
  const reactivateTodo = db.prepare(
    `UPDATE todos SET state = 'active', updated_at = datetime('now')
     WHERE conversation_id = ? AND state = 'done'`,
  );
  const reactivate = db.transaction((conversationId: string) => {
    const result = reactivateConversation.run(conversationId);
    if (result.changes > 0) {
      reactivateTodo.run(conversationId);
    } else {
      touchConversation.run(conversationId);
    }
    return result.changes > 0;
  });
  return reactivate;
}
