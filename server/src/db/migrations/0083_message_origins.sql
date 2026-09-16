-- Preserve authenticated non-human prompt authorship through durable queues,
-- runner restarts, and provider-native transcript rehydration. Human prompts
-- keep NULL origin_json, so legacy rows remain ordinary user messages.
ALTER TABLE queued_messages ADD COLUMN origin_json TEXT;
ALTER TABLE pending_turns ADD COLUMN origin_json TEXT;

CREATE TABLE turn_origins (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  turn_id         TEXT NOT NULL,
  prompt_text     TEXT NOT NULL,
  origin_json     TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX turn_origins_conversation ON turn_origins(conversation_id, id);
