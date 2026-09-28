-- Separate prospective service boundary; legacy authority hashes are never reinterpreted.
CREATE TABLE bot_composed_sms_dispatch_authorities (
 authority_id TEXT PRIMARY KEY REFERENCES bot_composed_sms_authorities(id),
 action_id TEXT NOT NULL UNIQUE, registration_id TEXT NOT NULL,
 registration_hash TEXT NOT NULL, tuple_json TEXT NOT NULL,
 sender_expires_at TEXT NOT NULL, expires_at TEXT NOT NULL
);
CREATE TABLE bot_composed_sms_associations (
 id TEXT PRIMARY KEY, authority_id TEXT NOT NULL UNIQUE REFERENCES bot_composed_sms_dispatch_authorities(authority_id),
 action_id TEXT NOT NULL UNIQUE, claim_id TEXT NOT NULL UNIQUE,
 registration_id TEXT NOT NULL, prepare_id TEXT NOT NULL, request_key TEXT NOT NULL,
 request_hash TEXT NOT NULL, binding_hash TEXT NOT NULL, source_evidence_json TEXT NOT NULL,
 issued_at TEXT NOT NULL, expires_at TEXT NOT NULL,
 UNIQUE(registration_id,prepare_id), UNIQUE(registration_id,request_key)
);
CREATE TABLE bot_composed_sms_service_receipts (
 association_id TEXT PRIMARY KEY REFERENCES bot_composed_sms_associations(id),
 registration_id TEXT NOT NULL, evidence_json TEXT NOT NULL,
 provider_account TEXT NOT NULL, provider_id TEXT NOT NULL,
 recorded_at TEXT NOT NULL, UNIQUE(provider_account,provider_id)
);
CREATE TRIGGER compose_dispatch_authority_immutable_update BEFORE UPDATE ON bot_composed_sms_dispatch_authorities BEGIN SELECT RAISE(ABORT,'Immutable dispatch authority'); END;
CREATE TRIGGER compose_dispatch_authority_immutable_delete BEFORE DELETE ON bot_composed_sms_dispatch_authorities BEGIN SELECT RAISE(ABORT,'Immutable dispatch authority'); END;
CREATE TRIGGER compose_association_immutable_update BEFORE UPDATE ON bot_composed_sms_associations BEGIN SELECT RAISE(ABORT,'Immutable dispatch association'); END;
CREATE TRIGGER compose_association_immutable_delete BEFORE DELETE ON bot_composed_sms_associations BEGIN SELECT RAISE(ABORT,'Immutable dispatch association'); END;
CREATE TRIGGER compose_receipt_immutable_update BEFORE UPDATE ON bot_composed_sms_service_receipts BEGIN SELECT RAISE(ABORT,'Immutable service receipt'); END;
CREATE TRIGGER compose_receipt_immutable_delete BEFORE DELETE ON bot_composed_sms_service_receipts BEGIN SELECT RAISE(ABORT,'Immutable service receipt'); END;
