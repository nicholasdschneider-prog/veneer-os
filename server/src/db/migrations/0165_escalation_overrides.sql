-- Stale-question escalations reach the install owner even for bots whose calls or
-- notifications they never turned on. Both flags are set only by an escalation.
-- A ring's flag lasts for one ring: it clears when that ring is missed, answered or turned into a phone call.
ALTER TABLE bot_call_rings ADD COLUMN escalated INTEGER NOT NULL DEFAULT 0;
-- An escalation push is delivered without a per-bot notification preference.
ALTER TABLE bot_notification_outbox ADD COLUMN escalation INTEGER NOT NULL DEFAULT 0;
