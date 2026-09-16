-- Persist the user who first published each Page. Pages deliberately outlive
-- their originating conversation, so creator attribution cannot rely on the
-- nullable conversation_id relationship at read time.
ALTER TABLE pages
  ADD COLUMN creator_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;

-- Every pre-existing Page that still has its originating conversation can be
-- attributed exactly. Pages whose conversation is already gone remain NULL and
-- render as "Unknown user".
UPDATE pages
SET creator_user_id = (
  SELECT c.user_id
  FROM conversations c
  WHERE c.id = pages.conversation_id
)
WHERE creator_user_id IS NULL
  AND conversation_id IS NOT NULL;

CREATE INDEX idx_pages_creator ON pages(creator_user_id);
