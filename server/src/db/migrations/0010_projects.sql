-- Projects (2026-07-06): a project is a folder. Each project gets its own
-- workspace directory (workspaces/projects/<slug>) with its own CLAUDE.md, so
-- chats started inside it share standing context and any files the agent
-- writes there. A conversation's project is fixed at creation: the native CLI
-- session (and its transcript on disk) is keyed by the working directory, so a
-- chat can't move folders without losing its history. Deleting a project
-- therefore CASCADEs to its chats rather than orphaning them into a different
-- folder (the route interrupts live turns and removes the folder too).
CREATE TABLE projects (
  id           TEXT PRIMARY KEY,
  slug         TEXT NOT NULL UNIQUE,
  name         TEXT NOT NULL,
  instructions TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Nullable: existing chats (and any started outside a project) stay unfiled and
-- run in the shared assistant workspace exactly as before.
ALTER TABLE conversations ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE CASCADE;
CREATE INDEX idx_conversations_project ON conversations(project_id, last_active_at DESC);
