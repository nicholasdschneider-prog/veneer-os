CREATE TABLE bot_routines (
 id TEXT PRIMARY KEY,
 conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
 created_by INTEGER NOT NULL REFERENCES users(id),
 name TEXT NOT NULL,
 instructions TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('schedule','ticket.created','customer.replied')),
 source TEXT NOT NULL DEFAULT '',
 schedule_json TEXT,
 timezone TEXT NOT NULL DEFAULT 'UTC',
 enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
 next_run_at TEXT,
 created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX bot_routines_due ON bot_routines(enabled,next_run_at);
CREATE TABLE bot_routine_deliveries (
 id TEXT PRIMARY KEY,
 routine_id TEXT NOT NULL REFERENCES bot_routines(id) ON DELETE CASCADE,
 event_id TEXT NOT NULL,
 wakeup_id TEXT NOT NULL REFERENCES conversation_wakeups(id) ON DELETE CASCADE,
 created_at TEXT NOT NULL DEFAULT (datetime('now')),
 UNIQUE(routine_id,event_id)
);
CREATE TABLE bot_event_sources (
 id TEXT PRIMARY KEY,
 team_id TEXT NOT NULL REFERENCES business_teams(id),
 created_by INTEGER NOT NULL REFERENCES users(id),
 name TEXT NOT NULL,
 last_event_at TEXT,
 enabled INTEGER NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE bot_notification_preferences (
 user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
 created_at TEXT NOT NULL DEFAULT (datetime('now')),
 input INTEGER NOT NULL DEFAULT 1,
 blocked INTEGER NOT NULL DEFAULT 1,
 completed INTEGER NOT NULL DEFAULT 0,
 quiet_start TEXT,
 quiet_end TEXT,
 timezone TEXT NOT NULL DEFAULT 'UTC',
 PRIMARY KEY(user_id,conversation_id)
);
CREATE TABLE bot_push_devices (
 id TEXT PRIMARY KEY,
 user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 endpoint_hash TEXT NOT NULL UNIQUE,
 created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE bot_notification_outbox (
 id TEXT PRIMARY KEY,
 device_id TEXT NOT NULL REFERENCES bot_push_devices(id) ON DELETE CASCADE,
 conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
 event_key TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('input','blocked','completed')),
 href TEXT NOT NULL,
 attempts INTEGER NOT NULL DEFAULT 0,
 next_attempt_at TEXT NOT NULL,
 sent_at TEXT,
 abandoned INTEGER NOT NULL DEFAULT 0,
 UNIQUE(device_id,event_key)
);
CREATE INDEX bot_notification_due ON bot_notification_outbox(abandoned,sent_at,next_attempt_at);
CREATE TABLE bot_search_documents (
 id TEXT PRIMARY KEY,
 conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
 kind TEXT NOT NULL,
 body TEXT NOT NULL,
 at TEXT NOT NULL,
 href TEXT NOT NULL
);
CREATE INDEX bot_search_conversation ON bot_search_documents(conversation_id,at);
CREATE VIRTUAL TABLE bot_search_fts USING fts5(body,content='bot_search_documents',content_rowid='rowid',tokenize='unicode61');
CREATE TRIGGER bot_search_insert AFTER INSERT ON bot_search_documents BEGIN
 INSERT INTO bot_search_fts(rowid,body) VALUES(new.rowid,new.body);
END;
CREATE TRIGGER bot_search_delete AFTER DELETE ON bot_search_documents BEGIN
 INSERT INTO bot_search_fts(bot_search_fts,rowid,body) VALUES('delete',old.rowid,old.body);
END;
CREATE TRIGGER bot_search_update AFTER UPDATE ON bot_search_documents BEGIN
 INSERT INTO bot_search_fts(bot_search_fts,rowid,body) VALUES('delete',old.rowid,old.body);
 INSERT INTO bot_search_fts(rowid,body) VALUES(new.rowid,new.body);
END;
CREATE TABLE bot_search_progress (
 conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
 indexed_activity_at TEXT NOT NULL
);
CREATE TABLE bot_templates (
 id TEXT PRIMARY KEY,
 source_conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
 team_id TEXT REFERENCES business_teams(id),
 created_by INTEGER NOT NULL REFERENCES users(id),
 name TEXT NOT NULL,
 config_json TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE bot_teaching_sessions (
 id TEXT PRIMARY KEY,
 conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
 user_id INTEGER NOT NULL REFERENCES users(id),
 name TEXT NOT NULL,
 outcome TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('recording','paused','draft','saved','discarded')),
 started_at TEXT NOT NULL,
 expires_at TEXT NOT NULL,
 steps_json TEXT NOT NULL DEFAULT '[]',
 draft TEXT NOT NULL DEFAULT '',
 skill_name TEXT,
 test_requested_at TEXT
);
CREATE UNIQUE INDEX bot_teaching_active ON bot_teaching_sessions(conversation_id) WHERE state IN ('recording','paused');
