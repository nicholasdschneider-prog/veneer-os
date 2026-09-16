-- OpenRouter as a first-class provider (2026-07-20). It runs through the
-- Claude Code harness with isolated credentials/session storage. SQLite CHECK
-- constraints cannot be widened in place, so preserve the current complete
-- conversations shape while rebuilding the table.
CREATE TABLE conversations_new (
  id TEXT PRIMARY KEY,
  assistant_id INTEGER NOT NULL REFERENCES assistants(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT,
  title_auto INTEGER NOT NULL DEFAULT 1,
  provider TEXT NOT NULL CHECK (provider IN ('claude','openrouter','codex','codex-app-server')),
  model TEXT,
  effort TEXT,
  native_session_id TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'web' CHECK (channel IN ('web','email','automation')),
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_active_at TEXT NOT NULL DEFAULT (datetime('now')),
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  last_input_tokens INTEGER,
  files_synced_at TEXT,
  pin_order INTEGER
);

INSERT INTO conversations_new
  (id, assistant_id, user_id, title, title_auto, provider, model, effort,
   native_session_id, channel, archived, created_at, last_active_at, project_id,
   last_input_tokens, files_synced_at, pin_order)
SELECT
  id, assistant_id, user_id, title, title_auto, provider, model, effort,
  native_session_id, channel, archived, created_at, last_active_at, project_id,
  last_input_tokens, files_synced_at, pin_order
FROM conversations;

DROP TABLE conversations;
ALTER TABLE conversations_new RENAME TO conversations;
CREATE INDEX idx_conversations_user ON conversations(user_id, archived, last_active_at DESC);
CREATE INDEX idx_conversations_project ON conversations(project_id, last_active_at DESC);
