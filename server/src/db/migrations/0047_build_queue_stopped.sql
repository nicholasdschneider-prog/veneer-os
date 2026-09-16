-- A user Stop is an intentional pause, not a provider failure. Rebuild the
-- table to extend its original CHECK constraint with the explicit state.
DROP INDEX idx_build_queue_fifo;
DROP INDEX idx_build_queue_conversation;
DROP INDEX idx_build_queue_one_active_conversation;
DROP INDEX idx_build_queue_one_running_scope;

ALTER TABLE build_queue RENAME TO build_queue_before_stopped;

CREATE TABLE build_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  brief TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','running','done','failed','stopped','skipped')),
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT,
  finished_at TEXT,
  scope_key TEXT NOT NULL DEFAULT 'source'
);

INSERT INTO build_queue (
  id, user_id, conversation_id, title, brief, status, error,
  created_at, started_at, finished_at, scope_key
)
SELECT
  id, user_id, conversation_id, title, brief, status, error,
  created_at, started_at, finished_at, scope_key
FROM build_queue_before_stopped;

DROP TABLE build_queue_before_stopped;

CREATE INDEX idx_build_queue_fifo ON build_queue(scope_key, status, id);
CREATE INDEX idx_build_queue_conversation ON build_queue(conversation_id, id DESC);
CREATE UNIQUE INDEX idx_build_queue_one_active_conversation
ON build_queue(conversation_id)
WHERE status IN ('queued', 'running', 'failed', 'stopped');
CREATE UNIQUE INDEX idx_build_queue_one_running_scope
ON build_queue(scope_key)
WHERE status = 'running';
