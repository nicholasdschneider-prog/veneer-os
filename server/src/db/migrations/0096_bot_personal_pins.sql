-- Bot pins are personal, unlike the shared conversation pin order.
ALTER TABLE conversation_last_seen ADD COLUMN bot_pinned INTEGER NOT NULL DEFAULT 0;
