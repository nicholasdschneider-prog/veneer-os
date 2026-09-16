-- Which chat's agent spawned this one (handoff tool etc.); NULL = human-created.
-- Plain TEXT on purpose, no FK: the origin chat may be deleted later and the
-- orphan should simply render as a normal top-level chat.
ALTER TABLE conversations ADD COLUMN origin_conversation_id TEXT;
