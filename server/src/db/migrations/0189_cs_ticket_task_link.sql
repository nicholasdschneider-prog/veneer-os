-- A mirrored OrderOps ticket may belong to a task on the Tasks board (customer thread in the task pane).
ALTER TABLE cs_tickets ADD COLUMN task_id TEXT REFERENCES bot_tasks(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX cs_tickets_task ON cs_tickets(task_id) WHERE task_id IS NOT NULL;
