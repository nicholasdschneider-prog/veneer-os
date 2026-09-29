CREATE TABLE compose_scope_reviews (
 id TEXT PRIMARY KEY, authority_id TEXT NOT NULL REFERENCES bot_composed_sms_authorities(id),
 owner_id TEXT NOT NULL REFERENCES conversations(id),request_key TEXT NOT NULL,request_hash TEXT NOT NULL,
 context_revision TEXT NOT NULL,evidence_json TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(authority_id,request_key)
);
CREATE TABLE compose_scope_revocations(review_id TEXT PRIMARY KEY REFERENCES compose_scope_reviews(id),reason TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TRIGGER compose_scope_reviews_no_update BEFORE UPDATE ON compose_scope_reviews BEGIN SELECT RAISE(ABORT,'Immutable compose scope review'); END;
CREATE TRIGGER compose_scope_reviews_no_delete BEFORE DELETE ON compose_scope_reviews BEGIN SELECT RAISE(ABORT,'Immutable compose scope review'); END;
CREATE TRIGGER compose_scope_revocations_no_update BEFORE UPDATE ON compose_scope_revocations BEGIN SELECT RAISE(ABORT,'Immutable compose scope revocation'); END;
CREATE TRIGGER compose_scope_revocations_no_delete BEFORE DELETE ON compose_scope_revocations BEGIN SELECT RAISE(ABORT,'Immutable compose scope revocation'); END;
