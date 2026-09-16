-- Composio connectors now use the provider's standard full integration.
-- Keep existing sessions active, but remove obsolete profile metadata.
DELETE FROM settings WHERE key = 'connector_permission_settings';
DELETE FROM connector_permission_changes;
DELETE FROM connector_auth_configs;

DROP TABLE connector_permission_changes;
DROP TABLE connector_auth_configs;

CREATE TABLE user_connectors_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  connector_slug TEXT NOT NULL,
  label TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'connected', 'error')),
  error TEXT,
  config_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  sharing TEXT NOT NULL DEFAULT 'personal' CHECK (sharing IN ('personal', 'shared')),
  scope_mode TEXT NOT NULL DEFAULT 'all' CHECK (scope_mode IN ('all', 'projects'))
);

INSERT INTO user_connectors_new
  (id, user_id, connector_slug, label, status, error, config_json,
   created_at, updated_at, sharing, scope_mode)
SELECT id, user_id, connector_slug, label, status, error,
       CASE
         WHEN json_valid(config_json) THEN json_remove(config_json, '$.permission')
         ELSE config_json
       END,
       created_at, updated_at, sharing, scope_mode
  FROM user_connectors;

DROP TABLE user_connectors;
ALTER TABLE user_connectors_new RENAME TO user_connectors;

CREATE INDEX idx_user_connectors_user ON user_connectors(user_id, status);
CREATE UNIQUE INDEX idx_user_connectors_unique
  ON user_connectors(user_id, connector_slug, COALESCE(label, ''));
