ALTER TABLE assistants ADD COLUMN approval_mode TEXT NOT NULL DEFAULT 'ask';

-- NULL inherits the assistant's setting.
ALTER TABLE conversations ADD COLUMN approval_mode TEXT;
