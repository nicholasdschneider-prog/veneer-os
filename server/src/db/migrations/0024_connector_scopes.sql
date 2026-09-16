-- Connector availability and sharing (2026-07-20).
-- Existing installs remain personal and available in every chat. An install in
-- `projects` mode is exposed only in the projects listed in the join table;
-- an empty list intentionally means nowhere (safe when the last project is
-- deleted). Sharing and project scope are independent. Shared installs are
-- usable by every user in all or selected projects, but their credentials
-- remain owned by the user who created the install.
ALTER TABLE user_connectors ADD COLUMN sharing TEXT NOT NULL DEFAULT 'personal'
  CHECK (sharing IN ('personal', 'shared'));
ALTER TABLE user_connectors ADD COLUMN scope_mode TEXT NOT NULL DEFAULT 'all'
  CHECK (scope_mode IN ('all', 'projects'));

CREATE TABLE user_connector_projects (
  connector_id INTEGER NOT NULL REFERENCES user_connectors(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  PRIMARY KEY (connector_id, project_id)
);
CREATE INDEX idx_user_connector_projects_project
  ON user_connector_projects(project_id, connector_id);

-- Platform connector relays need to enforce the same project boundary as the
-- materializer. Bind newly minted per-turn tokens to their conversation while
-- leaving pre-migration tokens valid until their normal expiry.
ALTER TABLE agent_tokens ADD COLUMN conversation_id TEXT
  REFERENCES conversations(id) ON DELETE CASCADE;
