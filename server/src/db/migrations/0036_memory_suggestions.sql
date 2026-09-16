-- Medium-confidence memories wait for a human decision instead of silently
-- entering the prompt context. High-confidence memories go straight to
-- Supermemory and therefore do not need a local queue row.
CREATE TABLE memory_suggestions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK (scope IN ('profile','global','project')),
  kind TEXT NOT NULL CHECK (kind IN ('identity','preference','fact','decision')),
  content TEXT NOT NULL,
  evidence TEXT NOT NULL,
  is_static INTEGER NOT NULL DEFAULT 0 CHECK (is_static IN (0,1)),
  status TEXT NOT NULL DEFAULT 'suggested' CHECK (status IN ('suggested','approved','dismissed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT
);

CREATE INDEX idx_memory_suggestions_user_status
  ON memory_suggestions(user_id, status, created_at DESC);
