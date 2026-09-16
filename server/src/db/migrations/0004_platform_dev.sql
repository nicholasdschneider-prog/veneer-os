-- Platform Dev agent (2026-07-05). A second assistant whose workspace is the
-- live Veneer Pro source checkout (VP_SOURCE_DIR), so it can edit the platform's
-- own code and ship a build-gated restart. Admin-only. Its cwd + elevated
-- (Bash-allowed) policy are resolved by slug in the server, not stored here.
INSERT OR IGNORE INTO assistants (slug, name) VALUES ('platform-dev', 'Platform Dev');
