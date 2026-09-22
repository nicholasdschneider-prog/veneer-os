-- Only a dedicated response turn may claim activity for a decision discussion.
-- Cleared on steering, completion, and runner startup; never inferred from delivery.
ALTER TABLE pending_turns ADD COLUMN discussion_message_id TEXT REFERENCES bot_decision_events(id);

-- Queue row IDs can be reused after deletion. Bind the actual queue row rather
-- than treating an old delivery receipt's numeric message_id as proof of scope.
ALTER TABLE queued_messages ADD COLUMN discussion_message_id TEXT REFERENCES bot_decision_events(id);
UPDATE queued_messages AS q SET discussion_message_id=(
  SELECT w.id FROM hub_inbound_messages h
  JOIN conversation_wakeups w ON h.idempotency_key='wakeup:' || w.id
  JOIN bot_decision_events e ON e.id=w.id
  WHERE h.conversation_id=q.conversation_id AND h.message_id=q.id AND h.source_kind='wakeup'
    AND e.kind='message' AND e.actor_conversation_id IS NULL
    AND q.prompt='Hey, can you pick this back up for me?' || char(10) || char(10) || w.reason || char(10) || char(10) ||
      'Please check what changed while you were away before you continue.'
  LIMIT 1
);
