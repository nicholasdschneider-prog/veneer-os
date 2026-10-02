-- One owner-level bot per owner. The designation grants reach (a read-only
-- view of other bots' open questions), never business authority or approvals.
CREATE TABLE chief_of_staff_bots (
 conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
 owner_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
 created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE chief_of_staff_audit (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 conversation_id TEXT NOT NULL,
 owner_id INTEGER NOT NULL,
 actor_id INTEGER NOT NULL,
 actor_chat TEXT,
 action TEXT NOT NULL CHECK(action IN ('granted','revoked')),
 created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
