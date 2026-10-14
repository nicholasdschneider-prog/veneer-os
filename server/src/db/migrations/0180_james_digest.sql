-- James link usage reduction: only actionable thread events are POSTed; the
-- rest are recorded as suppressed. A push whose webhook POST fails is held as
-- deferred_digest for the one 8:30 AM ET daily digest email instead of an
-- email per push. SQLite cannot alter a CHECK, so james_pushes is rebuilt
-- with its rows and index.
CREATE TABLE james_pushes_v2 (
  id INTEGER PRIMARY KEY,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (kind IN ('thread', 'heartbeat', 'escalation')),
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('sending', 'sent', 'emailed', 'failed', 'deferred_digest')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  emailed_to TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  finished_at TEXT,
  -- ET date of the daily digest email that carried this push.
  digest_date TEXT
);
INSERT INTO james_pushes_v2 (id, conversation_id, kind, payload_json, status, attempts, last_error, emailed_to, created_at, finished_at)
SELECT id, conversation_id, kind, payload_json, status, attempts, last_error, emailed_to, created_at, finished_at FROM james_pushes;
DROP INDEX james_pushes_thread;
DROP TABLE james_pushes;
ALTER TABLE james_pushes_v2 RENAME TO james_pushes;
CREATE INDEX james_pushes_thread ON james_pushes(conversation_id, created_at);
CREATE INDEX james_pushes_deferred ON james_pushes(status) WHERE status = 'deferred_digest';

-- 'suppressed': recorded for the digest but never POSTed (push_id is 0).
ALTER TABLE james_push_events ADD COLUMN disposition TEXT CHECK (disposition IS NULL OR disposition = 'suppressed');
CREATE INDEX james_push_events_suppressed ON james_push_events(created_at) WHERE disposition = 'suppressed';
