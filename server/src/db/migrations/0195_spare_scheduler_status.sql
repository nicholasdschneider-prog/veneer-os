CREATE TABLE spare_allowance_scheduler (
  id INTEGER PRIMARY KEY CHECK(id=1),
  checked_at TEXT NOT NULL,
  reason TEXT NOT NULL,
  accounts_checked_at TEXT
);
ALTER TABLE spare_allowance_tasks ADD COLUMN checked_at TEXT;
ALTER TABLE spare_allowance_tasks ADD COLUMN skip_reason TEXT;
