CREATE TABLE bot_message_drafts (
 id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
 decision_id TEXT REFERENCES bot_decisions(id) ON DELETE CASCADE, decision_version INTEGER,
 version INTEGER NOT NULL DEFAULT 1, request_key TEXT NOT NULL, payload_json TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'draft' CHECK(state IN ('draft','queued','sending','sent','failed','uncertain','discarded')),
 authorized_by INTEGER REFERENCES users(id), receipt TEXT, claim_key TEXT,
 created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
 UNIQUE(conversation_id, request_key)
);
CREATE TABLE bot_message_threads (
 id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
 anchor TEXT NOT NULL, source_text TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')),
 UNIQUE(conversation_id, anchor)
);
CREATE TABLE bot_message_replies (
 seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
 thread_id TEXT NOT NULL REFERENCES bot_message_threads(id) ON DELETE CASCADE,
 actor_id INTEGER NOT NULL REFERENCES users(id), actor_conversation_id TEXT,
 text TEXT NOT NULL, request_key TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')),
 UNIQUE(thread_id, actor_id, request_key)
);
CREATE TABLE bot_message_reactions (
 thread_id TEXT NOT NULL REFERENCES bot_message_threads(id) ON DELETE CASCADE,
 user_id INTEGER NOT NULL REFERENCES users(id), emoji TEXT NOT NULL,
 PRIMARY KEY(thread_id,user_id,emoji)
);
CREATE TABLE bot_message_thread_seen (
 thread_id TEXT NOT NULL REFERENCES bot_message_threads(id) ON DELETE CASCADE,
 user_id INTEGER NOT NULL REFERENCES users(id), seq INTEGER NOT NULL,
 PRIMARY KEY(thread_id,user_id)
);
CREATE TABLE bot_voice_briefings (
 id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
 decision_id TEXT REFERENCES bot_decisions(id) ON DELETE CASCADE, decision_version INTEGER,
 request_key TEXT NOT NULL, transcript TEXT NOT NULL, audio BLOB,
 created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(conversation_id,request_key)
);
CREATE INDEX bot_drafts_conversation ON bot_message_drafts(conversation_id);
CREATE INDEX bot_briefings_conversation ON bot_voice_briefings(conversation_id);
