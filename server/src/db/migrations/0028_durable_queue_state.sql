-- Make the message queue fully server-authoritative. `sort_order` preserves
-- drag-reorder across reconnects/restarts; pending-turn status preserves a turn
-- that exhausted automatic recovery instead of silently deleting its prompt.
ALTER TABLE queued_messages ADD COLUMN sort_order INTEGER;
UPDATE queued_messages SET sort_order = id WHERE sort_order IS NULL;
CREATE INDEX idx_queued_messages_order
  ON queued_messages(conversation_id, sort_order, id);

ALTER TABLE pending_turns ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'
  CHECK (status IN ('pending', 'failed'));
ALTER TABLE pending_turns ADD COLUMN error TEXT;
