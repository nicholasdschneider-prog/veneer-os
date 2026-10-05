-- Narrow transport binding; no task settings, source credentials or business authority change.
CREATE TABLE purchase_event_bindings (
 source_id TEXT PRIMARY KEY REFERENCES bot_event_sources(id),
 task_id TEXT NOT NULL UNIQUE REFERENCES scheduled_tasks(id),
 team_id TEXT NOT NULL REFERENCES business_teams(id),
 owner_id INTEGER NOT NULL REFERENCES users(id),
 project_id TEXT NOT NULL REFERENCES projects(id)
);
INSERT INTO purchase_event_bindings
SELECT s.id,t.id,s.team_id,s.created_by,t.project_id
FROM bot_event_sources s JOIN business_teams b ON b.id=s.team_id
JOIN scheduled_tasks t ON t.id='9c72a42a-40df-4477-9ba6-07f74ac08bf3'
JOIN users u ON u.id=b.owner_id JOIN projects p ON p.id=t.project_id
WHERE s.id='90ef6920-4bbd-4bb9-852d-02868dd8b05b'
AND s.team_id='5bcfe66f-1bc1-46fb-bc8d-bdc217fe3d86'
AND s.created_by=1 AND b.owner_id=1 AND t.user_id=1
AND t.project_id='e8e0efc6-2f5f-4666-8588-ede17529bc9c'
AND u.status='active' AND s.enabled=1 AND t.enabled=1 AND t.trigger_kind='schedule';
CREATE TABLE purchase_event_batches (
 id TEXT PRIMARY KEY,
 source_id TEXT NOT NULL REFERENCES purchase_event_bindings(source_id),
 task_id TEXT NOT NULL REFERENCES scheduled_tasks(id),
 status TEXT NOT NULL CHECK(status IN ('pending','linked','blocked')),
 run_id TEXT UNIQUE REFERENCES scheduled_task_runs(id),
 blocked_reason TEXT,
 created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX purchase_one_pending ON purchase_event_batches(task_id) WHERE status='pending';
CREATE TABLE purchase_event_receipts (
 source_id TEXT NOT NULL REFERENCES purchase_event_bindings(source_id),
 event_id TEXT NOT NULL,
 payload_hash TEXT NOT NULL,
 payload_json TEXT NOT NULL,
 receipt_json TEXT NOT NULL,
 PRIMARY KEY(source_id,event_id)
);
CREATE TRIGGER purchase_receipt_no_update BEFORE UPDATE ON purchase_event_receipts BEGIN SELECT RAISE(ABORT,'Immutable purchase receipt'); END;
CREATE TRIGGER purchase_receipt_no_delete BEFORE DELETE ON purchase_event_receipts BEGIN SELECT RAISE(ABORT,'Immutable purchase receipt'); END;
CREATE TABLE purchase_event_links (
 source_id TEXT NOT NULL,
 event_id TEXT NOT NULL,
 batch_id TEXT NOT NULL REFERENCES purchase_event_batches(id),
 PRIMARY KEY(source_id,event_id),
 FOREIGN KEY(source_id,event_id) REFERENCES purchase_event_receipts(source_id,event_id)
);
CREATE TABLE purchase_worker_starts (
 run_id TEXT PRIMARY KEY REFERENCES scheduled_task_runs(id),
 conversation_id TEXT NOT NULL REFERENCES conversations(id),
 turn_id TEXT NOT NULL,
 started_at TEXT NOT NULL
);
CREATE TRIGGER purchase_start_no_update BEFORE UPDATE ON purchase_worker_starts BEGIN SELECT RAISE(ABORT,'Immutable worker start'); END;
CREATE TRIGGER purchase_start_no_delete BEFORE DELETE ON purchase_worker_starts BEGIN SELECT RAISE(ABORT,'Immutable worker start'); END;
CREATE TABLE purchase_worker_passes (
 run_id TEXT PRIMARY KEY REFERENCES scheduled_task_runs(id),
 conversation_id TEXT NOT NULL REFERENCES conversations(id),
 outcome TEXT NOT NULL CHECK(outcome IN ('clear','blocked','unknown')),
 cursor TEXT,
 recorded_at TEXT NOT NULL
);
CREATE TRIGGER purchase_pass_no_update BEFORE UPDATE ON purchase_worker_passes BEGIN SELECT RAISE(ABORT,'Immutable worker pass'); END;
CREATE TRIGGER purchase_pass_no_delete BEFORE DELETE ON purchase_worker_passes BEGIN SELECT RAISE(ABORT,'Immutable worker pass'); END;
