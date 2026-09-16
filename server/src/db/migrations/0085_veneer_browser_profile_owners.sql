-- A saved browser profile carries a live signed-in session, so it belongs to
-- the person who saved it rather than to everyone in the project. Profiles gain
-- an explicit owner, and the project default becomes a per-user default: two
-- people in one project must never see, attach, or inherit each other's logins.
--
-- Adding a NOT NULL owner column and re-keying the settings table both need the
-- SQLite table-rebuild pattern, and renaming the profiles table rewrites every
-- reference to it, so the tables that point at it are rebuilt alongside. The
-- project-delete trigger is dropped first for the same reason and recreated
-- unchanged at the end. Foreign keys are already off around each migration.
DROP TRIGGER IF EXISTS veneer_browser_delete_project_scope;

ALTER TABLE veneer_browser_project_settings RENAME TO veneer_browser_project_settings_old;
ALTER TABLE veneer_browser_conversation_profiles RENAME TO veneer_browser_conversation_profiles_old;
ALTER TABLE veneer_browser_sessions RENAME TO veneer_browser_sessions_old;
ALTER TABLE veneer_browser_clone_sessions RENAME TO veneer_browser_clone_sessions_old;
ALTER TABLE veneer_browser_profiles RENAME TO veneer_browser_profiles_old;

DROP INDEX IF EXISTS idx_veneer_browser_profiles_project;
DROP INDEX IF EXISTS idx_veneer_browser_conversation_profile;
DROP INDEX IF EXISTS idx_veneer_browser_sessions_active;
DROP INDEX IF EXISTS idx_veneer_browser_sessions_conversation;
DROP INDEX IF EXISTS idx_veneer_browser_clone_source;
DROP INDEX IF EXISTS idx_veneer_browser_clone_stale;

CREATE TABLE veneer_browser_profiles (
  id            TEXT PRIMARY KEY,
  client_scope  TEXT NOT NULL,
  project_id    TEXT NOT NULL,
  name          TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 100),
  created_by    INTEGER NOT NULL REFERENCES users(id),
  owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_used_at  TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  generation    INTEGER NOT NULL DEFAULT 1 CHECK(generation >= 1),
  UNIQUE(client_scope, project_id, id)
);

CREATE INDEX idx_veneer_browser_profiles_project
  ON veneer_browser_profiles(client_scope, project_id, updated_at DESC);

CREATE INDEX idx_veneer_browser_profiles_owner
  ON veneer_browser_profiles(client_scope, project_id, owner_user_id);

CREATE TABLE veneer_browser_project_settings (
  client_scope       TEXT NOT NULL,
  project_id         TEXT NOT NULL,
  user_id            INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  default_profile_id TEXT REFERENCES veneer_browser_profiles(id) ON DELETE SET NULL,
  updated_at         TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (client_scope, project_id, user_id)
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

-- Whoever created a profile is its owner; nothing else recorded a person.
INSERT INTO veneer_browser_profiles
  (id, client_scope, project_id, name, created_by, owner_user_id, last_used_at,
   created_at, updated_at, generation)
SELECT id, client_scope, project_id, name, created_by, created_by, last_used_at,
       created_at, updated_at, generation
FROM veneer_browser_profiles_old;

-- The project-wide default becomes the personal default of the person who owns
-- the profile it pointed at. A settings row pointing nowhere named no person,
-- so it carries no default forward and each user picks their own.
INSERT INTO veneer_browser_project_settings
  (client_scope, project_id, user_id, default_profile_id, updated_at)
SELECT settings.client_scope, settings.project_id, profile.created_by,
       settings.default_profile_id, settings.updated_at
FROM veneer_browser_project_settings_old settings
JOIN veneer_browser_profiles_old profile ON profile.id = settings.default_profile_id;

INSERT INTO veneer_browser_conversation_profiles
SELECT conversation_id, client_scope, project_id, profile_id, created_at, updated_at
FROM veneer_browser_conversation_profiles_old;

INSERT INTO veneer_browser_sessions
SELECT profile_id, client_scope, project_id, conversation_id, remote_runtime_id,
       status, started_at, last_used_at, stopped_at, last_error
FROM veneer_browser_sessions_old;

INSERT INTO veneer_browser_clone_sessions
SELECT conversation_id, client_scope, project_id, source_profile_id,
       source_generation, clone_profile_id, mode, remote_runtime_id, status,
       created_at, last_used_at, stopped_at, last_error
FROM veneer_browser_clone_sessions_old;

DROP TABLE veneer_browser_clone_sessions_old;
DROP TABLE veneer_browser_sessions_old;
DROP TABLE veneer_browser_conversation_profiles_old;
DROP TABLE veneer_browser_project_settings_old;
DROP TABLE veneer_browser_profiles_old;

CREATE TRIGGER veneer_browser_delete_project_scope
AFTER DELETE ON projects
BEGIN
  DELETE FROM veneer_browser_clone_sessions WHERE project_id = OLD.id;
  DELETE FROM veneer_browser_audit WHERE project_id = OLD.id;
  DELETE FROM veneer_browser_profiles WHERE project_id = OLD.id;
  DELETE FROM veneer_browser_project_settings WHERE project_id = OLD.id;
END;
