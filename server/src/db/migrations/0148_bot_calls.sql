-- Bot calls: personal ring preferences and ring state. Never a decision or business authorization.
CREATE TABLE bot_call_settings (
 user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 dnd INTEGER NOT NULL DEFAULT 0 CHECK(dnd IN (0,1)),
 window_start TEXT NOT NULL DEFAULT '08:00',
 window_end TEXT NOT NULL DEFAULT '18:00',
 timezone TEXT NOT NULL DEFAULT 'America/New_York',
 -- Last real input in an open Veneer tab, and the end of the last ring.
 active_ms INTEGER NOT NULL DEFAULT 0,
 idle_ms INTEGER NOT NULL DEFAULT 0
);
-- A bot may call a person only after that person turns it on.
CREATE TABLE bot_call_bots (
 user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
 enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
 PRIMARY KEY(user_id, conversation_id)
);
CREATE TABLE bot_call_rings (
 user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 decision_id TEXT NOT NULL REFERENCES bot_decisions(id) ON DELETE CASCADE,
 state TEXT NOT NULL CHECK(state IN ('ringing','missed','answered','stopped')),
 attempts INTEGER NOT NULL DEFAULT 0,
 ring_started_ms INTEGER NOT NULL DEFAULT 0,
 next_attempt_ms INTEGER NOT NULL DEFAULT 0,
 pushed INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(user_id, decision_id)
);
-- At most one ring per person at a time, across tabs and devices.
CREATE UNIQUE INDEX bot_call_one_ring ON bot_call_rings(user_id) WHERE state='ringing';
ALTER TABLE voice_sessions ADD COLUMN end_reason TEXT;
