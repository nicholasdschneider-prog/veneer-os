CREATE TABLE browser_controller_recovery (
  id INTEGER PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  actor_user_id INTEGER NOT NULL,
  clone_id TEXT NOT NULL,
  source_profile_id TEXT NOT NULL,
  source_generation INTEGER NOT NULL,
  runtime_id TEXT NOT NULL,
  process_generation TEXT NOT NULL,
  request_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('started','detached','unknown','read_verified')),
  earlier_operation TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK(earlier_operation='UNKNOWN'),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(conversation_id,request_key,outcome)
);
CREATE TRIGGER browser_controller_recovery_no_update BEFORE UPDATE ON browser_controller_recovery BEGIN SELECT RAISE(ABORT,'Recovery audit is immutable'); END;
CREATE TRIGGER browser_controller_recovery_no_delete BEFORE DELETE ON browser_controller_recovery BEGIN SELECT RAISE(ABORT,'Recovery audit is immutable'); END;
