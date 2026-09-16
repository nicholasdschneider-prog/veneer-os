-- Durable message queue (2026-07-05). Messages that arrive mid-turn queue
-- behind the in-flight turn (spec §8). That queue used to live only in memory,
-- so a restart / ship / crash silently dropped anything waiting. A row is
-- written on enqueue and deleted the moment the message is shifted into a turn,
-- so a surviving row is a still-waiting message the manager re-enqueues at boot
-- (AFTER any interrupted turn resumes). `id` orders replay FIFO.
CREATE TABLE queued_messages (
  id              INTEGER PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  prompt          TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_queued_messages_conversation ON queued_messages(conversation_id, id);
