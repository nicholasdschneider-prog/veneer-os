-- Supplemental intent review, NEVER an authorization or a replacement consent receipt.
CREATE TABLE bot_instruction_obligations (
 id TEXT PRIMARY KEY,
 owner_id TEXT NOT NULL REFERENCES conversations(id),
 source_id TEXT NOT NULL REFERENCES bot_human_messages(id),
 draft_id TEXT NOT NULL REFERENCES bot_message_drafts(id),
 request_key TEXT NOT NULL,
 request_hash TEXT NOT NULL,
 snapshot_json TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 UNIQUE(owner_id,request_key), UNIQUE(source_id,draft_id)
);
CREATE TABLE bot_instruction_obligation_revocations (
 obligation_id TEXT PRIMARY KEY REFERENCES bot_instruction_obligations(id),
 actor_id INTEGER NOT NULL REFERENCES users(id),
 actor_conversation_id TEXT NOT NULL REFERENCES conversations(id),
 reason TEXT NOT NULL, request_key TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TRIGGER instruction_obligation_no_update BEFORE UPDATE ON bot_instruction_obligations BEGIN SELECT RAISE(ABORT,'Obligation evidence is immutable'); END;
CREATE TRIGGER instruction_obligation_no_delete BEFORE DELETE ON bot_instruction_obligations BEGIN SELECT RAISE(ABORT,'Obligation evidence is immutable'); END;
CREATE TRIGGER instruction_obligation_revocation_no_update BEFORE UPDATE ON bot_instruction_obligation_revocations BEGIN SELECT RAISE(ABORT,'Obligation revocation is immutable'); END;
CREATE TRIGGER instruction_obligation_revocation_no_delete BEFORE DELETE ON bot_instruction_obligation_revocations BEGIN SELECT RAISE(ABORT,'Obligation revocation is immutable'); END;
