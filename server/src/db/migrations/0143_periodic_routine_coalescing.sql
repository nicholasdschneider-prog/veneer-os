-- Immutable producer provenance for new routine deliveries. NULL is legacy,
-- not permission to infer an event's kind from its prompt.
ALTER TABLE bot_routine_deliveries ADD COLUMN trigger_kind TEXT
  CHECK(trigger_kind IN ('periodic','once','event'));

-- Retain redundant, never-dispatched backup checks and their receipts for audit.
CREATE TABLE bot_routine_coalescing (
  wakeup_id TEXT PRIMARY KEY REFERENCES conversation_wakeups(id),
  retained_wakeup_id TEXT NOT NULL REFERENCES conversation_wakeups(id),
  queued_message_id INTEGER,
  queued_message_json TEXT,
  coalesced_at TEXT NOT NULL DEFAULT (datetime('now'))
);
