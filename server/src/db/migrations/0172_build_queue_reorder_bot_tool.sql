-- Bots may reorder a waiting build in their own workspace on explicit human
-- direction (move_build_queue). The log gains via 'bot_tool' and the
-- authority note naming that direction. SQLite cannot alter a CHECK, so the
-- table is rebuilt; the immutability triggers block UPDATE/DELETE, not DROP.
CREATE TABLE build_queue_reorders_v2 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES build_queue(id),
  scope_key TEXT NOT NULL,
  actor_user_id INTEGER REFERENCES users(id),
  actor_label TEXT NOT NULL,
  via TEXT NOT NULL CHECK (via IN ('ui','james_api','agent','bot_tool')),
  old_position INTEGER NOT NULL,
  new_position INTEGER NOT NULL,
  authority_note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO build_queue_reorders_v2 (id, job_id, scope_key, actor_user_id, actor_label, via, old_position, new_position, created_at)
SELECT id, job_id, scope_key, actor_user_id, actor_label, via, old_position, new_position, created_at FROM build_queue_reorders;
DROP TRIGGER build_queue_reorders_no_update;
DROP TRIGGER build_queue_reorders_no_delete;
DROP INDEX idx_build_queue_reorders_recent;
DROP TABLE build_queue_reorders;
ALTER TABLE build_queue_reorders_v2 RENAME TO build_queue_reorders;
CREATE INDEX idx_build_queue_reorders_recent ON build_queue_reorders(scope_key, id DESC);
CREATE TRIGGER build_queue_reorders_no_update BEFORE UPDATE ON build_queue_reorders BEGIN SELECT RAISE(ABORT,'Immutable reorder log'); END;
CREATE TRIGGER build_queue_reorders_no_delete BEFORE DELETE ON build_queue_reorders BEGIN SELECT RAISE(ABORT,'Immutable reorder log'); END;
