-- Live OrderOps status behind a task, read by the web background sweep through the read-only mirror.
CREATE TABLE bot_task_source_status (
  task_id TEXT PRIMARY KEY REFERENCES bot_tasks(id) ON DELETE CASCADE,
  ticket_code TEXT NOT NULL,
  status TEXT,
  closed_at TEXT,
  last_message_at TEXT,
  last_direction TEXT,
  line TEXT NOT NULL DEFAULT '',
  checked_at TEXT NOT NULL,
  error TEXT,
  recheck_at TEXT
);
CREATE INDEX bot_task_source_status_checked ON bot_task_source_status(checked_at);
