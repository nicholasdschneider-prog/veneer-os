-- Prospective exact derived authority. Never changes a human answer or ordinary draft.
CREATE TABLE bot_composed_sms_authorities (
 id TEXT PRIMARY KEY, action_id TEXT NOT NULL UNIQUE,
 owner_id TEXT NOT NULL REFERENCES conversations(id), executor_id TEXT NOT NULL REFERENCES conversations(id),
 source_id TEXT NOT NULL REFERENCES bot_human_messages(id), draft_id TEXT NOT NULL REFERENCES bot_message_drafts(id),
 request_key TEXT NOT NULL, request_hash TEXT NOT NULL, snapshot_json TEXT NOT NULL,
 expires_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 UNIQUE(owner_id,request_key)
);
CREATE TABLE bot_composed_sms_events (
 id INTEGER PRIMARY KEY, authority_id TEXT NOT NULL REFERENCES bot_composed_sms_authorities(id),
 kind TEXT NOT NULL CHECK(kind IN ('accepted','claimed','sent','unknown','revoked')),
 actor_id INTEGER NOT NULL REFERENCES users(id), actor_conversation_id TEXT NOT NULL REFERENCES conversations(id),
 request_key TEXT NOT NULL, payload_json TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 UNIQUE(authority_id,kind)
);
CREATE UNIQUE INDEX composed_sms_provider_receipt ON bot_composed_sms_events(json_extract(payload_json,'$.provider'),json_extract(payload_json,'$.provider_message_id')) WHERE kind='sent';
CREATE TRIGGER composed_sms_authority_no_update BEFORE UPDATE ON bot_composed_sms_authorities BEGIN SELECT RAISE(ABORT,'Composed authority is immutable'); END;
CREATE TRIGGER composed_sms_authority_no_delete BEFORE DELETE ON bot_composed_sms_authorities BEGIN SELECT RAISE(ABORT,'Composed authority is immutable'); END;
CREATE TRIGGER composed_sms_event_no_update BEFORE UPDATE ON bot_composed_sms_events BEGIN SELECT RAISE(ABORT,'Composed authority event is immutable'); END;
CREATE TRIGGER composed_sms_event_no_delete BEFORE DELETE ON bot_composed_sms_events BEGIN SELECT RAISE(ABORT,'Composed authority event is immutable'); END;
