-- 0083 was briefly applied without event_at before its committed version added
-- the column. Repair already-migrated databases with a forward-only migration
-- and preserve any origin rows recorded during that window.
CREATE TABLE turn_origins_new (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  turn_id         TEXT NOT NULL,
  prompt_text     TEXT NOT NULL,
  event_at        TEXT NOT NULL,
  origin_json     TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO turn_origins_new
  (id, conversation_id, turn_id, prompt_text, event_at, origin_json, created_at)
SELECT
  id, conversation_id, turn_id, prompt_text, created_at, origin_json, created_at
FROM turn_origins;

DROP TABLE turn_origins;
ALTER TABLE turn_origins_new RENAME TO turn_origins;
CREATE INDEX turn_origins_conversation ON turn_origins(conversation_id, id);
