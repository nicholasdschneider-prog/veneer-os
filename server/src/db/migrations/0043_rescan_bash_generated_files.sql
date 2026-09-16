-- Claude/OpenRouter file detection now learns concrete output names from
-- successful Bash results. Reconsider chats already marked synced so files
-- whose names were constructed dynamically (for example "$out.pdf") can enter
-- the durable registry. This migration is the one-time/versioned trigger; the
-- normal background sweep remains responsible for the bounded transcript work.
-- Existing generated_files rows are intentionally preserved.
UPDATE conversations
SET files_synced_at = NULL
WHERE provider IN ('claude', 'openrouter')
  AND files_synced_at IS NOT NULL;
