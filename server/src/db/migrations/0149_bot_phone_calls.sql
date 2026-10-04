-- Bot calls phase two: a bot may phone the person instead of ringing in the app.
ALTER TABLE bot_call_settings ADD COLUMN phone TEXT;
ALTER TABLE bot_call_settings ADD COLUMN phone_enabled INTEGER NOT NULL DEFAULT 0 CHECK(phone_enabled IN (0,1));
-- One row per phone call placed. No audio, no transcript: provider id and outcome categories only.
CREATE TABLE bot_phone_calls (
 id TEXT PRIMARY KEY,
 user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 decision_id TEXT REFERENCES bot_decisions(id) ON DELETE SET NULL,
 voice_session_id TEXT,
 provider_sid TEXT,
 status TEXT NOT NULL DEFAULT 'starting',
 answered_by TEXT,
 started_ms INTEGER NOT NULL,
 ended_ms INTEGER
);
CREATE INDEX bot_phone_calls_user ON bot_phone_calls(user_id, started_ms);
