-- A startup disposition is separate from a worker pass and never changes failed evidence.
CREATE TABLE purchase_startup_dispositions (
 run_id TEXT PRIMARY KEY REFERENCES scheduled_task_runs(id),
 batch_id TEXT NOT NULL UNIQUE REFERENCES purchase_event_batches(id),
 conversation_id TEXT NOT NULL REFERENCES conversations(id),
 evidence_hash TEXT NOT NULL,
 actor_id INTEGER NOT NULL REFERENCES users(id),
 actor_conversation_id TEXT REFERENCES conversations(id),
 coordination_reference TEXT NOT NULL,
 recorded_at TEXT NOT NULL
);
CREATE TRIGGER purchase_startup_no_update BEFORE UPDATE ON purchase_startup_dispositions BEGIN SELECT RAISE(ABORT,'Immutable startup disposition'); END;
CREATE TRIGGER purchase_startup_no_delete BEFORE DELETE ON purchase_startup_dispositions BEGIN SELECT RAISE(ABORT,'Immutable startup disposition'); END;
