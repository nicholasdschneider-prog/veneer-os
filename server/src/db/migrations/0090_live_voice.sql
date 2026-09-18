-- Voice transcripts and decision receipts survive calls and service restarts.
CREATE TABLE voice_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('user','assistant','decision')),
  text TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_voice_entries_user ON voice_entries(user_id, id);
CREATE TABLE voice_decisions (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL REFERENCES questions(request_id) ON DELETE CASCADE,
  answers_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('sending','delivered','failed')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, request_id)
);
