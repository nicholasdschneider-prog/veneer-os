-- A registered bot can show its human one scheduled multi-line digest from
-- the bot lane. Each surfaced row is the durable receipt of what was shown.
-- Rebuild only to widen the kind CHECK; ids, keys and delivery marks are kept.
CREATE TABLE bot_lane_surfaced_new (
  id INTEGER PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  lane_conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  thread_id TEXT REFERENCES coordination_threads(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK(kind IN ('urgent','result','digest')),
  source_label TEXT NOT NULL,
  summary TEXT NOT NULL,
  request_key TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  context_delivered_at TEXT,
  UNIQUE(owner_id, request_key)
);
INSERT INTO bot_lane_surfaced_new(id,owner_id,lane_conversation_id,thread_id,kind,source_label,summary,request_key,created_at,context_delivered_at)
  SELECT id,owner_id,lane_conversation_id,thread_id,kind,source_label,summary,request_key,created_at,context_delivered_at FROM bot_lane_surfaced;
DROP TABLE bot_lane_surfaced;
ALTER TABLE bot_lane_surfaced_new RENAME TO bot_lane_surfaced;
CREATE INDEX bot_lane_surfaced_owner ON bot_lane_surfaced(owner_id, id);
