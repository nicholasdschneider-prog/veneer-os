-- Add a small, provider-neutral access-mode snapshot to connector installs.
-- Existing rows remain NULL and continue to use their current connection.
ALTER TABLE user_connectors
  ADD COLUMN access_mode TEXT CHECK (access_mode IN ('read_only', 'full'));

ALTER TABLE user_connectors
  ADD COLUMN access_version INTEGER CHECK (access_version IS NULL OR access_version > 0);

-- One managed-auth config for each immutable Composio access snapshot.
CREATE TABLE connector_auth_configs (
  connector_slug TEXT NOT NULL,
  access_mode TEXT NOT NULL CHECK (access_mode IN ('read_only', 'full')),
  access_version INTEGER NOT NULL CHECK (access_version > 0),
  auth_config_id TEXT NOT NULL UNIQUE,
  toolkit_version TEXT NOT NULL,
  oauth_scopes_json TEXT NOT NULL,
  tool_slugs_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (connector_slug, access_mode, access_version)
);

-- A mode change has its own connection until sign-in succeeds. This keeps the
-- current connector active if the replacement fails or is cancelled.
CREATE TABLE connector_access_changes (
  connector_id INTEGER PRIMARY KEY REFERENCES user_connectors(id) ON DELETE CASCADE,
  access_mode TEXT NOT NULL CHECK (access_mode IN ('read_only', 'full')),
  access_version INTEGER NOT NULL CHECK (access_version > 0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'error')),
  error TEXT,
  config_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
