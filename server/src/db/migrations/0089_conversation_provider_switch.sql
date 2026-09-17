CREATE TABLE conversation_provider_context (
  conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  history_json TEXT NOT NULL,
  files_json TEXT NOT NULL,
  handoff TEXT NOT NULL,
  pending INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

ALTER TABLE conversations ADD COLUMN last_answered_provider TEXT;
ALTER TABLE conversations ADD COLUMN last_answered_model TEXT;
