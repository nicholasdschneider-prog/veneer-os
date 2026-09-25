-- Owner-selected source locators are preparation data, never scope/send approval.
CREATE TABLE routine_scope_handoffs (
 id TEXT PRIMARY KEY, trust_id TEXT NOT NULL REFERENCES routine_source_trust(id),
 decision_id TEXT NOT NULL REFERENCES bot_decisions(id), decision_version INTEGER NOT NULL,
 proposal_hash TEXT NOT NULL, event_revision INTEGER NOT NULL, owner_id INTEGER NOT NULL REFERENCES users(id),
 revision INTEGER NOT NULL, previous_id TEXT REFERENCES routine_scope_handoffs(id),
 request_key TEXT NOT NULL, request_hash TEXT NOT NULL, source_request_key TEXT NOT NULL UNIQUE,
 roots_json TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')),
 UNIQUE(trust_id,request_key), UNIQUE(trust_id,decision_id,revision)
);
CREATE TABLE routine_scope_handoff_revocations (
 handoff_id TEXT PRIMARY KEY REFERENCES routine_scope_handoffs(id), actor_id INTEGER NOT NULL REFERENCES users(id),
 reason TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE routine_scope_handoff_evidence (
 evidence_id TEXT PRIMARY KEY REFERENCES routine_scope_evidence(id), handoff_id TEXT NOT NULL REFERENCES routine_scope_handoffs(id)
);
CREATE TRIGGER routine_scope_handoffs_no_update BEFORE UPDATE ON routine_scope_handoffs BEGIN SELECT RAISE(ABORT,'Scope handoff is immutable'); END;
CREATE TRIGGER routine_scope_handoffs_no_delete BEFORE DELETE ON routine_scope_handoffs BEGIN SELECT RAISE(ABORT,'Scope handoff is immutable'); END;
CREATE TRIGGER routine_scope_handoff_revocations_no_update BEFORE UPDATE ON routine_scope_handoff_revocations BEGIN SELECT RAISE(ABORT,'Scope handoff revocation is immutable'); END;
CREATE TRIGGER routine_scope_handoff_revocations_no_delete BEFORE DELETE ON routine_scope_handoff_revocations BEGIN SELECT RAISE(ABORT,'Scope handoff revocation is immutable'); END;
CREATE TRIGGER routine_scope_handoff_evidence_no_update BEFORE UPDATE ON routine_scope_handoff_evidence BEGIN SELECT RAISE(ABORT,'Scope handoff evidence is immutable'); END;
CREATE TRIGGER routine_scope_handoff_evidence_no_delete BEFORE DELETE ON routine_scope_handoff_evidence BEGIN SELECT RAISE(ABORT,'Scope handoff evidence is immutable'); END;
