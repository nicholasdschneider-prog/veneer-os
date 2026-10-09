CREATE TABLE spare_allowance_settings (
  id INTEGER PRIMARY KEY CHECK (id=1), enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1))
);
INSERT INTO spare_allowance_settings(id) VALUES(1);
CREATE TABLE spare_allowance_tasks (
  id TEXT PRIMARY KEY, request_key TEXT NOT NULL, user_id INTEGER NOT NULL REFERENCES users(id),
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  title TEXT NOT NULL, prompt TEXT NOT NULL, output TEXT NOT NULL,
  provider TEXT NOT NULL CHECK(provider IN ('claude','codex')), model TEXT NOT NULL,
  account_ids_json TEXT NOT NULL, priority INTEGER NOT NULL DEFAULT 0,
  max_batches INTEGER NOT NULL CHECK(max_batches BETWEEN 1 AND 100),
  completed_batches INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ready' CHECK(status IN ('ready','paused','blocked','completed')),
  cursor TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id,request_key)
);
CREATE TABLE spare_allowance_accounts (
  provider TEXT NOT NULL, account_id TEXT NOT NULL, snapshot_json TEXT NOT NULL,
  reason TEXT NOT NULL, checked_at TEXT NOT NULL, PRIMARY KEY(provider,account_id)
);
CREATE TABLE spare_allowance_runs (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES spare_allowance_tasks(id),
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  provider TEXT NOT NULL, account_id TEXT NOT NULL, cycle_reset TEXT NOT NULL, credential_revision TEXT,
  batch INTEGER NOT NULL, deadline TEXT NOT NULL, turn_id TEXT,
  status TEXT NOT NULL CHECK(status IN ('queued','running','completed','blocked','unknown','skipped')),
  reason TEXT, checkpoint_json TEXT, started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT, usage_before REAL NOT NULL, usage_after REAL,
  UNIQUE(task_id,batch), UNIQUE(conversation_id,turn_id)
);
CREATE UNIQUE INDEX spare_allowance_one_active ON spare_allowance_runs((1)) WHERE status IN ('queued','running');
ALTER TABLE agent_tokens ADD COLUMN spare_run_id TEXT REFERENCES spare_allowance_runs(id);
