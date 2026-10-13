-- James link: a bot may tell James something once when its own human directs
-- it (notify_james). The push reason gains 'notify'; SQLite cannot alter a
-- CHECK, so james_push_events is rebuilt with its rows and index.
CREATE TABLE james_push_events_v2 (
  id INTEGER PRIMARY KEY,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
  reason TEXT NOT NULL CHECK (reason IN ('reply', 'question_unanswered', 'quiet', 'heartbeat', 'status_changed', 'test', 'notify')),
  turn INTEGER,
  detail_json TEXT NOT NULL DEFAULT '{}',
  -- james_pushes.id once batched; 0 when the thread vanished before sending.
  push_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
INSERT INTO james_push_events_v2 (id, conversation_id, reason, turn, detail_json, push_id, created_at)
SELECT id, conversation_id, reason, turn, detail_json, push_id, created_at FROM james_push_events;
DROP INDEX james_push_events_pending;
DROP TABLE james_push_events;
ALTER TABLE james_push_events_v2 RENAME TO james_push_events;
CREATE INDEX james_push_events_pending ON james_push_events(push_id, conversation_id);

-- One row per notify_james idempotency key; the push and ledger turn it produced.
CREATE TABLE james_notifications (
  idempotency_key TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  text_hash TEXT NOT NULL,
  authority_turn INTEGER NOT NULL,
  ledger_turn INTEGER,
  push_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
