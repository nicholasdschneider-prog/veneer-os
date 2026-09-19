CREATE TABLE business_teams (
 id TEXT PRIMARY KEY,
 name TEXT NOT NULL,
 owner_id INTEGER NOT NULL REFERENCES users(id),
 revision INTEGER NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL DEFAULT (datetime('now')),
 UNIQUE(owner_id,name)
);
CREATE TABLE business_team_members (
 team_id TEXT NOT NULL REFERENCES business_teams(id),
 user_id INTEGER NOT NULL REFERENCES users(id),
 role TEXT NOT NULL CHECK(role IN ('viewer','member','manager')),
 PRIMARY KEY(team_id,user_id)
);
ALTER TABLE conversations ADD COLUMN business_team_id TEXT REFERENCES business_teams(id);
CREATE INDEX conversations_business_team ON conversations(business_team_id);
CREATE TABLE business_bot_members (
 conversation_id TEXT PRIMARY KEY REFERENCES conversations(id),
 team_id TEXT NOT NULL REFERENCES business_teams(id),
 role TEXT NOT NULL CHECK(role IN ('coordinator','lead','bot')),
 subteam TEXT NOT NULL DEFAULT '',
 reports_to TEXT REFERENCES conversations(id),
 prior_registration_json TEXT
);
CREATE UNIQUE INDEX business_one_coordinator ON business_bot_members(team_id) WHERE role='coordinator';
CREATE TABLE business_delegations (
 team_id TEXT NOT NULL REFERENCES business_teams(id),
 conversation_id TEXT NOT NULL REFERENCES conversations(id),
 allowed_ids_json TEXT NOT NULL,
 active INTEGER NOT NULL DEFAULT 1,
 revision INTEGER NOT NULL DEFAULT 1,
 PRIMARY KEY(team_id,conversation_id)
);
CREATE TABLE business_previews (
 id TEXT PRIMARY KEY,
 team_id TEXT NOT NULL REFERENCES business_teams(id),
 actor_id INTEGER NOT NULL REFERENCES users(id),
 actor_chat TEXT NOT NULL DEFAULT '',
 request_key TEXT NOT NULL,
 payload_json TEXT NOT NULL,
 fingerprint TEXT NOT NULL,
 applied_at TEXT,
 receipt_json TEXT,
 created_at TEXT NOT NULL DEFAULT (datetime('now')),
 UNIQUE(actor_id,actor_chat,request_key)
);
CREATE TABLE business_audit (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 team_id TEXT NOT NULL REFERENCES business_teams(id),
 actor_id INTEGER NOT NULL REFERENCES users(id),
 actor_chat TEXT,
 action TEXT NOT NULL,
 payload_json TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TRIGGER business_audit_no_update BEFORE UPDATE ON business_audit BEGIN SELECT RAISE(ABORT,'Business audit is immutable'); END;
CREATE TRIGGER business_audit_no_delete BEFORE DELETE ON business_audit BEGIN SELECT RAISE(ABORT,'Business audit is immutable'); END;
