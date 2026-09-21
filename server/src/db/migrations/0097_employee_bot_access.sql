-- Restricted employees retain the boundary even after their last grant is revoked.
CREATE TABLE employee_workspaces (
 user_id INTEGER PRIMARY KEY REFERENCES users(id)
);
CREATE TABLE employee_bot_access (
 user_id INTEGER NOT NULL REFERENCES employee_workspaces(user_id),
 conversation_id TEXT NOT NULL REFERENCES conversations(id),
 PRIMARY KEY(user_id,conversation_id)
);
CREATE TABLE shared_bot_queues (
 conversation_id TEXT PRIMARY KEY REFERENCES conversations(id)
);
ALTER TABLE bot_decisions ADD COLUMN handler_id INTEGER REFERENCES users(id);
ALTER TABLE bot_decisions ADD COLUMN handling_revision INTEGER NOT NULL DEFAULT 0;
