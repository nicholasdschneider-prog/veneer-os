-- Retire the old hosted browser connector. Veneer Browser is now the first
-- browser choice, and existing connector rows must not stay visible or active.
UPDATE scheduled_tasks
SET connector_id = NULL
WHERE connector_id IN (
  SELECT id FROM user_connectors WHERE connector_slug = 'browserbase'
);
DELETE FROM connector_access_changes
WHERE connector_id IN (
  SELECT id FROM user_connectors WHERE connector_slug = 'browserbase'
);
DELETE FROM user_connector_projects
WHERE connector_id IN (
  SELECT id FROM user_connectors WHERE connector_slug = 'browserbase'
);
DELETE FROM user_connectors WHERE connector_slug = 'browserbase';
DELETE FROM connector_auth_configs WHERE connector_slug = 'browserbase';
DELETE FROM connections WHERE slug = 'browserbase';
