ALTER TABLE conversations
  ADD COLUMN visibility TEXT NOT NULL DEFAULT 'team'
  CHECK (visibility IN ('team', 'private'));

CREATE INDEX idx_conversations_visibility
  ON conversations(visibility, user_id, archived, last_active_at DESC);
