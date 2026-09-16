-- Veneer Pro prototype schema (spec §5 subset: users, assistants, conversations, settings)

CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner','member','consultant')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE assistants (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  instructions TEXT NOT NULL DEFAULT '',
  default_provider TEXT NOT NULL DEFAULT 'claude' CHECK (default_provider IN ('claude','codex')),
  default_model TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  assistant_id INTEGER NOT NULL REFERENCES assistants(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT,
  provider TEXT NOT NULL CHECK (provider IN ('claude','codex')),
  model TEXT,
  native_session_id TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'web' CHECK (channel IN ('web','email','automation')),
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_active_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_conversations_user ON conversations(user_id, archived, last_active_at DESC);

CREATE TABLE settings ( key TEXT PRIMARY KEY, value_json TEXT NOT NULL );

INSERT INTO assistants (slug, name) VALUES ('assistant', 'Assistant');
