-- Pages (2026-07-20): standalone public HTML pages an agent publishes to a
-- Cloudflare R2 bucket, served at a public base URL (e.g. https://pages.veneer.app).
-- Each page is one object in R2 under the key `p/<slug>`; the slug is a random
-- 26-char id so the URL is unguessable but stable across in-place updates. Rows
-- carry only metadata — the HTML itself lives in R2, not the DB. project_id /
-- conversation_id are nullable and SET NULL on delete so a page outlives the
-- chat or project it came from.
CREATE TABLE pages (
  id              TEXT PRIMARY KEY,
  slug            TEXT NOT NULL UNIQUE,
  title           TEXT NOT NULL,
  project_id      TEXT REFERENCES projects(id) ON DELETE SET NULL,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  size_bytes      INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_pages_project ON pages(project_id);
