-- Standing authority is separate from synthetic human draft approval.
CREATE TABLE routine_source_trust (
 id TEXT PRIMARY KEY, policy_id TEXT NOT NULL REFERENCES bot_routine_policies(id),
 owner_id INTEGER NOT NULL REFERENCES users(id), request_key TEXT NOT NULL,
 snapshot_json TEXT NOT NULL, snapshot_hash TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(owner_id,request_key)
);
CREATE TABLE routine_source_revocations (
 trust_id TEXT PRIMARY KEY REFERENCES routine_source_trust(id), actor_id INTEGER NOT NULL REFERENCES users(id),
 reason TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE routine_source_proofs (
 id TEXT PRIMARY KEY, trust_id TEXT NOT NULL REFERENCES routine_source_trust(id), request_key TEXT NOT NULL,
 capture_json TEXT NOT NULL, capture_hash TEXT NOT NULL, scope_json TEXT NOT NULL, scope_hash TEXT NOT NULL,
 material_hash TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(trust_id,request_key)
);
CREATE TABLE routine_draft_authorizations (
 draft_id TEXT PRIMARY KEY REFERENCES bot_message_drafts(id), proof_id TEXT NOT NULL UNIQUE REFERENCES routine_source_proofs(id),
 trust_id TEXT NOT NULL REFERENCES routine_source_trust(id), actor_id INTEGER NOT NULL REFERENCES users(id),
 executor_id TEXT NOT NULL REFERENCES conversations(id), request_key TEXT NOT NULL, expected_version INTEGER NOT NULL,
 scope_hash TEXT NOT NULL, material_hash TEXT NOT NULL, source_intent TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(executor_id,request_key), UNIQUE(trust_id,source_intent), UNIQUE(trust_id,scope_hash,material_hash)
);
CREATE TABLE routine_draft_claims (
 draft_id TEXT PRIMARY KEY REFERENCES routine_draft_authorizations(draft_id), proof_id TEXT NOT NULL UNIQUE REFERENCES routine_source_proofs(id),
 claim_key TEXT NOT NULL, scope_hash TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE routine_delivery_readbacks (
 draft_id TEXT PRIMARY KEY REFERENCES routine_draft_claims(draft_id), receipt_json TEXT NOT NULL, receipt_hash TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TRIGGER routine_source_trust_no_update BEFORE UPDATE ON routine_source_trust BEGIN SELECT RAISE(ABORT,'Routine authority audit is immutable'); END;
CREATE TRIGGER routine_source_trust_no_delete BEFORE DELETE ON routine_source_trust BEGIN SELECT RAISE(ABORT,'Routine authority audit is immutable'); END;
CREATE TRIGGER routine_source_revocations_no_update BEFORE UPDATE ON routine_source_revocations BEGIN SELECT RAISE(ABORT,'Routine authority audit is immutable'); END;
CREATE TRIGGER routine_source_revocations_no_delete BEFORE DELETE ON routine_source_revocations BEGIN SELECT RAISE(ABORT,'Routine authority audit is immutable'); END;
CREATE TRIGGER routine_source_proofs_no_update BEFORE UPDATE ON routine_source_proofs BEGIN SELECT RAISE(ABORT,'Routine authority audit is immutable'); END;
CREATE TRIGGER routine_source_proofs_no_delete BEFORE DELETE ON routine_source_proofs BEGIN SELECT RAISE(ABORT,'Routine authority audit is immutable'); END;
CREATE TRIGGER routine_draft_authorizations_no_update BEFORE UPDATE ON routine_draft_authorizations BEGIN SELECT RAISE(ABORT,'Routine authority audit is immutable'); END;
CREATE TRIGGER routine_draft_authorizations_no_delete BEFORE DELETE ON routine_draft_authorizations BEGIN SELECT RAISE(ABORT,'Routine authority audit is immutable'); END;
CREATE TRIGGER routine_draft_claims_no_update BEFORE UPDATE ON routine_draft_claims BEGIN SELECT RAISE(ABORT,'Routine authority audit is immutable'); END;
CREATE TRIGGER routine_draft_claims_no_delete BEFORE DELETE ON routine_draft_claims BEGIN SELECT RAISE(ABORT,'Routine authority audit is immutable'); END;
CREATE TRIGGER routine_delivery_readbacks_no_update BEFORE UPDATE ON routine_delivery_readbacks BEGIN SELECT RAISE(ABORT,'Routine authority audit is immutable'); END;
CREATE TRIGGER routine_delivery_readbacks_no_delete BEFORE DELETE ON routine_delivery_readbacks BEGIN SELECT RAISE(ABORT,'Routine authority audit is immutable'); END;

CREATE UNIQUE INDEX routine_delivery_provider_identity ON routine_delivery_readbacks(json_extract(receipt_json,'$.account_id'),json_extract(receipt_json,'$.provider_message_id'));
