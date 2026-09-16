ALTER TABLE assistants ADD COLUMN full_access INTEGER NOT NULL DEFAULT 0 CHECK (full_access IN (0, 1));

-- Platform Dev has historically run with provider permission checks bypassed.
-- Preserve that existing behavior while making it explicit and configurable.
UPDATE assistants SET full_access = 1 WHERE slug = 'platform-dev';
