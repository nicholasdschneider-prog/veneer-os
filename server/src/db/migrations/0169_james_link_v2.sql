-- James link v2: idempotent POSTs, and a per-thread marker for the one turn
-- that answers James in a chat he does not follow (a bot's standing chat).

CREATE TABLE james_idempotency (
  key TEXT PRIMARY KEY,
  route TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status INTEGER NOT NULL DEFAULT 0,
  response_json TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX james_idempotency_created ON james_idempotency(created_at);

-- Set when James posts; the turn that starts with his marked message is the
-- answer, and its reply is pushed even when the thread is unfollowed.
ALTER TABLE james_threads ADD COLUMN james_pending_since TEXT;
ALTER TABLE james_threads ADD COLUMN james_answer_turn_id TEXT;
