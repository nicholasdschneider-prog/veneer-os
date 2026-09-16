-- Saved browser profiles are reusable login bases. Every chat runs a
-- disposable working copy, including a signed-out copy with no saved base.
ALTER TABLE veneer_browser_profiles
  ADD COLUMN generation INTEGER NOT NULL DEFAULT 1 CHECK(generation >= 1);

DROP INDEX IF EXISTS idx_veneer_browser_clone_source;
DROP INDEX IF EXISTS idx_veneer_browser_clone_stale;

ALTER TABLE veneer_browser_clone_sessions RENAME TO veneer_browser_clone_sessions_old;

CREATE TABLE veneer_browser_clone_sessions (
  conversation_id   TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  client_scope      TEXT NOT NULL,
  project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
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

INSERT INTO veneer_browser_clone_sessions (
  conversation_id, client_scope, project_id, source_profile_id,
  source_generation, clone_profile_id, mode, remote_runtime_id, status,
  created_at, last_used_at, stopped_at, last_error
)
SELECT old.conversation_id, old.client_scope, old.project_id, old.source_profile_id,
       profile.generation, old.clone_profile_id, 'profile', old.remote_runtime_id,
       old.status, old.created_at, old.last_used_at, old.stopped_at, old.last_error
FROM veneer_browser_clone_sessions_old old
JOIN veneer_browser_profiles profile
  ON profile.client_scope = old.client_scope
 AND profile.project_id = old.project_id
 AND profile.id = old.source_profile_id;

DROP TABLE veneer_browser_clone_sessions_old;

CREATE INDEX idx_veneer_browser_clone_source
  ON veneer_browser_clone_sessions(client_scope, project_id, source_profile_id, status);

CREATE INDEX idx_veneer_browser_clone_stale
  ON veneer_browser_clone_sessions(client_scope, status, last_used_at);
