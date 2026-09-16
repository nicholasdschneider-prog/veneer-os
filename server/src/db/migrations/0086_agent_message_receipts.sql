-- Keep sender-side agent handoffs traceable without trusting provider-rendered
-- tool output. The target queue id becomes the deep-link anchor once the
-- receiving chat starts that message.
ALTER TABLE turn_origins ADD COLUMN message_id INTEGER;

CREATE TABLE agent_message_receipts (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  source_conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  target_conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  message_id             INTEGER NOT NULL,
  message_text           TEXT NOT NULL,
  disposition            TEXT NOT NULL CHECK (disposition IN ('running', 'steered', 'queued', 'duplicate')),
  created_at             TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (source_conversation_id, message_id)
);

CREATE INDEX agent_message_receipts_source
  ON agent_message_receipts(source_conversation_id, id);
