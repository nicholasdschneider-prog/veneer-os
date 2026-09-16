-- Multi-account connectors: a user may connect the same connector more than
-- once (e.g. Gmail "Work" and "Personal"), each install labeled and
-- materialized as its own MCP server. SQLite can't DROP a UNIQUE table
-- constraint, so rebuild user_connectors (0019 shape) without the
-- UNIQUE(user_id, connector_slug) constraint and with a new `label` column.
-- The FK enforcement toggle + row copy follow the runner's table-rebuild
-- pattern (see migrate.ts). Existing rows keep their ids and get label NULL.
CREATE TABLE user_connectors_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  connector_slug TEXT NOT NULL,
  -- User-chosen name for this install ("Work", "Personal"). NULL = the
  -- unlabeled first/legacy install; its MCP name/mention is the bare slug.
  label TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'connected', 'error')),
  error TEXT,
  config_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO user_connectors_new (id, user_id, connector_slug, label, status, error, config_json, created_at, updated_at)
  SELECT id, user_id, connector_slug, NULL, status, error, config_json, created_at, updated_at
  FROM user_connectors;

DROP TABLE user_connectors;
ALTER TABLE user_connectors_new RENAME TO user_connectors;

CREATE INDEX idx_user_connectors_user ON user_connectors(user_id, status);
-- One install per (user, connector, label); unlabeled installs collapse to ''
-- so a user still gets at most one unlabeled install per connector.
CREATE UNIQUE INDEX idx_user_connectors_unique ON user_connectors(user_id, connector_slug, COALESCE(label, ''));
