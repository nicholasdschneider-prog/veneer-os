CREATE TABLE bot_decision_handoffs (
 id TEXT PRIMARY KEY REFERENCES bot_decision_events(id),
 decision_id TEXT NOT NULL REFERENCES bot_decisions(id),
 version INTEGER NOT NULL,
 requester_id INTEGER NOT NULL REFERENCES users(id),
 target_id TEXT NOT NULL REFERENCES conversations(id),
 target_label TEXT NOT NULL,
 request_key TEXT NOT NULL,
 request_text TEXT NOT NULL,
 context_json TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT (datetime('now')),
 UNIQUE(decision_id, requester_id, request_key)
);
CREATE TABLE bot_decision_handoff_results (
 handoff_id TEXT PRIMARY KEY REFERENCES bot_decision_handoffs(id),
 event_id TEXT NOT NULL REFERENCES bot_decision_events(id),
 request_key TEXT NOT NULL,
 text TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX bot_handoffs_decision ON bot_decision_handoffs(decision_id);
CREATE TRIGGER bot_handoff_immutable_update BEFORE UPDATE ON bot_decision_handoffs BEGIN SELECT RAISE(ABORT,'Investigation request is immutable'); END;
CREATE TRIGGER bot_handoff_immutable_delete BEFORE DELETE ON bot_decision_handoffs BEGIN SELECT RAISE(ABORT,'Investigation request is immutable'); END;
CREATE TRIGGER bot_handoff_result_immutable_update BEFORE UPDATE ON bot_decision_handoff_results BEGIN SELECT RAISE(ABORT,'Investigation result is immutable'); END;
CREATE TRIGGER bot_handoff_result_immutable_delete BEFORE DELETE ON bot_decision_handoff_results BEGIN SELECT RAISE(ABORT,'Investigation result is immutable'); END;
