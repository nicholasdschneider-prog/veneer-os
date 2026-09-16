-- Per-user chat unread. Missing row means the viewer has never been marked
-- unread, so existing chats stay quiet after this ships. last_seen_at is
-- null until the human opens the chat; later turn completions set unread
-- again without clearing that timestamp.
CREATE TABLE conversation_last_seen (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  last_seen_at TEXT,
  unread INTEGER NOT NULL DEFAULT 0 CHECK (unread IN (0, 1)),
  PRIMARY KEY (user_id, conversation_id)
);

CREATE INDEX idx_conversation_last_seen_unread
  ON conversation_last_seen(user_id, unread) WHERE unread = 1;
