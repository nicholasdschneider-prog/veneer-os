-- Durable, provider-neutral structured questions. Provider request ids never
-- enter this table: request_id is minted by Veneer and is safe to send to the
-- browser, while native response handles remain in the live adapter only.

CREATE TABLE questions (
  request_id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  turn_id TEXT NOT NULL,
  response_mode TEXT NOT NULL CHECK (response_mode IN ('poll','provider')),
  questions_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','answered','expired','dismissed')),
  answers_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT
);

CREATE INDEX idx_questions_pending
  ON questions(status) WHERE status = 'pending';
CREATE INDEX idx_questions_conversation
  ON questions(conversation_id, created_at, request_id);
