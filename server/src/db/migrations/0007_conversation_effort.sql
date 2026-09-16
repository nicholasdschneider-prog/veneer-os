-- Reasoning-effort level chosen at conversation creation (2026-07-05). Values
-- are provider-specific free text (Claude: low/medium/high/xhigh/max; Codex:
-- minimal/low/medium/high/xhigh) passed straight through to the CLI, so no
-- CHECK constraint here.
ALTER TABLE conversations ADD COLUMN effort TEXT;
