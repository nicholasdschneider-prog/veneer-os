-- Generated files registry (2026-07-14): a durable index of the deliverable
-- files agents produce (CSV/XLSX/PDF/images/…), so they survive the chat that
-- made them. The per-conversation transcript scan (providers/claude/
-- sessionFiles.ts) is ephemeral — it only reports files for a live chat and is
-- gone once the chat is deleted. This table mirrors those detections into a
-- registry the web process keeps fresh (on every turn_done) and lists on the
-- Files page. The conversation/project/user FKs are ON DELETE SET NULL, not
-- CASCADE: a file the user downloaded from a chat should stay downloadable even
-- after that chat (or its project) is gone — only the back-reference is dropped.
-- `path` is UNIQUE so re-detecting the same file upserts rather than duplicates.
CREATE TABLE generated_files (
  id              TEXT PRIMARY KEY,
  path            TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  source          TEXT NOT NULL CHECK (source IN ('write','bash')),
  size            INTEGER NOT NULL DEFAULT 0,
  mtime_ms        INTEGER NOT NULL DEFAULT 0,
  user_id         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  project_id      TEXT REFERENCES projects(id) ON DELETE SET NULL,
  first_seen_at   TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_generated_files_mtime ON generated_files(mtime_ms DESC);

-- Per-conversation sync high-water mark: the last_active_at value we had synced
-- this chat's files up to. A chat is "stale" (needs re-scanning) whenever this
-- is NULL or older than last_active_at — that's the catch-up path the Files
-- list route uses to backfill historical chats and anything missed while web
-- was down.
ALTER TABLE conversations ADD COLUMN files_synced_at TEXT;
