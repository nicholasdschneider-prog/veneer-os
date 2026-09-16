-- A busy saved browser profile can be copied into a chat-owned temporary
-- profile. The copy has its own remote profile identity and runtime lease.
-- It is never listed as a saved project profile and is never merged back.
CREATE TABLE veneer_browser_clone_sessions (
  conversation_id   TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  client_scope      TEXT NOT NULL,
  project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_profile_id TEXT NOT NULL,
  clone_profile_id  TEXT NOT NULL UNIQUE,
  remote_runtime_id TEXT,
  status            TEXT NOT NULL CHECK(status IN ('starting', 'active', 'stopped', 'error')),
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at      TEXT,
  stopped_at        TEXT,
  last_error        TEXT,
  FOREIGN KEY (client_scope, project_id, source_profile_id)
    REFERENCES veneer_browser_profiles(client_scope, project_id, id) ON DELETE CASCADE
);

CREATE INDEX idx_veneer_browser_clone_source
  ON veneer_browser_clone_sessions(client_scope, project_id, source_profile_id, status);

CREATE INDEX idx_veneer_browser_clone_stale
  ON veneer_browser_clone_sessions(client_scope, status, last_used_at);
