-- References the complete immutable original request scope without reconstruction.
CREATE TABLE browser_unknown_inspection (
  id INTEGER PRIMARY KEY,
  recovery_id INTEGER NOT NULL REFERENCES browser_controller_recovery(id),
  actor_user_id INTEGER NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('started','observed','blocked')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TRIGGER browser_unknown_inspection_no_update BEFORE UPDATE ON browser_unknown_inspection BEGIN SELECT RAISE(ABORT,'Inspection audit is immutable'); END;
CREATE TRIGGER browser_unknown_inspection_no_delete BEFORE DELETE ON browser_unknown_inspection BEGIN SELECT RAISE(ABORT,'Inspection audit is immutable'); END;
