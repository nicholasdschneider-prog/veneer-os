-- An UNKNOWN controller recovery resolved by its original owner after the
-- Chrome process it ran against was replaced and the controller was confirmed
-- gone. The earlier operation stays UNKNOWN; nothing is replayed. Kept apart
-- from browser_controller_recovery_resolution so that immutable audit table is
-- never rebuilt.
CREATE TABLE browser_controller_recovery_process_replaced (
  id INTEGER PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  actor_user_id INTEGER NOT NULL,
  clone_id TEXT NOT NULL,
  original_request_key TEXT NOT NULL,
  resolving_request_key TEXT NOT NULL,
  original_process_generation TEXT NOT NULL,
  current_process_generation TEXT NOT NULL CHECK(current_process_generation<>original_process_generation),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(conversation_id,original_request_key)
);
CREATE TRIGGER browser_controller_recovery_process_replaced_no_update BEFORE UPDATE ON browser_controller_recovery_process_replaced BEGIN SELECT RAISE(ABORT,'Recovery audit is immutable'); END;
CREATE TRIGGER browser_controller_recovery_process_replaced_no_delete BEFORE DELETE ON browser_controller_recovery_process_replaced BEGIN SELECT RAISE(ABORT,'Recovery audit is immutable'); END;
