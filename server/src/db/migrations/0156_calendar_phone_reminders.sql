-- Dedicated reminders are disabled. No worker or dialer is registered by this migration.
CREATE TABLE calendar_phone_settings (
 user_id INTEGER PRIMARY KEY REFERENCES users(id),
 manifest_json TEXT NOT NULL,
 manifest_hash TEXT NOT NULL,
 prepared_ms INTEGER NOT NULL
);
-- Permanent occurrence and source-reference fences survive configuration changes.
CREATE TABLE calendar_phone_attempts (
 id TEXT PRIMARY KEY,
 user_id INTEGER NOT NULL REFERENCES users(id),
 occurrence_key TEXT NOT NULL,
 manifest_hash TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('SKIPPED','RESERVED','UNKNOWN','ACCEPTED','ENDED')),
 reason TEXT NOT NULL,
 due_ms INTEGER NOT NULL,
 reserved_ms INTEGER NOT NULL,
 provider_id TEXT,
 UNIQUE(user_id, occurrence_key)
);
CREATE TABLE calendar_phone_refs (
 user_id INTEGER NOT NULL REFERENCES users(id),
 ref TEXT NOT NULL,
 attempt_id TEXT NOT NULL REFERENCES calendar_phone_attempts(id),
 PRIMARY KEY(user_id, ref)
);
-- UNKNOWN retains the global phone lock. No lease expiration or automatic unlock.
CREATE TABLE calendar_phone_lock (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1),
 attempt_id TEXT NOT NULL UNIQUE REFERENCES calendar_phone_attempts(id)
);
