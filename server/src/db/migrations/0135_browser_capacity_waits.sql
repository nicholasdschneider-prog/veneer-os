-- One bounded, owner/scope-bound continuation per chat, surviving runner restarts.
CREATE TABLE browser_capacity_waits (
 id TEXT PRIMARY KEY,
 conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
 user_id INTEGER NOT NULL REFERENCES users(id),
 client_scope TEXT NOT NULL,
 scope_json TEXT NOT NULL,
 request_key TEXT NOT NULL,
 task TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('waiting','admitting','ready','expired','cancelled','failed')),
 created_at TEXT NOT NULL,
 expires_at TEXT NOT NULL,
 wakeup_id TEXT UNIQUE REFERENCES conversation_wakeups(id),
 UNIQUE(conversation_id,request_key)
);
CREATE UNIQUE INDEX browser_capacity_wait_one ON browser_capacity_waits(conversation_id)
 WHERE status IN ('waiting','admitting');
CREATE INDEX browser_capacity_wait_fifo ON browser_capacity_waits(status,created_at);
