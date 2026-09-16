-- Optional project-level design overrides for agent-created pages and apps.
-- Empty fields inherit the site-wide page brand, then Veneer's house style.
ALTER TABLE projects
  ADD COLUMN appearance_json TEXT NOT NULL DEFAULT '{}';
