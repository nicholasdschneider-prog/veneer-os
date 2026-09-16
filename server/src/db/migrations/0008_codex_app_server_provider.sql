-- Add 'codex-app-server' as a third provider (2026-07-05) — an alternate
-- adapter over Codex's `app-server` JSON-RPC protocol instead of `exec`,
-- built to compare against the `codex` (exec-based) provider: real approval
-- prompts and token-level text streaming. SQLite CHECK constraints can't be
-- altered in place, so the table is rebuilt with the widened constraint.

CREATE TABLE conversations_new (
  id TEXT PRIMARY KEY,
  assistant_id INTEGER NOT NULL REFERENCES assistants(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT,
  title_auto INTEGER NOT NULL DEFAULT 1,
  provider TEXT NOT NULL CHECK (provider IN ('claude','codex','codex-app-server')),
  model TEXT,
  effort TEXT,
  native_session_id TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'web' CHECK (channel IN ('web','email','automation')),
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_active_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO conversations_new
  (id, assistant_id, user_id, title, title_auto, provider, model, effort, native_session_id, channel, archived, created_at, last_active_at)
SELECT
  id, assistant_id, user_id, title, title_auto, provider, model, effort, native_session_id, channel, archived, created_at, last_active_at
FROM conversations;

DROP TABLE conversations;
ALTER TABLE conversations_new RENAME TO conversations;
CREATE INDEX idx_conversations_user ON conversations(user_id, archived, last_active_at DESC);
