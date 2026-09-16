-- A pending todo may be assigned to the project its eventual chat should use.
-- Deleting that project returns the todo to the unfiled state.
ALTER TABLE todos
  ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE SET NULL;

-- Preserve the fixed project of chats that were fired off before this column
-- existed.
UPDATE todos
SET project_id = (
  SELECT conversations.project_id
  FROM conversations
  WHERE conversations.id = todos.conversation_id
)
WHERE conversation_id IS NOT NULL;

CREATE INDEX idx_todos_project ON todos(project_id);
