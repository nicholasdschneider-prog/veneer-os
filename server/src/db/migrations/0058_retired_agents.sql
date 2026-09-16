ALTER TABLE assistants ADD COLUMN deleted_at TEXT;

CREATE INDEX idx_assistants_active ON assistants(deleted_at, id);
