-- An UNKNOWN controller recovery resolved by its original owner once the
-- controller was confirmed gone on the unchanged Chrome process. The earlier
-- operation stays UNKNOWN; nothing is replayed.
CREATE TABLE browser_controller_recovery_resolution (
  id INTEGER PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  actor_user_id INTEGER NOT NULL,
  clone_id TEXT NOT NULL,
  original_request_key TEXT NOT NULL,
  resolving_request_key TEXT NOT NULL,
  reason TEXT NOT NULL CHECK(reason='controller_gone_same_process'),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(conversation_id,original_request_key)
);
CREATE TRIGGER browser_controller_recovery_resolution_no_update BEFORE UPDATE ON browser_controller_recovery_resolution BEGIN SELECT RAISE(ABORT,'Recovery audit is immutable'); END;
CREATE TRIGGER browser_controller_recovery_resolution_no_delete BEFORE DELETE ON browser_controller_recovery_resolution BEGIN SELECT RAISE(ABORT,'Recovery audit is immutable'); END;
