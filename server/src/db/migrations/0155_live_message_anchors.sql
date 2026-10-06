-- A reply delivered over the live stream is identified by its runtime turn id and emit time; the
-- provider transcript later identifies the same reply differently. Remember what was streamed so a
-- page that has not reloaded can still address it (Listen, replies, reactions).
CREATE TABLE live_message_anchors (
 conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
 turn_id TEXT NOT NULL, at TEXT NOT NULL, markdown TEXT NOT NULL,
 canonical_anchor TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')),
 PRIMARY KEY (conversation_id, turn_id, at)
);
CREATE INDEX live_message_anchors_created ON live_message_anchors(created_at);
