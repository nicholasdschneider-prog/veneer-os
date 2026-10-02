-- Prospective direct-human vendor replies. No historical draft/approval is rewritten.
CREATE TABLE bot_vendor_email_authorities (
 id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id),
 executor_user_id INTEGER NOT NULL REFERENCES users(id), business_id TEXT NOT NULL,
 source_kind TEXT NOT NULL CHECK(source_kind IN ('direct_message','result_reply')),
 source_id TEXT NOT NULL, author_id INTEGER NOT NULL REFERENCES users(id),
 target_key TEXT NOT NULL, account TEXT NOT NULL, recipient TEXT NOT NULL,
 scope_json TEXT NOT NULL, payload_hash TEXT NOT NULL, source_hash TEXT NOT NULL,
 request_key TEXT NOT NULL, request_hash TEXT NOT NULL, review_json TEXT NOT NULL,
 supersedes_id TEXT REFERENCES bot_vendor_email_authorities(id),
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 UNIQUE(conversation_id,request_key)
);
CREATE TABLE bot_vendor_email_targets (
 target_key TEXT PRIMARY KEY, authority_id TEXT NOT NULL REFERENCES bot_vendor_email_authorities(id),
 claim_key TEXT, state TEXT NOT NULL DEFAULT 'bound' CHECK(state IN ('bound','claimed','uncertain','sent','failed','revoked'))
);
CREATE TABLE bot_vendor_email_sources (
 source_kind TEXT NOT NULL, source_id TEXT NOT NULL, target_key TEXT NOT NULL REFERENCES bot_vendor_email_targets(target_key),
 PRIMARY KEY(source_kind,source_id)
);
CREATE TABLE bot_vendor_email_events (
 id TEXT PRIMARY KEY, authority_id TEXT NOT NULL REFERENCES bot_vendor_email_authorities(id),
 actor_id INTEGER NOT NULL REFERENCES users(id), actor_conversation_id TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('claimed','uncertain','sent','failed','revoked','superseded')),
 request_key TEXT NOT NULL, payload_json TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 UNIQUE(authority_id,kind,request_key)
);
CREATE UNIQUE INDEX bot_vendor_email_one_claim ON bot_vendor_email_events(authority_id) WHERE kind='claimed';
CREATE TRIGGER bot_vendor_email_authorities_no_update BEFORE UPDATE ON bot_vendor_email_authorities BEGIN SELECT RAISE(ABORT,'Immutable vendor email authority'); END;
CREATE TRIGGER bot_vendor_email_authorities_no_delete BEFORE DELETE ON bot_vendor_email_authorities BEGIN SELECT RAISE(ABORT,'Immutable vendor email authority'); END;
CREATE TRIGGER bot_vendor_email_events_no_update BEFORE UPDATE ON bot_vendor_email_events BEGIN SELECT RAISE(ABORT,'Immutable vendor email event'); END;
CREATE TRIGGER bot_vendor_email_events_no_delete BEFORE DELETE ON bot_vendor_email_events BEGIN SELECT RAISE(ABORT,'Immutable vendor email event'); END;
CREATE TRIGGER bot_vendor_email_sources_no_update BEFORE UPDATE ON bot_vendor_email_sources BEGIN SELECT RAISE(ABORT,'Immutable vendor email source fence'); END;
CREATE TRIGGER bot_vendor_email_sources_no_delete BEFORE DELETE ON bot_vendor_email_sources BEGIN SELECT RAISE(ABORT,'Immutable vendor email source fence'); END;
CREATE TRIGGER bot_vendor_email_targets_no_delete BEFORE DELETE ON bot_vendor_email_targets BEGIN SELECT RAISE(ABORT,'Permanent vendor email target fence'); END;
CREATE TRIGGER bot_vendor_email_targets_no_rekey BEFORE UPDATE ON bot_vendor_email_targets
WHEN NEW.target_key <> OLD.target_key OR (OLD.claim_key IS NOT NULL AND (NEW.claim_key IS NOT OLD.claim_key OR NEW.authority_id <> OLD.authority_id))
BEGIN SELECT RAISE(ABORT,'Permanent vendor email attempt fence'); END;
