-- Add a third todo state, 'done' (archived). A fired-off todo can now leave the
-- Active column without being destroyed — either manually or automatically when
-- its linked chat is archived. SQLite can't ALTER a CHECK constraint, so rebuild
-- the table per the recommended pattern (the migration runner disables FK
-- enforcement around each file, so todo_links survives the DROP).
CREATE TABLE todos_new (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  category_id TEXT REFERENCES todo_categories(id) ON DELETE SET NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','active','done')),
  conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  sort_order REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO todos_new (id, title, notes, category_id, state, conversation_id, sort_order, created_at, updated_at)
  SELECT id, title, notes, category_id, state, conversation_id, sort_order, created_at, updated_at FROM todos;

DROP TABLE todos;
ALTER TABLE todos_new RENAME TO todos;

CREATE INDEX idx_todos_category ON todos(category_id);
CREATE INDEX idx_todos_conversation ON todos(conversation_id);
