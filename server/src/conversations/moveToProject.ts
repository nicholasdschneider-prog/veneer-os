import type Database from 'better-sqlite3';

/**
 * Reassign a chat and its side chats to another project (null = unfiled).
 * Generated files follow the chat. The fixed instruction snapshot and the
 * provider instruction hash are cleared so the next turn re-freezes the new
 * project's instructions and re-sends them; the working folder is resolved
 * from the row each turn, so it moves on its own. Browser profile bindings
 * are project-scoped and are dropped (stop the chat's browser first).
 */
export function moveConversationToProject(database: Database.Database, conversationId: string, projectId: string | null): void {
  const sideChats = database
    .prepare('SELECT id FROM conversations WHERE side_chat_of = ?')
    .all(conversationId) as { id: string }[];
  const ids = [conversationId, ...sideChats.map((chat) => chat.id)];
  database.transaction(() => {
    const update = database.prepare(
      `UPDATE conversations
          SET project_id = ?, instruction_snapshot_json = NULL, instruction_snapshot_at = NULL,
              provider_instruction_hash = NULL
        WHERE id = ?`,
    );
    const moveFiles = database.prepare('UPDATE generated_files SET project_id = ? WHERE conversation_id = ?');
    const dropProfile = database.prepare('DELETE FROM veneer_browser_conversation_profiles WHERE conversation_id = ?');
    for (const id of ids) {
      update.run(projectId, id);
      moveFiles.run(projectId, id);
      dropProfile.run(id);
    }
  })();
}
