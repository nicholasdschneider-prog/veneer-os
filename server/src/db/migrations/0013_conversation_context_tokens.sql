-- Last turn's input-token count (2026-07-08). This is the size of the prompt the
-- provider processed on the most recent turn — i.e. the conversation's current
-- "context used". Surfaced in the composer so a user can see how full the
-- context is per agent. Null until the first turn completes with usage.
ALTER TABLE conversations ADD COLUMN last_input_tokens INTEGER;
