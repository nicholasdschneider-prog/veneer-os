-- A decision helper is a hidden, read-only chat of a bot that answers a
-- human's question on one of that bot's decision cards while the bot's own
-- chat is busy. One helper per decision; it reuses the side_chat_of link so it
-- stays out of chat lists and is deleted with its bot's chat.
CREATE TABLE decision_helpers (
  conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  decision_id TEXT NOT NULL UNIQUE REFERENCES bot_decisions(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
