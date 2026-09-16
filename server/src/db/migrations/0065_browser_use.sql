-- First-party Browser Use integration. Profiles belong to one Veneer user and
-- can be selected independently in each project. Remote browser credentials
-- (API key, CDP URL, live-view URL) are intentionally never stored here.

CREATE TABLE browser_use_profiles (
  profile_id          TEXT PRIMARY KEY,
  user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name                TEXT NOT NULL,
  cookie_domains_json TEXT NOT NULL DEFAULT '[]',
  last_used_at        TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_browser_use_profiles_user
  ON browser_use_profiles(user_id, updated_at DESC);

CREATE TABLE browser_use_project_profiles (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  profile_id TEXT NOT NULL REFERENCES browser_use_profiles(profile_id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, project_id)
);

-- One current remote browser per conversation. Starting a later browser
-- replaces the stopped row. The remote service owns the hard timeout; these
-- timestamps let Veneer recover safely after a runner restart.
CREATE TABLE browser_use_sessions (
  conversation_id  TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id       TEXT REFERENCES projects(id) ON DELETE SET NULL,
  remote_session_id TEXT NOT NULL UNIQUE,
  profile_id       TEXT REFERENCES browser_use_profiles(profile_id) ON DELETE SET NULL,
  status           TEXT NOT NULL CHECK (status IN ('active','stopped','error')),
  control_mode     TEXT NOT NULL DEFAULT 'agent' CHECK (control_mode IN ('agent','human')),
  proxy_country_code TEXT,
  timeout_at       TEXT NOT NULL,
  started_at       TEXT NOT NULL,
  last_used_at     TEXT NOT NULL,
  stopped_at       TEXT,
  last_error       TEXT
);
CREATE INDEX idx_browser_use_sessions_user
  ON browser_use_sessions(user_id, status, last_used_at DESC);
