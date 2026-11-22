-- Internal routine sessions follow the registered bot's selected subscription.
-- Existing specialized Claude build/analysis models retain their own selection.
-- This changes routing metadata only; the runner transfers context before use.
ALTER TABLE conversations ADD COLUMN model_inherits_owner INTEGER NOT NULL DEFAULT 0
  CHECK (model_inherits_owner IN (0, 1));

UPDATE conversations SET model_inherits_owner = 1
WHERE id IN (
  SELECT l.conversation_id FROM coordination_lanes l
  JOIN bot_registrations b ON b.conversation_id = l.owner_id AND b.active = 1
  JOIN conversations owner ON owner.id = l.owner_id
  WHERE owner.provider = 'codex' AND owner.model = 'gpt-6.1-sol'
) AND (
  (provider = 'claude' AND model = 'claude-sonnet-5-5') OR
  (provider = 'codex' AND model IN ('gpt-5.6-sol', 'gpt-6.1-sol'))
);
