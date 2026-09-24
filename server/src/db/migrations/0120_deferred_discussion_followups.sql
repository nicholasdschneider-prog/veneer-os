-- New posts only. Historical null instructions are intentionally untouched.
CREATE TABLE bot_deferred_followups (
 message_id TEXT PRIMARY KEY REFERENCES bot_discussion_instructions(message_id),
 deferred_answer_event_id TEXT NOT NULL REFERENCES bot_decision_events(id),
 proposal_hash TEXT NOT NULL
);
CREATE TRIGGER deferred_followup_immutable_update BEFORE UPDATE ON bot_deferred_followups BEGIN SELECT RAISE(ABORT,'Follow-up attribution is immutable'); END;
CREATE TRIGGER deferred_followup_immutable_delete BEFORE DELETE ON bot_deferred_followups BEGIN SELECT RAISE(ABORT,'Follow-up attribution is immutable'); END;
