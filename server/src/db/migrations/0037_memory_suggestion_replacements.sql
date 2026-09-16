-- A medium-confidence correction may supersede an existing memory after the
-- user approves it. Keep that target while the suggestion waits for review.
ALTER TABLE memory_suggestions ADD COLUMN replace_memory_id TEXT NOT NULL DEFAULT '';
