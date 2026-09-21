-- Only new, version-bound human discussion messages can become decisions.
-- Historical messages are intentionally not backfilled.
CREATE TABLE bot_discussion_instructions (
  message_id TEXT PRIMARY KEY REFERENCES bot_decision_threads(id),
  version INTEGER NOT NULL,
  handling_revision INTEGER NOT NULL
);
