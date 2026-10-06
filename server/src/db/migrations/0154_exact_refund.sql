-- Exact no-return refunds have permanent, conservative order-wide identity.
CREATE TABLE exact_refund_authorities (
 id TEXT PRIMARY KEY, action_digest TEXT NOT NULL UNIQUE, registration_id TEXT NOT NULL,
 decision_id TEXT NOT NULL UNIQUE, request_key TEXT NOT NULL, request_hash TEXT NOT NULL,
 authority_json TEXT NOT NULL, native_json TEXT NOT NULL, review_json TEXT NOT NULL,
 UNIQUE(registration_id,request_key)
);
CREATE TABLE exact_refund_revocations (
 authority_id TEXT PRIMARY KEY REFERENCES exact_refund_authorities(id),
 actor_id INTEGER NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE exact_refund_associations (
 id TEXT PRIMARY KEY, authority_id TEXT NOT NULL UNIQUE REFERENCES exact_refund_authorities(id),
 action_digest TEXT NOT NULL UNIQUE, source_intent_id TEXT NOT NULL,
 registration_id TEXT NOT NULL, service_principal_id TEXT NOT NULL,
 request_key TEXT NOT NULL, request_hash TEXT NOT NULL, intent_hash TEXT NOT NULL UNIQUE,
 association_json TEXT NOT NULL, intent_json TEXT NOT NULL,
 UNIQUE(service_principal_id,source_intent_id), UNIQUE(service_principal_id,request_key)
);
CREATE TABLE exact_refund_receipts (
 id TEXT PRIMARY KEY, association_id TEXT NOT NULL REFERENCES exact_refund_associations(id),
 receipt_hash TEXT NOT NULL, state TEXT NOT NULL, receipt_json TEXT NOT NULL, created_at TEXT NOT NULL,
 UNIQUE(association_id,receipt_hash)
);
CREATE TRIGGER exact_refund_authorities_no_update BEFORE UPDATE ON exact_refund_authorities BEGIN SELECT RAISE(ABORT,'Immutable refund authority'); END;
CREATE TRIGGER exact_refund_authorities_no_delete BEFORE DELETE ON exact_refund_authorities BEGIN SELECT RAISE(ABORT,'Permanent refund action'); END;
CREATE TRIGGER exact_refund_revocations_no_update BEFORE UPDATE ON exact_refund_revocations BEGIN SELECT RAISE(ABORT,'Immutable refund revocation'); END;
CREATE TRIGGER exact_refund_revocations_no_delete BEFORE DELETE ON exact_refund_revocations BEGIN SELECT RAISE(ABORT,'Permanent refund revocation'); END;
CREATE TRIGGER exact_refund_associations_no_update BEFORE UPDATE ON exact_refund_associations BEGIN SELECT RAISE(ABORT,'Immutable refund reservation'); END;
CREATE TRIGGER exact_refund_associations_no_delete BEFORE DELETE ON exact_refund_associations BEGIN SELECT RAISE(ABORT,'Permanent refund reservation'); END;
CREATE TRIGGER exact_refund_receipts_no_update BEFORE UPDATE ON exact_refund_receipts BEGIN SELECT RAISE(ABORT,'Immutable refund receipt'); END;
CREATE TRIGGER exact_refund_receipts_no_delete BEFORE DELETE ON exact_refund_receipts BEGIN SELECT RAISE(ABORT,'Permanent refund receipt'); END;
