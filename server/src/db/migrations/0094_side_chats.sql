-- A side chat is a private conversation opened beside another chat so the user
-- can ask questions without interrupting that chat's agent. It is hidden from
-- the main chat list and reached from its parent.
ALTER TABLE conversations ADD COLUMN side_chat_of TEXT REFERENCES conversations(id) ON DELETE CASCADE;
CREATE INDEX idx_conversations_side_chat_of ON conversations(side_chat_of, last_active_at);
