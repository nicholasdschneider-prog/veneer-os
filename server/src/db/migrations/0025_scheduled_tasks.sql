CREATE TABLE scheduled_tasks (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assistant_id INTEGER NOT NULL REFERENCES assistants(id),
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  prompt TEXT NOT NULL,
  schedule_json TEXT NOT NULL,
  timezone TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT,
  effort TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  next_run_at TEXT,
  last_run_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_scheduled_tasks_due ON scheduled_tasks(enabled, next_run_at);
CREATE INDEX idx_scheduled_tasks_user ON scheduled_tasks(user_id, created_at DESC);

CREATE TABLE scheduled_task_runs (
  id TEXT PRIMARY KEY,
  scheduled_task_id TEXT NOT NULL REFERENCES scheduled_tasks(id) ON DELETE CASCADE,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  scheduled_for TEXT NOT NULL,
  trigger TEXT NOT NULL CHECK (trigger IN ('scheduled','manual')),
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','running','needs_you','completed','failed','skipped')),
  error TEXT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  UNIQUE(scheduled_task_id, scheduled_for)
);
CREATE INDEX idx_scheduled_task_runs_task ON scheduled_task_runs(scheduled_task_id, started_at DESC);
CREATE INDEX idx_scheduled_task_runs_conversation ON scheduled_task_runs(conversation_id);
