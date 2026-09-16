-- Consolidate the experimental comparison providers into one canonical
-- `codex` provider backed by Codex App Server. Both integrations persisted
-- native Codex thread ids, so existing conversations remain resumable.

CREATE TABLE conversations_new (
  id TEXT PRIMARY KEY,
  assistant_id INTEGER NOT NULL REFERENCES assistants(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT,
  title_auto INTEGER NOT NULL DEFAULT 1,
  provider TEXT NOT NULL CHECK (provider IN ('claude','openrouter','codex')),
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
  pin_order INTEGER
);

INSERT INTO conversations_new
  (id, assistant_id, user_id, title, title_auto, provider, model, effort,
   native_session_id, channel, archived, created_at, last_active_at, project_id,
   last_input_tokens, files_synced_at, pin_order)
SELECT
  id, assistant_id, user_id, title, title_auto,
  CASE provider WHEN 'codex-app-server' THEN 'codex' ELSE provider END,
  model, effort, native_session_id, channel, archived, created_at,
  last_active_at, project_id, last_input_tokens, files_synced_at, pin_order
FROM conversations;

DROP TABLE conversations;
ALTER TABLE conversations_new RENAME TO conversations;
CREATE INDEX idx_conversations_user ON conversations(user_id, archived, last_active_at DESC);
CREATE INDEX idx_conversations_project ON conversations(project_id, last_active_at DESC);

-- Scheduled tasks copy their provider rather than referencing conversations.
UPDATE scheduled_tasks SET provider = 'codex' WHERE provider = 'codex-app-server';

-- Model preferences live as JSON. Preserve the former App Server choices as
-- the canonical Codex defaults/order, remove the obsolete duplicate keys, then
-- normalize remaining provider values (global default, per-agent overrides,
-- legacy defaultModel, and hidden-model keys).
UPDATE settings
SET value_json = json_set(
  value_json,
  '$.providerDefaults.codex', json_extract(value_json, '$.providerDefaults."codex-app-server"')
)
WHERE key = 'model_prefs'
  AND json_type(value_json, '$.providerDefaults."codex-app-server"') IS NOT NULL;

UPDATE settings
SET value_json = json_set(
  value_json,
  '$.modelOrder.codex', json_extract(value_json, '$.modelOrder."codex-app-server"')
)
WHERE key = 'model_prefs'
  AND json_type(value_json, '$.modelOrder."codex-app-server"') IS NOT NULL;

UPDATE settings
SET value_json = replace(
  json_remove(
    value_json,
    '$.providerDefaults."codex-app-server"',
    '$.modelOrder."codex-app-server"'
  ),
  'codex-app-server',
  'codex'
)
WHERE key = 'model_prefs' AND value_json LIKE '%codex-app-server%';

UPDATE settings
SET value_json = json_set(
  value_json,
  '$.hiddenModels',
  json((
    SELECT json_group_array(value)
    FROM (SELECT DISTINCT value FROM json_each(settings.value_json, '$.hiddenModels'))
  ))
)
WHERE key = 'model_prefs' AND json_type(value_json, '$.hiddenModels') = 'array';
