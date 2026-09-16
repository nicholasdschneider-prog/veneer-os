-- First-party browser profiles. The remote manager repeats this scope check
-- with the authenticated machine identity before it touches profile storage.
CREATE TABLE veneer_browser_profiles (
  id            TEXT PRIMARY KEY,
  client_scope  TEXT NOT NULL,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name          TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 100),
  created_by    INTEGER NOT NULL REFERENCES users(id),
  last_used_at  TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(client_scope, project_id, id)
);

CREATE INDEX idx_veneer_browser_profiles_project
  ON veneer_browser_profiles(client_scope, project_id, updated_at DESC);

CREATE TABLE veneer_browser_project_settings (
  client_scope       TEXT NOT NULL,
  project_id         TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  default_profile_id TEXT REFERENCES veneer_browser_profiles(id) ON DELETE SET NULL,
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE veneer_browser_conversation_profiles (
  conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  profile_id      TEXT NOT NULL REFERENCES veneer_browser_profiles(id) ON DELETE CASCADE,
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE veneer_browser_sessions (
  profile_id        TEXT PRIMARY KEY REFERENCES veneer_browser_profiles(id) ON DELETE CASCADE,
  client_scope      TEXT NOT NULL,
  project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  remote_runtime_id TEXT,
  status            TEXT NOT NULL CHECK(status IN ('starting', 'active', 'stopped', 'error')),
  started_at        TEXT,
  last_used_at      TEXT,
  stopped_at        TEXT,
  last_error        TEXT
);

CREATE INDEX idx_veneer_browser_sessions_active
  ON veneer_browser_sessions(client_scope, project_id, status, last_used_at DESC);

-- Audit records contain action metadata only. They never contain URLs, page
-- text, clipboard data, cookies, credentials, or downloaded file contents.
CREATE TABLE veneer_browser_audit (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  client_scope    TEXT NOT NULL,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  profile_id      TEXT NOT NULL,
  actor_user_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  action          TEXT NOT NULL,
  metadata_json   TEXT NOT NULL DEFAULT '{}',
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_veneer_browser_audit_scope
  ON veneer_browser_audit(client_scope, project_id, profile_id, created_at DESC);
