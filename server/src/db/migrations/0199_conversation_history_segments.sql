-- Frozen chat history in append-only pieces. Each provider switch or context
-- rotation adds one segment holding only the session that just ended, instead of
-- rewriting the chat's whole history (rows had reached 80 MB). An existing
-- conversation_provider_context.history_json stays as the oldest piece and is
-- never rewritten.
CREATE TABLE conversation_history_segments (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  events_json TEXT NOT NULL,
  event_count INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (conversation_id, seq)
);
CREATE INDEX idx_conversation_history_segments_created ON conversation_history_segments(conversation_id, created_at);
