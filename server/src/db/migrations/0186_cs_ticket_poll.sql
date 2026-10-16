-- Miles pilot: the server mirrors OrderOps messages into owned tickets with a
-- read-only poll; record when each ticket was last read and the last failure.
ALTER TABLE cs_tickets ADD COLUMN last_polled_at TEXT;
ALTER TABLE cs_tickets ADD COLUMN last_poll_error TEXT;
