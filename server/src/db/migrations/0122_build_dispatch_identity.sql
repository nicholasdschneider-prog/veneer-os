ALTER TABLE build_queue ADD COLUMN dispatch_id TEXT;
CREATE TABLE build_dispatches (
 id TEXT PRIMARY KEY, job_id INTEGER NOT NULL REFERENCES build_queue(id), conversation_id TEXT NOT NULL,
 current_turn_id TEXT, current_origin_id INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE build_dispatch_audit (
 id INTEGER PRIMARY KEY AUTOINCREMENT, job_id INTEGER NOT NULL REFERENCES build_queue(id), dispatch_id TEXT,
 kind TEXT NOT NULL, turn_id TEXT, payload_json TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE build_recoveries (
 request_key TEXT PRIMARY KEY, job_id INTEGER NOT NULL REFERENCES build_queue(id), actor_id INTEGER NOT NULL REFERENCES users(id),
 origin_id INTEGER NOT NULL, turn_id TEXT NOT NULL, previous_json TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TRIGGER build_dispatch_audit_no_update BEFORE UPDATE ON build_dispatch_audit BEGIN SELECT RAISE(ABORT,'Immutable build audit'); END;
CREATE TRIGGER build_dispatch_audit_no_delete BEFORE DELETE ON build_dispatch_audit BEGIN SELECT RAISE(ABORT,'Immutable build audit'); END;
CREATE TRIGGER build_recovery_no_update BEFORE UPDATE ON build_recoveries BEGIN SELECT RAISE(ABORT,'Immutable recovery'); END;
CREATE TRIGGER build_recovery_no_delete BEFORE DELETE ON build_recoveries BEGIN SELECT RAISE(ABORT,'Immutable recovery'); END;
