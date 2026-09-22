-- Grants convey credential use only, never secret retrieval or profile discovery.
CREATE TABLE browser_login_grants (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 profile_id TEXT NOT NULL REFERENCES veneer_browser_profiles(id) ON DELETE CASCADE,
 granted_by INTEGER NOT NULL REFERENCES users(id),
 secret_project TEXT NOT NULL,
 secret_config TEXT NOT NULL,
 secret_name TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('password','totp')),
 origins_json TEXT NOT NULL,
 allow_save INTEGER NOT NULL DEFAULT 0 CHECK(allow_save IN (0,1)),
 created_at TEXT NOT NULL DEFAULT (datetime('now')),
 UNIQUE(conversation_id,profile_id,secret_project,secret_config,secret_name,kind)
);
