-- Policy enrollment is distinct from per-message human authorization.
CREATE TABLE bot_routine_policies (
 id TEXT PRIMARY KEY, business_id TEXT NOT NULL REFERENCES business_teams(id),
 policy_key TEXT NOT NULL, version INTEGER NOT NULL CHECK(version>0),
 issuer_id INTEGER NOT NULL REFERENCES users(id), request_key TEXT NOT NULL,
 snapshot_json TEXT NOT NULL, snapshot_hash TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT (datetime('now')),
 UNIQUE(business_id,policy_key,version), UNIQUE(business_id,request_key)
);
CREATE TABLE bot_routine_policy_revocations (
 policy_id TEXT PRIMARY KEY REFERENCES bot_routine_policies(id),
 actor_id INTEGER NOT NULL REFERENCES users(id), reason TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TRIGGER bot_routine_policies_no_update BEFORE UPDATE ON bot_routine_policies BEGIN SELECT RAISE(ABORT,'Policy enrollment is immutable'); END;
CREATE TRIGGER bot_routine_policies_no_delete BEFORE DELETE ON bot_routine_policies BEGIN SELECT RAISE(ABORT,'Policy enrollment is immutable'); END;
CREATE TRIGGER bot_routine_revocations_no_update BEFORE UPDATE ON bot_routine_policy_revocations BEGIN SELECT RAISE(ABORT,'Policy revocation is immutable'); END;
CREATE TRIGGER bot_routine_revocations_no_delete BEFORE DELETE ON bot_routine_policy_revocations BEGIN SELECT RAISE(ABORT,'Policy revocation is immutable'); END;
