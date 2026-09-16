-- Versioned connector permission profiles and zero-downtime reauthorization.
-- NULL profile on an existing install deliberately means "Existing access";
-- migrations must never claim a legacy token is read-only.
ALTER TABLE user_connectors ADD COLUMN permission_profile TEXT;
ALTER TABLE user_connectors ADD COLUMN permission_version INTEGER;

CREATE TABLE connector_auth_configs (
  connector_slug TEXT NOT NULL,
  permission_profile TEXT NOT NULL,
  permission_version INTEGER NOT NULL,
  auth_config_id TEXT NOT NULL,
  requested_scopes_json TEXT NOT NULL,
  requested_user_scopes_json TEXT NOT NULL DEFAULT '[]',
  tool_slugs_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (connector_slug, permission_profile, permission_version)
);

CREATE TABLE connector_permission_changes (
  connector_id INTEGER PRIMARY KEY REFERENCES user_connectors(id) ON DELETE CASCADE,
  permission_profile TEXT NOT NULL,
  permission_version INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'error')),
  error TEXT,
  config_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

