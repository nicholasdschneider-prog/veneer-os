-- User-driven activity is intentionally separate from last_active_at: provider
-- output may keep a long-running chat busy, but auto-archive is based only on
-- the user opening the chat or sending it another prompt.
ALTER TABLE conversations ADD COLUMN last_user_activity_at TEXT;

-- Existing chats start conservatively from their most recent known activity.
UPDATE conversations SET last_user_activity_at = last_active_at;

CREATE INDEX idx_conversations_auto_archive
  ON conversations(user_id, last_user_activity_at)
  WHERE archived = 0 AND pin_order IS NULL;
