CREATE TABLE return_bridge_trust (
 id TEXT PRIMARY KEY, business_id TEXT NOT NULL REFERENCES business_teams(id),
 owner_id INTEGER NOT NULL REFERENCES users(id), executor_id TEXT NOT NULL REFERENCES conversations(id),
 client_id TEXT NOT NULL, audience TEXT NOT NULL, account_id TEXT NOT NULL, principal_id TEXT NOT NULL,
 source_origin TEXT NOT NULL, request_key TEXT NOT NULL UNIQUE,
 created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE return_bridge_revocations (
 trust_id TEXT PRIMARY KEY REFERENCES return_bridge_trust(id), actor_id INTEGER NOT NULL REFERENCES users(id),
 reason TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE return_bridge_mappings (
 id TEXT PRIMARY KEY, trust_id TEXT NOT NULL REFERENCES return_bridge_trust(id),
 decision_id TEXT NOT NULL REFERENCES bot_decisions(id), decision_version INTEGER NOT NULL,
 approval_event_id TEXT NOT NULL REFERENCES bot_decision_events(id), proposal_hash TEXT NOT NULL,
 request_key TEXT NOT NULL, scope_hash TEXT NOT NULL, capture_json TEXT NOT NULL, receipt_json TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(trust_id,request_key)
);
CREATE TABLE return_bridge_claims (
 id TEXT PRIMARY KEY, mapping_id TEXT NOT NULL REFERENCES return_bridge_mappings(id),
 decision_id TEXT NOT NULL UNIQUE REFERENCES bot_decisions(id), request_key TEXT NOT NULL UNIQUE,
 scope_hash TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE return_bridge_acknowledgments (
 claim_id TEXT PRIMARY KEY REFERENCES return_bridge_claims(id), receipt_json TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TRIGGER return_trust_no_update BEFORE UPDATE ON return_bridge_trust BEGIN SELECT RAISE(ABORT,'Immutable trust'); END;
CREATE TRIGGER return_trust_no_delete BEFORE DELETE ON return_bridge_trust BEGIN SELECT RAISE(ABORT,'Immutable trust'); END;
CREATE TRIGGER return_revoke_no_update BEFORE UPDATE ON return_bridge_revocations BEGIN SELECT RAISE(ABORT,'Immutable revocation'); END;
CREATE TRIGGER return_revoke_no_delete BEFORE DELETE ON return_bridge_revocations BEGIN SELECT RAISE(ABORT,'Immutable revocation'); END;
CREATE TRIGGER return_mapping_no_update BEFORE UPDATE ON return_bridge_mappings BEGIN SELECT RAISE(ABORT,'Immutable mapping'); END;
CREATE TRIGGER return_mapping_no_delete BEFORE DELETE ON return_bridge_mappings BEGIN SELECT RAISE(ABORT,'Immutable mapping'); END;
CREATE TRIGGER return_claim_no_update BEFORE UPDATE ON return_bridge_claims BEGIN SELECT RAISE(ABORT,'Immutable claim'); END;
CREATE TRIGGER return_claim_no_delete BEFORE DELETE ON return_bridge_claims BEGIN SELECT RAISE(ABORT,'Immutable claim'); END;
CREATE TRIGGER return_ack_no_update BEFORE UPDATE ON return_bridge_acknowledgments BEGIN SELECT RAISE(ABORT,'Immutable acknowledgment'); END;
CREATE TRIGGER return_ack_no_delete BEFORE DELETE ON return_bridge_acknowledgments BEGIN SELECT RAISE(ABORT,'Immutable acknowledgment'); END;
