-- Generalize scheduled automations so provider events can use the same durable
-- definition, execution chat, and run-history model.
ALTER TABLE scheduled_tasks ADD COLUMN trigger_kind TEXT NOT NULL DEFAULT 'schedule'
  CHECK (trigger_kind IN ('schedule', 'event'));
ALTER TABLE scheduled_tasks ADD COLUMN connector_id INTEGER REFERENCES user_connectors(id) ON DELETE SET NULL;
ALTER TABLE scheduled_tasks ADD COLUMN trigger_recipe TEXT;
ALTER TABLE scheduled_tasks ADD COLUMN trigger_config_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE scheduled_tasks ADD COLUMN filter_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE scheduled_tasks ADD COLUMN external_trigger_id TEXT;
ALTER TABLE scheduled_tasks ADD COLUMN trigger_status TEXT NOT NULL DEFAULT 'ready'
  CHECK (trigger_status IN ('ready', 'syncing', 'error'));
ALTER TABLE scheduled_tasks ADD COLUMN trigger_error TEXT;

CREATE UNIQUE INDEX idx_scheduled_tasks_external_trigger
  ON scheduled_tasks(external_trigger_id)
  WHERE external_trigger_id IS NOT NULL;
CREATE INDEX idx_scheduled_tasks_connector ON scheduled_tasks(connector_id);

-- Rebuild run history so event-triggered launches are first-class alongside
-- scheduled and manual launches.
CREATE TABLE scheduled_task_runs_new (
  id TEXT PRIMARY KEY,
  scheduled_task_id TEXT NOT NULL REFERENCES scheduled_tasks(id) ON DELETE CASCADE,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  scheduled_for TEXT NOT NULL,
  trigger TEXT NOT NULL CHECK (trigger IN ('scheduled','event','manual')),
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','running','needs_you','completed','failed','skipped')),
  important INTEGER NOT NULL DEFAULT 0,
  event_id TEXT,
  error TEXT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  UNIQUE(scheduled_task_id, scheduled_for)
);

INSERT INTO scheduled_task_runs_new
  (id, scheduled_task_id, conversation_id, scheduled_for, trigger, status,
   important, error, started_at, finished_at)
SELECT id, scheduled_task_id, conversation_id, scheduled_for, trigger, status,
       important, error, started_at, finished_at
FROM scheduled_task_runs;

DROP TABLE scheduled_task_runs;
ALTER TABLE scheduled_task_runs_new RENAME TO scheduled_task_runs;
CREATE INDEX idx_scheduled_task_runs_task ON scheduled_task_runs(scheduled_task_id, started_at DESC);
CREATE INDEX idx_scheduled_task_runs_conversation ON scheduled_task_runs(conversation_id);
CREATE UNIQUE INDEX idx_scheduled_task_runs_event
  ON scheduled_task_runs(event_id)
  WHERE event_id IS NOT NULL;
CREATE INDEX idx_scheduled_task_runs_attention
  ON scheduled_task_runs(status, important, conversation_id);

-- Signed webhooks commit here before returning 2xx. The runner is the only
-- consumer and claims pending rows, so web restarts and duplicate deliveries
-- cannot duplicate agent runs.
CREATE TABLE automation_events (
  id TEXT PRIMARY KEY,
  scheduled_task_id TEXT NOT NULL REFERENCES scheduled_tasks(id) ON DELETE CASCADE,
  external_trigger_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','processing','ignored','processed','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  claimed_at TEXT,
  finished_at TEXT
);
CREATE INDEX idx_automation_events_pending ON automation_events(status, received_at);
CREATE INDEX idx_automation_events_task ON automation_events(scheduled_task_id, received_at DESC);
