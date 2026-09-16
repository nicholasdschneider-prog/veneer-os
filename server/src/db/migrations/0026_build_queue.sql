-- One durable FIFO for Platform Dev work in the shared live source checkout.
-- A failed head pauses the queue until an admin retries or skips it.
CREATE TABLE build_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  brief TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','running','done','failed','skipped')),
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT,
  finished_at TEXT
);

CREATE INDEX idx_build_queue_fifo ON build_queue(status, id);
CREATE INDEX idx_build_queue_conversation ON build_queue(conversation_id, id DESC);
-- A partial unique index is the database-level mutex for the one shared checkout.
CREATE UNIQUE INDEX idx_build_queue_one_running ON build_queue(status) WHERE status = 'running';
