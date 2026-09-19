-- Voice calls can be placed to one VeneerBot; its saved conversation stays separate from the coordinator's.
ALTER TABLE voice_entries ADD COLUMN bot_conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE;
CREATE INDEX idx_voice_entries_bot ON voice_entries(user_id, bot_conversation_id, id);
