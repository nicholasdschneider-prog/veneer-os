-- Explicit, immutable decision-owner delegation; never rewrite a human answer.
CREATE TABLE bot_message_delegations (
 id TEXT PRIMARY KEY,
 decision_id TEXT NOT NULL REFERENCES bot_decisions(id), decision_version INTEGER NOT NULL,
 owner_conversation_id TEXT NOT NULL REFERENCES conversations(id),
 executor_conversation_id TEXT NOT NULL REFERENCES conversations(id),
 executor_user_id INTEGER NOT NULL REFERENCES users(id),
 delegator_user_id INTEGER NOT NULL REFERENCES users(id),
 approver_user_id INTEGER NOT NULL REFERENCES users(id),
 approval_event_id TEXT NOT NULL REFERENCES bot_decision_events(id),
 proposal_hash TEXT NOT NULL, payload_hash TEXT NOT NULL, scope_json TEXT NOT NULL,
 request_key TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')),
 UNIQUE(decision_id,decision_version), UNIQUE(owner_conversation_id,request_key)
);
ALTER TABLE bot_message_drafts ADD COLUMN delegation_id TEXT REFERENCES bot_message_delegations(id);
CREATE UNIQUE INDEX bot_draft_delegation_once ON bot_message_drafts(delegation_id) WHERE delegation_id IS NOT NULL;
CREATE TABLE bot_message_delegation_events (
 id TEXT PRIMARY KEY, delegation_id TEXT NOT NULL REFERENCES bot_message_delegations(id),
 actor_id INTEGER NOT NULL REFERENCES users(id), actor_conversation_id TEXT NOT NULL REFERENCES conversations(id),
 kind TEXT NOT NULL CHECK(kind IN ('accepted','revoked','claimed','sent','failed','uncertain')),
 request_key TEXT NOT NULL, payload_json TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(delegation_id,kind,request_key)
);
CREATE TABLE bot_message_delivery_proofs (
 draft_id TEXT PRIMARY KEY REFERENCES bot_message_drafts(id),
 account TEXT NOT NULL, provider TEXT NOT NULL, provider_message_id TEXT NOT NULL,
 proof_json TEXT NOT NULL, UNIQUE(account,provider,provider_message_id)
);
CREATE TRIGGER bot_message_delegations_no_update BEFORE UPDATE ON bot_message_delegations BEGIN SELECT RAISE(ABORT,'Delegation audit is immutable'); END;
CREATE TRIGGER bot_message_delegations_no_delete BEFORE DELETE ON bot_message_delegations BEGIN SELECT RAISE(ABORT,'Delegation audit is immutable'); END;
CREATE TRIGGER bot_message_delegation_events_no_update BEFORE UPDATE ON bot_message_delegation_events BEGIN SELECT RAISE(ABORT,'Delegation audit is immutable'); END;
CREATE TRIGGER bot_message_delegation_events_no_delete BEFORE DELETE ON bot_message_delegation_events BEGIN SELECT RAISE(ABORT,'Delegation audit is immutable'); END;
CREATE TRIGGER bot_message_delivery_proofs_no_update BEFORE UPDATE ON bot_message_delivery_proofs BEGIN SELECT RAISE(ABORT,'Delivery proof is immutable'); END;
CREATE TRIGGER bot_message_delivery_proofs_no_delete BEFORE DELETE ON bot_message_delivery_proofs BEGIN SELECT RAISE(ABORT,'Delivery proof is immutable'); END;
