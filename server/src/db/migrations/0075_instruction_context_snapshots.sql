-- Agent and project instructions are fixed once per chat and delivered through
-- provider-native developer/system channels. The applied hash lets Codex fork
-- an existing native thread once when its durable developer context changes.
ALTER TABLE conversations ADD COLUMN instruction_snapshot_json TEXT;
ALTER TABLE conversations ADD COLUMN instruction_snapshot_at TEXT;
ALTER TABLE conversations ADD COLUMN provider_instruction_hash TEXT;
