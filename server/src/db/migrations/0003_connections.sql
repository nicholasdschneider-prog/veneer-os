-- Toolbox (spec §5/§11): connections = MCP servers + abilities (skills), each with
-- a per-connection policy. Additive only — no existing table is touched.
-- 'managed_by' gates who may edit (consultant always; owner only 'owner' rows).

CREATE TABLE connections (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('mcp','skill')),
  name TEXT NOT NULL,                  -- user-facing: "Shopify", "NetSuite lookups"
  slug TEXT NOT NULL UNIQUE,           -- mcp server name / abilities dir name
  config_json TEXT NOT NULL,           -- mcp: {transport, command|url, env|headers}; skill: {content}
  policy_json TEXT NOT NULL DEFAULT '{"default":"approve"}',   -- see §11.2
  enabled INTEGER NOT NULL DEFAULT 1,
  managed_by TEXT NOT NULL DEFAULT 'consultant' CHECK (managed_by IN ('consultant','owner')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_connections_enabled ON connections(enabled, kind);
