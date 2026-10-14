-- close_chat: one row per chat a bot closed itself. The chat is archived, never
-- deleted; this keeps the final report, where it went, and the deployment
-- statement the bot made, so a repeat call returns the same result.
CREATE TABLE chat_closures (
  conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  actor_user_id INTEGER NOT NULL REFERENCES users(id),
  report TEXT NOT NULL,
  report_to TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  report_thread_id TEXT,
  deployment_json TEXT,
  closed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
