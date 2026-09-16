-- Mini apps (2026-07-21): small agent-authored HTTP tools deployed as isolated
-- Cloudflare Workers and mounted below this Veneer instance's /tools path.
-- Source stays in the instance DB so an app can be edited, redeployed, or moved
-- to another runtime later; Cloudflare only holds the compiled deployment.
CREATE TABLE mini_apps (
  id                TEXT PRIMARY KEY,
  slug              TEXT NOT NULL UNIQUE,
  title             TEXT NOT NULL,
  source_text       TEXT NOT NULL,
  source_size_bytes INTEGER NOT NULL DEFAULT 0,
  script_name       TEXT NOT NULL UNIQUE,
  route_id          TEXT,
  status            TEXT NOT NULL DEFAULT 'deploying'
                    CHECK (status IN ('deploying', 'deployed', 'error')),
  last_error        TEXT,
  project_id        TEXT REFERENCES projects(id) ON DELETE SET NULL,
  conversation_id   TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
  deployed_at       TEXT
);
CREATE INDEX idx_mini_apps_project ON mini_apps(project_id);
