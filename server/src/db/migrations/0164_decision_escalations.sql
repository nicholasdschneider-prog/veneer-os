-- Stale question escalation: a waiting question that has sat for more than four business hours
-- is escalated once per business day to its assignee and the install owner, through the existing
-- push outbox and bot call rings. Ids, counts and outcome categories only; never question text.
CREATE TABLE bot_decision_escalations (
 id TEXT PRIMARY KEY,
 decision_id TEXT NOT NULL REFERENCES bot_decisions(id) ON DELETE CASCADE,
 decision_version INTEGER NOT NULL,
 -- America/New_York calendar date (YYYY-MM-DD) of the business day the escalation fired on.
 business_day TEXT NOT NULL,
 waiting_since TEXT NOT NULL,
 business_minutes INTEGER NOT NULL,
 recipients_json TEXT NOT NULL,
 notifications_queued INTEGER NOT NULL DEFAULT 0,
 rings_rearmed INTEGER NOT NULL DEFAULT 0,
 outcome_json TEXT,
 created_at TEXT NOT NULL DEFAULT (datetime('now')),
 UNIQUE(decision_id, business_day)
);
CREATE INDEX bot_decision_escalations_version ON bot_decision_escalations(decision_id, decision_version);
