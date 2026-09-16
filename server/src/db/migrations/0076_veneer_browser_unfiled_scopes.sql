-- Browser profiles normally use a real project id as their remote/storage
-- scope. Unfiled chats use a reserved per-user scope instead, so they can
-- share a saved default login without creating a fake visible project.
-- Rebuild the browser tables to remove only the projects(id) foreign keys;
-- all profile, conversation, user, and lifecycle relationships stay intact.
ALTER TABLE veneer_browser_project_settings RENAME TO veneer_browser_project_settings_old;
ALTER TABLE veneer_browser_conversation_profiles RENAME TO veneer_browser_conversation_profiles_old;
ALTER TABLE veneer_browser_sessions RENAME TO veneer_browser_sessions_old;
ALTER TABLE veneer_browser_audit RENAME TO veneer_browser_audit_old;
ALTER TABLE veneer_browser_clone_sessions RENAME TO veneer_browser_clone_sessions_old;
ALTER TABLE veneer_browser_profiles RENAME TO veneer_browser_profiles_old;

DROP INDEX IF EXISTS idx_veneer_browser_profiles_project;
DROP INDEX IF EXISTS idx_veneer_browser_conversation_profile;
DROP INDEX IF EXISTS idx_veneer_browser_sessions_active;
DROP INDEX IF EXISTS idx_veneer_browser_sessions_conversation;
DROP INDEX IF EXISTS idx_veneer_browser_audit_scope;
DROP INDEX IF EXISTS idx_veneer_browser_clone_source;
DROP INDEX IF EXISTS idx_veneer_browser_clone_stale;

CREATE TABLE veneer_browser_profiles (
  id            TEXT PRIMARY KEY,
  client_scope  TEXT NOT NULL,
  project_id    TEXT NOT NULL,
  name          TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 100),
  created_by    INTEGER NOT NULL REFERENCES users(id),
  last_used_at  TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  generation    INTEGER NOT NULL DEFAULT 1 CHECK(generation >= 1),
  UNIQUE(client_scope, project_id, id)
);

CREATE INDEX idx_veneer_browser_profiles_project
  ON veneer_browser_profiles(client_scope, project_id, updated_at DESC);

CREATE TABLE veneer_browser_project_settings (
  client_scope       TEXT NOT NULL,
  project_id         TEXT PRIMARY KEY,
  default_profile_id TEXT REFERENCES veneer_browser_profiles(id) ON DELETE SET NULL,
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE veneer_browser_conversation_profiles (
  conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  client_scope    TEXT NOT NULL,
  project_id      TEXT NOT NULL,
  profile_id      TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(client_scope, project_id, conversation_id),
  FOREIGN KEY (client_scope, project_id, profile_id)
    REFERENCES veneer_browser_profiles(client_scope, project_id, id) ON DELETE CASCADE
);

CREATE INDEX idx_veneer_browser_conversation_profile
  ON veneer_browser_conversation_profiles(client_scope, project_id, profile_id);

CREATE TABLE veneer_browser_sessions (
  profile_id        TEXT PRIMARY KEY,
  client_scope      TEXT NOT NULL,
  project_id        TEXT NOT NULL,
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

CREATE INDEX idx_veneer_browser_sessions_active
  ON veneer_browser_sessions(client_scope, project_id, status, last_used_at DESC);

CREATE INDEX idx_veneer_browser_sessions_conversation
  ON veneer_browser_sessions(client_scope, project_id, conversation_id, status);

CREATE TABLE veneer_browser_audit (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  client_scope    TEXT NOT NULL,
  project_id      TEXT NOT NULL,
  profile_id      TEXT NOT NULL,
  actor_user_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  action          TEXT NOT NULL,
  metadata_json   TEXT NOT NULL DEFAULT '{}',
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_veneer_browser_audit_scope
  ON veneer_browser_audit(client_scope, project_id, profile_id, created_at DESC);

CREATE TABLE veneer_browser_clone_sessions (
  conversation_id   TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  client_scope      TEXT NOT NULL,
  project_id        TEXT NOT NULL,
  source_profile_id TEXT,
  source_generation INTEGER,
  clone_profile_id  TEXT NOT NULL UNIQUE,
  mode              TEXT NOT NULL CHECK(mode IN ('profile', 'fresh')),
  remote_runtime_id TEXT,
  status            TEXT NOT NULL CHECK(status IN ('starting', 'active', 'stopped', 'error')),
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at      TEXT,
  stopped_at        TEXT,
  last_error        TEXT,
  CHECK(
    (mode = 'profile' AND source_profile_id IS NOT NULL AND source_generation IS NOT NULL)
    OR (mode = 'fresh' AND source_profile_id IS NULL AND source_generation IS NULL)
  ),
  FOREIGN KEY (client_scope, project_id, source_profile_id)
    REFERENCES veneer_browser_profiles(client_scope, project_id, id) ON DELETE CASCADE
);

CREATE INDEX idx_veneer_browser_clone_source
  ON veneer_browser_clone_sessions(client_scope, project_id, source_profile_id, status);

CREATE INDEX idx_veneer_browser_clone_stale
  ON veneer_browser_clone_sessions(client_scope, status, last_used_at);

INSERT INTO veneer_browser_profiles
SELECT id, client_scope, project_id, name, created_by, last_used_at,
       created_at, updated_at, generation
FROM veneer_browser_profiles_old;

INSERT INTO veneer_browser_project_settings
SELECT client_scope, project_id, default_profile_id, updated_at
FROM veneer_browser_project_settings_old;

INSERT INTO veneer_browser_conversation_profiles
SELECT conversation_id, client_scope, project_id, profile_id, created_at, updated_at
FROM veneer_browser_conversation_profiles_old;

INSERT INTO veneer_browser_sessions
SELECT profile_id, client_scope, project_id, conversation_id, remote_runtime_id,
       status, started_at, last_used_at, stopped_at, last_error
FROM veneer_browser_sessions_old;

INSERT INTO veneer_browser_audit
SELECT id, client_scope, project_id, profile_id, actor_user_id, conversation_id,
       action, metadata_json, created_at
FROM veneer_browser_audit_old;

INSERT INTO veneer_browser_clone_sessions
SELECT conversation_id, client_scope, project_id, source_profile_id,
       source_generation, clone_profile_id, mode, remote_runtime_id, status,
       created_at, last_used_at, stopped_at, last_error
FROM veneer_browser_clone_sessions_old;

DROP TABLE veneer_browser_clone_sessions_old;
DROP TABLE veneer_browser_audit_old;
DROP TABLE veneer_browser_sessions_old;
DROP TABLE veneer_browser_conversation_profiles_old;
DROP TABLE veneer_browser_project_settings_old;
DROP TABLE veneer_browser_profiles_old;

-- Removing a real project must keep the same local cleanup behavior that its
-- former foreign keys provided. Reserved unfiled scopes are not project rows
-- and therefore survive for reuse by that user's other unfiled chats.
CREATE TRIGGER veneer_browser_delete_project_scope
AFTER DELETE ON projects
BEGIN
  DELETE FROM veneer_browser_clone_sessions WHERE project_id = OLD.id;
  DELETE FROM veneer_browser_audit WHERE project_id = OLD.id;
  DELETE FROM veneer_browser_profiles WHERE project_id = OLD.id;
  DELETE FROM veneer_browser_project_settings WHERE project_id = OLD.id;
END;
