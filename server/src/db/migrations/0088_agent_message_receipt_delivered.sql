-- Steering a busy Claude turn now reports 'delivered': the line reached the live
-- process but its replay acknowledgement is still outstanding. Rebuild the table
-- so the receipt CHECK accepts it (SQLite cannot alter a CHECK in place).
CREATE TABLE agent_message_receipts_new (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  source_conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  target_conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  message_id             INTEGER NOT NULL,
  message_text           TEXT NOT NULL,
  disposition            TEXT NOT NULL CHECK (disposition IN ('running', 'steered', 'delivered', 'queued', 'duplicate')),
  created_at             TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (source_conversation_id, message_id)
);

INSERT INTO agent_message_receipts_new
  (id, source_conversation_id, target_conversation_id, message_id, message_text, disposition, created_at)
SELECT
  id, source_conversation_id, target_conversation_id, message_id, message_text, disposition, created_at
FROM agent_message_receipts;

DROP TABLE agent_message_receipts;
ALTER TABLE agent_message_receipts_new RENAME TO agent_message_receipts;
CREATE INDEX agent_message_receipts_source
  ON agent_message_receipts(source_conversation_id, id);
