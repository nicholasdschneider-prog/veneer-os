-- Grok as a first-class provider (2026-08-12). SQLite CHECK constraints cannot
-- be widened in place, so rebuild conversations with the current complete shape
-- (0027's columns plus everything added by 0033/0035/0044/0053/0075) and the
-- provider list extended with 'grok'. Every index on the table is dropped with
-- it and recreated below, byte-for-byte as its own migration defined it.
--
-- assistants.default_provider still carries 0001's CHECK ('claude','codex').
-- That column is read-only in the app (nothing writes a provider to it, not
-- even for OpenRouter, which shipped in 0023), so it is deliberately left
-- alone rather than rebuilt for a value that can never be stored.
CREATE TABLE conversations_new (
  id TEXT PRIMARY KEY,
  assistant_id INTEGER NOT NULL REFERENCES assistants(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT,
  title_auto INTEGER NOT NULL DEFAULT 1,
  provider TEXT NOT NULL CHECK (provider IN ('claude','openrouter','codex','grok')),
  model TEXT,
  effort TEXT,
  native_session_id TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'web' CHECK (channel IN ('web','email','automation')),
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_active_at TEXT NOT NULL DEFAULT (datetime('now')),
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  last_input_tokens INTEGER,
  files_synced_at TEXT,
  pin_order INTEGER,
  approval_mode TEXT,
  origin_conversation_id TEXT,
  last_user_activity_at TEXT,
  visibility TEXT NOT NULL DEFAULT 'team' CHECK (visibility IN ('team', 'private')),
  instruction_snapshot_json TEXT,
  instruction_snapshot_at TEXT,
  provider_instruction_hash TEXT
);

INSERT INTO conversations_new
  (id, assistant_id, user_id, title, title_auto, provider, model, effort,
   native_session_id, channel, archived, created_at, last_active_at, project_id,
   last_input_tokens, files_synced_at, pin_order, approval_mode,
   origin_conversation_id, last_user_activity_at, visibility,
   instruction_snapshot_json, instruction_snapshot_at, provider_instruction_hash)
SELECT
  id, assistant_id, user_id, title, title_auto, provider, model, effort,
  native_session_id, channel, archived, created_at, last_active_at, project_id,
  last_input_tokens, files_synced_at, pin_order, approval_mode,
  origin_conversation_id, last_user_activity_at, visibility,
  instruction_snapshot_json, instruction_snapshot_at, provider_instruction_hash
FROM conversations;

DROP TABLE conversations;
ALTER TABLE conversations_new RENAME TO conversations;
CREATE INDEX idx_conversations_user ON conversations(user_id, archived, last_active_at DESC);
CREATE INDEX idx_conversations_project ON conversations(project_id, last_active_at DESC);
CREATE INDEX idx_conversations_auto_archive
  ON conversations(user_id, last_user_activity_at)
  WHERE archived = 0 AND pin_order IS NULL;
CREATE INDEX idx_conversations_visibility
  ON conversations(visibility, user_id, archived, last_active_at DESC);

-- Model preferences live as JSON. providerDefaults is the list every provider
-- picker and list_agent_options enumerates, so Grok only becomes visible once
-- its key exists. Add it without disturbing an already-set value.
UPDATE settings
SET value_json = json_set(value_json, '$.providerDefaults.grok', 'grok-4.5')
WHERE key = 'model_prefs'
  AND json_type(value_json, '$.providerDefaults') = 'object'
  AND json_type(value_json, '$.providerDefaults.grok') IS NULL;
