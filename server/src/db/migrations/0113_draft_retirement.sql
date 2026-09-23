CREATE TABLE bot_message_retirements (
 draft_id TEXT PRIMARY KEY REFERENCES bot_message_drafts(id),
 conversation_id TEXT NOT NULL REFERENCES conversations(id),
 actor_id INTEGER NOT NULL REFERENCES users(id),
 expected_version INTEGER NOT NULL,
 request_key TEXT NOT NULL,
 reason TEXT NOT NULL, evidence TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT (datetime('now')),
 UNIQUE(conversation_id,request_key)
);
CREATE TRIGGER bot_message_retirements_no_update BEFORE UPDATE ON bot_message_retirements BEGIN SELECT RAISE(ABORT,'Retirement audit is immutable'); END;
CREATE TRIGGER bot_message_retirements_no_delete BEFORE DELETE ON bot_message_retirements BEGIN SELECT RAISE(ABORT,'Retirement audit is immutable'); END;
