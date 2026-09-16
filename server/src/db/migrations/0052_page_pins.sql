-- Pinned Pages (2026-07-29). NULL means not pinned; lower values sort first.
-- New pins take MIN-1 so the most recently pinned page appears first in its
-- project group.
ALTER TABLE pages ADD COLUMN pin_order INTEGER;

CREATE INDEX idx_pages_project_pin
  ON pages(project_id, pin_order);
