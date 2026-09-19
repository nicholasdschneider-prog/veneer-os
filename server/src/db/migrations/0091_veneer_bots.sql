-- Reversible registration; never moves or recreates a provider conversation.
CREATE TABLE bot_registrations (
 conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
 name TEXT NOT NULL,
 active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
 registered_by INTEGER NOT NULL REFERENCES users(id),
 created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE bot_decisions (
 id TEXT PRIMARY KEY,
 conversation_id TEXT NOT NULL REFERENCES bot_registrations(conversation_id),
 source_key TEXT NOT NULL,
 proposal_key TEXT NOT NULL,
 version INTEGER NOT NULL DEFAULT 1,
 state TEXT NOT NULL DEFAULT 'needs_input' CHECK(state IN ('needs_input','decided','action_pending','running','verified_completed','blocked','failed')),
 proposal_json TEXT NOT NULL,
 assignee_id INTEGER NOT NULL REFERENCES users(id),
 answer_json TEXT,
 result_json TEXT,
 parked_json TEXT,
 created_at TEXT NOT NULL DEFAULT (datetime('now')),
 updated_at TEXT NOT NULL DEFAULT (datetime('now')),
 UNIQUE(conversation_id, source_key, proposal_key)
);
CREATE TABLE bot_decision_events (
 id TEXT PRIMARY KEY,
 decision_id TEXT NOT NULL REFERENCES bot_decisions(id),
 version INTEGER NOT NULL,
 kind TEXT NOT NULL,
 actor_id INTEGER NOT NULL REFERENCES users(id),
 actor_conversation_id TEXT,
 payload_json TEXT NOT NULL,
 request_key TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT (datetime('now')),
 UNIQUE(decision_id, request_key)
);
CREATE TRIGGER bot_event_immutable_update BEFORE UPDATE ON bot_decision_events BEGIN SELECT RAISE(ABORT, 'Decision audit is immutable'); END;
CREATE TRIGGER bot_event_immutable_delete BEFORE DELETE ON bot_decision_events BEGIN SELECT RAISE(ABORT, 'Decision audit is immutable'); END;
CREATE TABLE bot_decision_threads (
 id TEXT PRIMARY KEY REFERENCES bot_decision_events(id),
 decision_id TEXT NOT NULL REFERENCES bot_decisions(id),
 actor_id INTEGER NOT NULL REFERENCES users(id),
 actor_conversation_id TEXT,
 text TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE bot_decision_dismissals (
 decision_id TEXT NOT NULL REFERENCES bot_decisions(id),
 user_id INTEGER NOT NULL REFERENCES users(id),
 version INTEGER NOT NULL,
 PRIMARY KEY(decision_id,user_id)
);
CREATE INDEX bot_decisions_owner ON bot_decisions(conversation_id, state);
CREATE INDEX bot_events_decision ON bot_decision_events(decision_id, created_at);
