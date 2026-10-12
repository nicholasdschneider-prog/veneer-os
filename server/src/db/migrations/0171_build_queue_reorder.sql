-- Queued builds can be reordered by the owner (UI) or James (API). sort_key
-- replaces id as the dispatch order within a scope; it starts equal to id so
-- existing queues keep their FIFO order, and the trigger keeps every insert
-- path correct without touching the coordinator's INSERT.
ALTER TABLE build_queue ADD COLUMN sort_key REAL;
UPDATE build_queue SET sort_key = id WHERE sort_key IS NULL;
CREATE TRIGGER build_queue_default_sort_key AFTER INSERT ON build_queue
WHEN NEW.sort_key IS NULL
BEGIN
  UPDATE build_queue SET sort_key = NEW.id WHERE id = NEW.id;
END;
CREATE INDEX idx_build_queue_order ON build_queue(scope_key, status, sort_key);

-- Immutable log of every reorder: who moved which build, from where to where.
CREATE TABLE build_queue_reorders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES build_queue(id),
  scope_key TEXT NOT NULL,
  actor_user_id INTEGER REFERENCES users(id),
  actor_label TEXT NOT NULL,
  via TEXT NOT NULL CHECK (via IN ('ui','james_api','agent')),
  old_position INTEGER NOT NULL,
  new_position INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_build_queue_reorders_recent ON build_queue_reorders(scope_key, id DESC);
CREATE TRIGGER build_queue_reorders_no_update BEFORE UPDATE ON build_queue_reorders BEGIN SELECT RAISE(ABORT,'Immutable reorder log'); END;
CREATE TRIGGER build_queue_reorders_no_delete BEFORE DELETE ON build_queue_reorders BEGIN SELECT RAISE(ABORT,'Immutable reorder log'); END;
