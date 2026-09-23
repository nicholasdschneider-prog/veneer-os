CREATE TABLE routine_scope_evidence (
 id TEXT PRIMARY KEY, trust_id TEXT NOT NULL REFERENCES routine_source_trust(id),
 decision_id TEXT REFERENCES bot_decisions(id), target_case TEXT, decision_version INTEGER NOT NULL,
 proposal_hash TEXT NOT NULL, event_revision INTEGER NOT NULL, scope_hash TEXT NOT NULL, snapshot_json TEXT NOT NULL,
 captured_ms INTEGER NOT NULL, request_key TEXT NOT NULL, request_hash TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(trust_id,request_key)
);
CREATE INDEX routine_scope_evidence_decision ON routine_scope_evidence(trust_id,decision_id);
CREATE TABLE routine_hold_bindings (
 id TEXT PRIMARY KEY, trust_id TEXT NOT NULL REFERENCES routine_source_trust(id),
 business_id TEXT NOT NULL REFERENCES business_teams(id), decision_id TEXT NOT NULL REFERENCES bot_decisions(id),
 decision_version INTEGER NOT NULL, proposal_hash TEXT NOT NULL, event_revision INTEGER NOT NULL, scope_kind TEXT NOT NULL CHECK(scope_kind IN ('case_set','business_wide','unknown')), scope_hash TEXT NOT NULL,
 evidence_id TEXT REFERENCES routine_scope_evidence(id), owner_id INTEGER NOT NULL REFERENCES users(id),
 request_key TEXT NOT NULL, request_hash TEXT NOT NULL, review_reference TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(trust_id,request_key)
);
CREATE INDEX routine_hold_binding_decision ON routine_hold_bindings(trust_id,decision_id);
CREATE TABLE routine_hold_revocations (
 binding_id TEXT PRIMARY KEY REFERENCES routine_hold_bindings(id), actor_id INTEGER NOT NULL REFERENCES users(id),
 reason TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TRIGGER routine_scope_evidence_update BEFORE UPDATE ON routine_scope_evidence BEGIN SELECT RAISE(ABORT, 'Routine scope audit is immutable'); END;
CREATE TRIGGER routine_scope_evidence_delete BEFORE DELETE ON routine_scope_evidence BEGIN SELECT RAISE(ABORT, 'Routine scope audit is immutable'); END;
CREATE TRIGGER routine_hold_bindings_update BEFORE UPDATE ON routine_hold_bindings BEGIN SELECT RAISE(ABORT, 'Routine scope audit is immutable'); END;
CREATE TRIGGER routine_hold_bindings_delete BEFORE DELETE ON routine_hold_bindings BEGIN SELECT RAISE(ABORT, 'Routine scope audit is immutable'); END;
CREATE TRIGGER routine_hold_revocations_update BEFORE UPDATE ON routine_hold_revocations BEGIN SELECT RAISE(ABORT, 'Routine scope audit is immutable'); END;
CREATE TRIGGER routine_hold_revocations_delete BEFORE DELETE ON routine_hold_revocations BEGIN SELECT RAISE(ABORT, 'Routine scope audit is immutable'); END;
CREATE INDEX routine_scope_evidence_target ON routine_scope_evidence(trust_id,target_case);
