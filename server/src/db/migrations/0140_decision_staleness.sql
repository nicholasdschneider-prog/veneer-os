-- A question is bound to the state of its sources when asked. When the case
-- moves on (customer replied, status or evidence changed) the current version
-- is marked stale here and cannot be answered until the bot revises it.
ALTER TABLE bot_decisions ADD COLUMN stale_json TEXT;
