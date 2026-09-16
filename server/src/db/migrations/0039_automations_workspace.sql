-- First-class Automations workspace (2026-07-22). A schedule is the durable
-- automation entity; its fresh execution chats remain linked as run history.
-- Pinning keeps an automation prominent and exposes only its latest run in the
-- normal Chats list. Individual important runs can also be surfaced there.
ALTER TABLE scheduled_tasks ADD COLUMN pin_order INTEGER;
ALTER TABLE scheduled_task_runs ADD COLUMN important INTEGER NOT NULL DEFAULT 0;

CREATE INDEX idx_scheduled_tasks_pinned ON scheduled_tasks(user_id, pin_order);
CREATE INDEX idx_scheduled_task_runs_attention
  ON scheduled_task_runs(status, important, conversation_id);
