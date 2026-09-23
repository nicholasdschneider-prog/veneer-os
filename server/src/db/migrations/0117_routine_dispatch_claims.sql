CREATE TABLE routine_dispatch_claims (
 draft_id TEXT PRIMARY KEY REFERENCES routine_draft_claims(draft_id),
 request_key TEXT NOT NULL,
 binding_json TEXT NOT NULL,
 binding_hash TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TRIGGER routine_dispatch_immutable_update BEFORE UPDATE ON routine_dispatch_claims BEGIN SELECT RAISE(ABORT, 'Dispatch claim is immutable'); END;
CREATE TRIGGER routine_dispatch_immutable_delete BEFORE DELETE ON routine_dispatch_claims BEGIN SELECT RAISE(ABORT, 'Dispatch claim is immutable'); END;
