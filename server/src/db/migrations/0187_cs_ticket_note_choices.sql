-- Miles pilot: a bot note may offer the human tappable next steps; a human note may carry uploaded attachments.
ALTER TABLE cs_ticket_messages ADD COLUMN choices_json TEXT NOT NULL DEFAULT '[]';
