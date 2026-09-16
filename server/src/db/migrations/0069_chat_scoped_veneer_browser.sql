-- A saved profile belongs to a project. Its live runtime is leased to one
-- conversation at a time so parallel chats cannot control the same Chrome.
ALTER TABLE veneer_browser_conversation_profiles RENAME TO veneer_browser_conversation_profiles_old;

CREATE TABLE veneer_browser_conversation_profiles (
  conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  client_scope    TEXT NOT NULL,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  profile_id      TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(client_scope, project_id, conversation_id),
  FOREIGN KEY (client_scope, project_id, profile_id)
    REFERENCES veneer_browser_profiles(client_scope, project_id, id) ON DELETE CASCADE
);

INSERT INTO veneer_browser_conversation_profiles
  (conversation_id, client_scope, project_id, profile_id, created_at, updated_at)
SELECT old.conversation_id, profile.client_scope, profile.project_id, old.profile_id,
       old.updated_at, old.updated_at
FROM veneer_browser_conversation_profiles_old old
JOIN veneer_browser_profiles profile ON profile.id = old.profile_id
JOIN conversations conversation ON conversation.id = old.conversation_id
WHERE conversation.project_id = profile.project_id;

DROP TABLE veneer_browser_conversation_profiles_old;

CREATE INDEX idx_veneer_browser_conversation_profile
  ON veneer_browser_conversation_profiles(client_scope, project_id, profile_id);

ALTER TABLE veneer_browser_sessions RENAME TO veneer_browser_sessions_old;

CREATE TABLE veneer_browser_sessions (
  profile_id        TEXT PRIMARY KEY,
  client_scope      TEXT NOT NULL,
  project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  conversation_id   TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  remote_runtime_id TEXT,
  status            TEXT NOT NULL CHECK(status IN ('starting', 'active', 'stopped', 'error')),
  started_at        TEXT,
  last_used_at      TEXT,
  stopped_at        TEXT,
  last_error        TEXT,
  FOREIGN KEY (client_scope, project_id, profile_id)
    REFERENCES veneer_browser_profiles(client_scope, project_id, id) ON DELETE CASCADE
);

INSERT INTO veneer_browser_sessions
  (profile_id, client_scope, project_id, remote_runtime_id, status,
   started_at, last_used_at, stopped_at, last_error)
SELECT profile_id, client_scope, project_id, remote_runtime_id, status,
       started_at, last_used_at, stopped_at, last_error
FROM veneer_browser_sessions_old;

DROP TABLE veneer_browser_sessions_old;

CREATE INDEX idx_veneer_browser_sessions_active
  ON veneer_browser_sessions(client_scope, project_id, status, last_used_at DESC);

CREATE INDEX idx_veneer_browser_sessions_conversation
  ON veneer_browser_sessions(client_scope, project_id, conversation_id, status);
