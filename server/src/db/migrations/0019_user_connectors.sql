-- Connectors (spec: per-user integrations, e.g. Gmail via Composio, NetSuite
-- custom). The CATALOG of available connectors is code-defined
-- (server/src/connectors/catalog.ts); this table holds one row per user per
-- installed connector. config_json carries secrets (Composio MCP headers /
-- custom settings like API keys) — treated like connections.config_json:
-- never logged, never returned raw over the API.
CREATE TABLE user_connectors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  connector_slug TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'connected', 'error')),
  error TEXT,
  config_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, connector_slug)
);

CREATE INDEX idx_user_connectors_user ON user_connectors(user_id, status);
