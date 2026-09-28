-- Authenticated composer provenance. No legacy transcript/import backfill.
CREATE TABLE bot_human_messages (
 id TEXT PRIMARY KEY,
 conversation_id TEXT NOT NULL REFERENCES conversations(id),
 actor_id INTEGER NOT NULL REFERENCES users(id),
 text TEXT NOT NULL,
 proposals_json TEXT NOT NULL,
 created_at TEXT NOT NULL
);
CREATE INDEX bot_human_messages_conversation ON bot_human_messages(conversation_id,created_at);
-- One human instruction can answer only one exact proposal. Native events keep the audit.
CREATE TABLE bot_conversational_answers (
 source_kind TEXT NOT NULL CHECK(source_kind IN ('result_reply','direct_message')),
 source_id TEXT NOT NULL,
 decision_id TEXT NOT NULL REFERENCES bot_decisions(id),
 version INTEGER NOT NULL,
 inspection_hash TEXT NOT NULL,
 source_hash TEXT NOT NULL,
 action TEXT NOT NULL,
 event_key TEXT NOT NULL,
 PRIMARY KEY(source_kind,source_id)
);
CREATE TRIGGER bot_human_message_immutable_update BEFORE UPDATE ON bot_human_messages BEGIN SELECT RAISE(ABORT,'Human source is immutable'); END;
CREATE TRIGGER bot_human_message_immutable_delete BEFORE DELETE ON bot_human_messages BEGIN SELECT RAISE(ABORT,'Human source is immutable'); END;
CREATE TRIGGER bot_conversational_answer_immutable_update BEFORE UPDATE ON bot_conversational_answers BEGIN SELECT RAISE(ABORT,'Consent receipt is immutable'); END;
CREATE TRIGGER bot_conversational_answer_immutable_delete BEFORE DELETE ON bot_conversational_answers BEGIN SELECT RAISE(ABORT,'Consent receipt is immutable'); END;
