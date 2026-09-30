-- Prospective custody only. Historical case/approval/completion records are untouched.
CREATE TABLE case_custody_enrollments(registration_id TEXT PRIMARY KEY, registration_hash TEXT NOT NULL, owner_id INTEGER NOT NULL, evidence_json TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE case_custody_authorities(id TEXT PRIMARY KEY, registration_id TEXT NOT NULL, case_id TEXT NOT NULL, completion_event_id TEXT NOT NULL, request_key TEXT NOT NULL, request_hash TEXT NOT NULL, authority_json TEXT NOT NULL, inspection_json TEXT NOT NULL, review_json TEXT NOT NULL, UNIQUE(case_id,completion_event_id), UNIQUE(registration_id,request_key));
CREATE TABLE case_custody_revocations(authority_id TEXT PRIMARY KEY REFERENCES case_custody_authorities(id), actor_id INTEGER NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE case_custody_claims(id TEXT PRIMARY KEY, authority_id TEXT NOT NULL UNIQUE REFERENCES case_custody_authorities(id), registration_id TEXT NOT NULL, source_request_id TEXT NOT NULL, request_hash TEXT NOT NULL, request_json TEXT NOT NULL, source_intent_json TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(registration_id,source_request_id));
CREATE TABLE case_custody_receipts(id TEXT PRIMARY KEY, claim_id TEXT NOT NULL REFERENCES case_custody_claims(id), state TEXT NOT NULL CHECK(state IN ('APPLIED','UNKNOWN','ROLLED_BACK_TERMINAL')), source_receipt_hash TEXT, evidence_json TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TRIGGER case_custody_enrollment_no_update BEFORE UPDATE ON case_custody_enrollments BEGIN SELECT RAISE(ABORT,'Immutable custody enrollment'); END;
CREATE TRIGGER case_custody_enrollment_no_delete BEFORE DELETE ON case_custody_enrollments BEGIN SELECT RAISE(ABORT,'Immutable custody enrollment'); END;
CREATE TRIGGER case_custody_authority_no_update BEFORE UPDATE ON case_custody_authorities BEGIN SELECT RAISE(ABORT,'Immutable custody authority'); END;
CREATE TRIGGER case_custody_authority_no_delete BEFORE DELETE ON case_custody_authorities BEGIN SELECT RAISE(ABORT,'Immutable custody authority'); END;
CREATE TRIGGER case_custody_revoke_no_update BEFORE UPDATE ON case_custody_revocations BEGIN SELECT RAISE(ABORT,'Immutable custody revocation'); END;
CREATE TRIGGER case_custody_revoke_no_delete BEFORE DELETE ON case_custody_revocations BEGIN SELECT RAISE(ABORT,'Immutable custody revocation'); END;
CREATE TRIGGER case_custody_claim_no_update BEFORE UPDATE ON case_custody_claims BEGIN SELECT RAISE(ABORT,'Irrevocable custody reservation'); END;
CREATE TRIGGER case_custody_claim_no_delete BEFORE DELETE ON case_custody_claims BEGIN SELECT RAISE(ABORT,'Irrevocable custody reservation'); END;
CREATE TRIGGER case_custody_receipt_no_update BEFORE UPDATE ON case_custody_receipts BEGIN SELECT RAISE(ABORT,'Immutable custody receipt'); END;
CREATE TRIGGER case_custody_receipt_no_delete BEFORE DELETE ON case_custody_receipts BEGIN SELECT RAISE(ABORT,'Immutable custody receipt'); END;
