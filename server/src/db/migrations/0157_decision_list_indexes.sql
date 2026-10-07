-- Pollers read decision history repeatedly. Index the bounded decision/thread
-- lookups instead of scanning all discussion rows for each displayed decision.
CREATE INDEX bot_threads_decision_actor ON bot_decision_threads(decision_id, actor_conversation_id);
CREATE INDEX bot_events_decision_kind_version ON bot_decision_events(decision_id, kind, version);
CREATE INDEX bot_decisions_state_created ON bot_decisions(state, created_at DESC, id);
