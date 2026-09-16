-- Browser Use was removed from Veneer Pro. Keep migration 0065 as immutable
-- history, then remove its durable data in this forward migration.
DROP TABLE IF EXISTS browser_use_sessions;
DROP TABLE IF EXISTS browser_use_project_profiles;
DROP TABLE IF EXISTS browser_use_profiles;
