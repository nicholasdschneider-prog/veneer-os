CREATE TABLE voice_sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
  started_ms INTEGER NOT NULL,
  connected_ms INTEGER,
  last_seen_ms INTEGER NOT NULL,
  ended_ms INTEGER,
  outcome TEXT NOT NULL DEFAULT 'active' CHECK(outcome IN ('active','ended','interrupted','failed'))
);
CREATE INDEX voice_sessions_chat ON voice_sessions(user_id, conversation_id, started_ms);
CREATE INDEX voice_entries_session ON voice_entries(user_id, session_id, id);
