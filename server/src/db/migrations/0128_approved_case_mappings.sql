-- Supplemental source evidence; original approvals and payloads are untouched.
CREATE TABLE approved_case_mapping_bindings (
 delegation_id TEXT PRIMARY KEY REFERENCES bot_message_delegations(id),
 fingerprint TEXT NOT NULL, source_revision TEXT NOT NULL, evidence_json TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TRIGGER approved_case_mapping_no_update BEFORE UPDATE ON approved_case_mapping_bindings BEGIN SELECT RAISE(ABORT,'Case mapping binding is immutable'); END;
CREATE TRIGGER approved_case_mapping_no_delete BEFORE DELETE ON approved_case_mapping_bindings BEGIN SELECT RAISE(ABORT,'Case mapping binding is immutable'); END;
