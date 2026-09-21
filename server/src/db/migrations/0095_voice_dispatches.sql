-- A pending receipt is deliberately not retried after an uncertain delivery.
CREATE TABLE voice_dispatches (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  instruction_id TEXT NOT NULL,
  text TEXT NOT NULL,
  result_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(user_id, conversation_id, instruction_id)
);
