-- New prospective paired outreach authority. No existing business records altered.
CREATE TABLE contact_verification_enrollments(registration_id TEXT PRIMARY KEY,registration_hash TEXT NOT NULL,owner_id INTEGER NOT NULL,evidence_json TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE contact_verification_authorities(id TEXT PRIMARY KEY,registration_id TEXT NOT NULL,target_key TEXT NOT NULL UNIQUE,request_key TEXT NOT NULL,request_hash TEXT NOT NULL,authority_json TEXT NOT NULL,context_json TEXT NOT NULL,UNIQUE(registration_id,request_key));
CREATE TABLE contact_verification_revocations(authority_id TEXT PRIMARY KEY REFERENCES contact_verification_authorities(id),actor_id INTEGER NOT NULL,reason TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE contact_verification_generations(authority_id TEXT PRIMARY KEY REFERENCES contact_verification_authorities(id),registration_id TEXT NOT NULL,generation_id TEXT NOT NULL UNIQUE,generation_json TEXT NOT NULL);
CREATE TABLE contact_verification_associations(id TEXT PRIMARY KEY,authority_id TEXT NOT NULL REFERENCES contact_verification_authorities(id),registration_id TEXT NOT NULL,channel TEXT NOT NULL CHECK(channel IN ('email','sms')),intent_id TEXT NOT NULL UNIQUE,request_key TEXT NOT NULL UNIQUE,provider_key TEXT NOT NULL UNIQUE,intent_hash TEXT NOT NULL UNIQUE,request_hash TEXT NOT NULL UNIQUE,association_json TEXT NOT NULL,source_json TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(authority_id,channel));
CREATE TABLE contact_verification_receipts(id TEXT PRIMARY KEY,association_id TEXT NOT NULL REFERENCES contact_verification_associations(id),state TEXT NOT NULL CHECK(state IN ('SENT_ACCEPTED','UNKNOWN','ROLLED_BACK_TERMINAL')),outcome_json TEXT NOT NULL,source_json TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TRIGGER contact_verification_enrollments_no_update BEFORE UPDATE ON contact_verification_enrollments BEGIN SELECT RAISE(ABORT,'Immutable paired contact history'); END;
CREATE TRIGGER contact_verification_enrollments_no_delete BEFORE DELETE ON contact_verification_enrollments BEGIN SELECT RAISE(ABORT,'Immutable paired contact history'); END;
CREATE TRIGGER contact_verification_authorities_no_update BEFORE UPDATE ON contact_verification_authorities BEGIN SELECT RAISE(ABORT,'Immutable paired contact history'); END;
CREATE TRIGGER contact_verification_authorities_no_delete BEFORE DELETE ON contact_verification_authorities BEGIN SELECT RAISE(ABORT,'Immutable paired contact history'); END;
CREATE TRIGGER contact_verification_revocations_no_update BEFORE UPDATE ON contact_verification_revocations BEGIN SELECT RAISE(ABORT,'Immutable paired contact history'); END;
CREATE TRIGGER contact_verification_revocations_no_delete BEFORE DELETE ON contact_verification_revocations BEGIN SELECT RAISE(ABORT,'Immutable paired contact history'); END;
CREATE TRIGGER contact_verification_generations_no_update BEFORE UPDATE ON contact_verification_generations BEGIN SELECT RAISE(ABORT,'Immutable paired contact history'); END;
CREATE TRIGGER contact_verification_generations_no_delete BEFORE DELETE ON contact_verification_generations BEGIN SELECT RAISE(ABORT,'Immutable paired contact history'); END;
CREATE TRIGGER contact_verification_associations_no_update BEFORE UPDATE ON contact_verification_associations BEGIN SELECT RAISE(ABORT,'Immutable paired contact history'); END;
CREATE TRIGGER contact_verification_associations_no_delete BEFORE DELETE ON contact_verification_associations BEGIN SELECT RAISE(ABORT,'Immutable paired contact history'); END;
CREATE TRIGGER contact_verification_receipts_no_update BEFORE UPDATE ON contact_verification_receipts BEGIN SELECT RAISE(ABORT,'Immutable paired contact history'); END;
CREATE TRIGGER contact_verification_receipts_no_delete BEFORE DELETE ON contact_verification_receipts BEGIN SELECT RAISE(ABORT,'Immutable paired contact history'); END;

CREATE TABLE contact_verification_pair_blocks(authority_id TEXT PRIMARY KEY REFERENCES contact_verification_authorities(id),generation_id TEXT NOT NULL,block_json TEXT NOT NULL,source_json TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TRIGGER contact_verification_pair_blocks_no_update BEFORE UPDATE ON contact_verification_pair_blocks BEGIN SELECT RAISE(ABORT,'Immutable paired contact history'); END;
CREATE TRIGGER contact_verification_pair_blocks_no_delete BEFORE DELETE ON contact_verification_pair_blocks BEGIN SELECT RAISE(ABORT,'Immutable paired contact history'); END;
