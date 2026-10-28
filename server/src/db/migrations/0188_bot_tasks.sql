-- Shared Tasks capability for every registered Veneer bot (build #908, Nick 2026-10-28).
-- A task is one unit of work a bot owns, worked in its own chat (a coordination
-- lane of the bot's chat), visible on the bot's CHAT | TASKS board. Decisions
-- raised from a task chat bind to the task. Marks let a human mark coordination
-- threads and handed-off chats done so finished work leaves the board.
CREATE TABLE bot_tasks (
 id TEXT PRIMARY KEY,
 owner_conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
 title TEXT NOT NULL,
 brief TEXT NOT NULL DEFAULT '',
 status TEXT NOT NULL DEFAULT 'up_next' CHECK(status IN ('up_next','working','needs_input','ready_for_review','done')),
 source TEXT NOT NULL DEFAULT 'bot' CHECK(source IN ('human_dump','existing_case','bot','import')),
 task_conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
 status_line TEXT NOT NULL DEFAULT '',
 case_key TEXT,
 resources_json TEXT NOT NULL DEFAULT '[]',
 closed_by TEXT CHECK(closed_by IN ('human','auto')),
 created_by INTEGER REFERENCES users(id),
 created_at TEXT NOT NULL DEFAULT (datetime('now')),
 updated_at TEXT NOT NULL DEFAULT (datetime('now')),
 closed_at TEXT
);
CREATE INDEX bot_tasks_owner ON bot_tasks(owner_conversation_id, status, updated_at);
CREATE UNIQUE INDEX bot_tasks_open_case ON bot_tasks(owner_conversation_id, case_key) WHERE case_key IS NOT NULL AND status<>'done';
CREATE UNIQUE INDEX bot_tasks_chat ON bot_tasks(task_conversation_id) WHERE task_conversation_id IS NOT NULL;
CREATE TABLE bot_task_events (
 id TEXT PRIMARY KEY,
 task_id TEXT NOT NULL REFERENCES bot_tasks(id) ON DELETE CASCADE,
 kind TEXT NOT NULL,
 actor_id INTEGER REFERENCES users(id),
 actor_conversation_id TEXT,
 payload_json TEXT NOT NULL DEFAULT '{}',
 created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX bot_task_events_task ON bot_task_events(task_id, created_at);
CREATE TRIGGER bot_task_events_immutable_update BEFORE UPDATE ON bot_task_events BEGIN SELECT RAISE(ABORT, 'Task audit is immutable'); END;
CREATE TRIGGER bot_task_events_immutable_delete BEFORE DELETE ON bot_task_events BEGIN SELECT RAISE(ABORT, 'Task audit is immutable'); END;
CREATE TABLE bot_task_marks (
 owner_conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
 kind TEXT NOT NULL CHECK(kind IN ('thread','handoff')),
 source_id TEXT NOT NULL,
 mark TEXT NOT NULL CHECK(mark IN ('done','reviewed')),
 user_id INTEGER NOT NULL REFERENCES users(id),
 created_at TEXT NOT NULL DEFAULT (datetime('now')),
 PRIMARY KEY(owner_conversation_id, kind, source_id)
);
ALTER TABLE bot_decisions ADD COLUMN task_id TEXT REFERENCES bot_tasks(id) ON DELETE SET NULL;
CREATE INDEX bot_decisions_task ON bot_decisions(task_id);
