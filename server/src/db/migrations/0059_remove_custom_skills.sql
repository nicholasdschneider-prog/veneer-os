-- Connections now contain MCP servers only. Preserve every MCP row and remove
-- the retired database-managed skill rows and their discriminator column.
CREATE TABLE connections_new (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  config_json TEXT NOT NULL,
  policy_json TEXT NOT NULL DEFAULT '{"default":"approve"}',
  enabled INTEGER NOT NULL DEFAULT 1,
  managed_by TEXT NOT NULL DEFAULT 'consultant' CHECK (managed_by IN ('consultant','owner')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO connections_new
  (id, name, slug, config_json, policy_json, enabled, managed_by, created_at)
SELECT id, name, slug, config_json, policy_json, enabled, managed_by, created_at
FROM connections
WHERE kind = 'mcp';

DROP TABLE connections;
ALTER TABLE connections_new RENAME TO connections;

CREATE INDEX idx_connections_enabled ON connections(enabled);
