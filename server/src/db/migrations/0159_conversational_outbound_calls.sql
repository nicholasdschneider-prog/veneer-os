ALTER TABLE bot_phone_calls ADD COLUMN to_phone TEXT;
CREATE TABLE phone_call_locks (
 phone TEXT PRIMARY KEY,
 user_id INTEGER NOT NULL UNIQUE REFERENCES users(id),
 log_id TEXT NOT NULL UNIQUE REFERENCES bot_phone_calls(id),
 phase TEXT NOT NULL CHECK(phase IN ('RESERVED','UNKNOWN','ACCEPTED'))
);
CREATE TABLE bot_outbound_policy (
 user_id INTEGER NOT NULL REFERENCES users(id),
 conversation_id TEXT NOT NULL REFERENCES conversations(id),
 enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
 PRIMARY KEY(user_id,conversation_id)
);
CREATE TABLE bot_outbound_requests (
 id TEXT PRIMARY KEY,
 user_id INTEGER NOT NULL REFERENCES users(id),
 conversation_id TEXT NOT NULL REFERENCES conversations(id),
 request_key TEXT NOT NULL,
 purpose_key TEXT NOT NULL,
 payload_hash TEXT NOT NULL,
 reason TEXT NOT NULL,
 log_id TEXT NOT NULL REFERENCES bot_phone_calls(id),
 state TEXT NOT NULL CHECK(state IN ('RESERVED','UNKNOWN','STARTED')),
 UNIQUE(user_id,conversation_id,request_key),
 UNIQUE(user_id,conversation_id,purpose_key)
);
ALTER TABLE calendar_phone_settings ADD COLUMN enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1));
ALTER TABLE calendar_phone_settings ADD COLUMN source_pins_json TEXT;
