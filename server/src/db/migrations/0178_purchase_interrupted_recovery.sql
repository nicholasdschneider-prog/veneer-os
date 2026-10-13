-- Separate successor review; never mutate the interrupted run or forge a pass.
CREATE TABLE purchase_interrupted_reviews (
 id TEXT PRIMARY KEY,
 run_id TEXT NOT NULL REFERENCES scheduled_task_runs(id),
 custodian_id TEXT NOT NULL REFERENCES conversations(id),
 authorization_message_id TEXT NOT NULL REFERENCES bot_human_messages(id),
 evidence_hash TEXT NOT NULL,
 snapshot_json TEXT NOT NULL,
 recorded_at TEXT NOT NULL
);
CREATE TABLE purchase_interrupted_dispositions (
 run_id TEXT PRIMARY KEY REFERENCES scheduled_task_runs(id),
 batch_id TEXT NOT NULL UNIQUE REFERENCES purchase_event_batches(id),
 review_id TEXT NOT NULL UNIQUE REFERENCES purchase_interrupted_reviews(id),
 actor_id INTEGER NOT NULL REFERENCES users(id),
 actor_conversation_id TEXT REFERENCES conversations(id),
 evidence_hash TEXT NOT NULL,
 excluded_orders_json TEXT NOT NULL CHECK(json_valid(excluded_orders_json)),
 next_run_at TEXT NOT NULL,
 recorded_at TEXT NOT NULL
);
CREATE TRIGGER purchase_interrupted_review_no_update BEFORE UPDATE ON purchase_interrupted_reviews BEGIN SELECT RAISE(ABORT,'Immutable interrupted review'); END;
CREATE TRIGGER purchase_interrupted_review_no_delete BEFORE DELETE ON purchase_interrupted_reviews BEGIN SELECT RAISE(ABORT,'Immutable interrupted review'); END;
CREATE TRIGGER purchase_interrupted_disposition_no_update BEFORE UPDATE ON purchase_interrupted_dispositions BEGIN SELECT RAISE(ABORT,'Immutable interrupted disposition'); END;
CREATE TRIGGER purchase_interrupted_disposition_no_delete BEFORE DELETE ON purchase_interrupted_dispositions BEGIN SELECT RAISE(ABORT,'Immutable interrupted disposition'); END;
