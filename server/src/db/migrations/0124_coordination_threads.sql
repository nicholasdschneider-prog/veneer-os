-- Execution sessions are separate; authority remains with the original bot.
CREATE TABLE coordination_threads (
 id TEXT PRIMARY KEY,
 left_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
 right_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
 created_at TEXT NOT NULL DEFAULT (datetime('now')),
 UNIQUE(left_id, right_id), CHECK(left_id < right_id)
);
CREATE TABLE coordination_lanes (
 conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
 thread_id TEXT NOT NULL REFERENCES coordination_threads(id) ON DELETE CASCADE,
 owner_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
 UNIQUE(thread_id, owner_id)
);
ALTER TABLE agent_tokens ADD COLUMN execution_conversation_id TEXT;
CREATE TABLE coordination_deliveries (
 conversation_id TEXT NOT NULL REFERENCES coordination_lanes(conversation_id) ON DELETE CASCADE,
 request_key TEXT NOT NULL,
 payload_hash TEXT NOT NULL,
 message_id INTEGER NOT NULL,
 PRIMARY KEY(conversation_id,request_key)
);
-- Never turn an orphaned execution session into an ordinary private side chat.
CREATE TRIGGER coordination_thread_cleanup BEFORE DELETE ON coordination_threads BEGIN
 DELETE FROM conversations WHERE id IN (SELECT conversation_id FROM coordination_lanes WHERE thread_id=OLD.id);
END;
