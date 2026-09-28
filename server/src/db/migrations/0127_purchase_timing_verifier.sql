CREATE TABLE purchase_timing_trust (
 id TEXT PRIMARY KEY, request_key TEXT NOT NULL UNIQUE, owner_id INTEGER NOT NULL REFERENCES users(id),
 business_id TEXT NOT NULL REFERENCES business_teams(id), executor_id TEXT NOT NULL REFERENCES conversations(id),
 account_id TEXT NOT NULL, principal_id TEXT NOT NULL, source_origin TEXT NOT NULL,
 audience TEXT NOT NULL, client_id TEXT NOT NULL, enrollment_json TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 UNIQUE(business_id,account_id,executor_id)
);
CREATE TABLE purchase_timing_revocations (
 trust_id TEXT PRIMARY KEY REFERENCES purchase_timing_trust(id), actor_id INTEGER NOT NULL REFERENCES users(id), reason TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE purchase_timing_captures (
 id TEXT PRIMARY KEY, trust_id TEXT NOT NULL REFERENCES purchase_timing_trust(id), request_key TEXT NOT NULL,
 request_json TEXT NOT NULL, scope_hash TEXT NOT NULL, received_at TEXT NOT NULL,
 UNIQUE(trust_id,request_key)
);
CREATE TABLE purchase_timing_claims (
 id TEXT PRIMARY KEY, trust_id TEXT NOT NULL REFERENCES purchase_timing_trust(id), request_key TEXT NOT NULL,
 decision_id TEXT NOT NULL REFERENCES bot_decisions(id), business_id TEXT NOT NULL, account_id TEXT NOT NULL, order_id TEXT NOT NULL, request_json TEXT NOT NULL,
 receipt_json TEXT NOT NULL, created_at TEXT NOT NULL,
 UNIQUE(trust_id,request_key), UNIQUE(decision_id), UNIQUE(business_id,account_id,order_id)
);
CREATE TRIGGER purchase_timing_trust_no_update BEFORE UPDATE ON purchase_timing_trust BEGIN SELECT RAISE(ABORT,'Immutable timing trust'); END;
CREATE TRIGGER purchase_timing_trust_no_delete BEFORE DELETE ON purchase_timing_trust BEGIN SELECT RAISE(ABORT,'Immutable timing trust'); END;
CREATE TRIGGER purchase_timing_revocation_no_update BEFORE UPDATE ON purchase_timing_revocations BEGIN SELECT RAISE(ABORT,'Immutable timing revocation'); END;
CREATE TRIGGER purchase_timing_revocation_no_delete BEFORE DELETE ON purchase_timing_revocations BEGIN SELECT RAISE(ABORT,'Immutable timing revocation'); END;
CREATE TRIGGER purchase_timing_capture_no_update BEFORE UPDATE ON purchase_timing_captures BEGIN SELECT RAISE(ABORT,'Immutable timing capture'); END;
CREATE TRIGGER purchase_timing_capture_no_delete BEFORE DELETE ON purchase_timing_captures BEGIN SELECT RAISE(ABORT,'Immutable timing capture'); END;
CREATE TRIGGER purchase_timing_claim_no_update BEFORE UPDATE ON purchase_timing_claims BEGIN SELECT RAISE(ABORT,'Immutable timing claim'); END;
CREATE TRIGGER purchase_timing_claim_no_delete BEFORE DELETE ON purchase_timing_claims BEGIN SELECT RAISE(ABORT,'Immutable timing claim'); END;
