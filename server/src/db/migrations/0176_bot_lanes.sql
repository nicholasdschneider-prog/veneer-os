-- Per-bot opt-in bot lane: routine, huddle and re-check wakes plus builds a
-- bot requests from coordination run in one internal session beside the human
-- chat. The lane session is an ordinary coordination lane whose thread pairs
-- the bot's human chat with that session, so the existing execution identity,
-- access and viewer rules apply. History is never moved; only new traffic routes.
CREATE TABLE bot_lanes (
  owner_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  thread_id TEXT UNIQUE REFERENCES coordination_threads(id) ON DELETE SET NULL,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- One short line shown in the human chat for an urgent bot message or a lane
-- result the human must see. It links to the lane item; the lane transcript
-- itself never enters the human chat or its context.
CREATE TABLE bot_lane_surfaced (
  id INTEGER PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  lane_conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  thread_id TEXT REFERENCES coordination_threads(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK(kind IN ('urgent','result')),
  source_label TEXT NOT NULL,
  summary TEXT NOT NULL,
  request_key TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  context_delivered_at TEXT,
  UNIQUE(owner_id, request_key)
);
CREATE INDEX bot_lane_surfaced_owner ON bot_lane_surfaced(owner_id, id);
