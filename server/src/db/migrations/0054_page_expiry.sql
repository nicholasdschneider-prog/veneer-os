-- Published pages are temporary public artifacts. Existing pages keep a full
-- seven-day window from their last recorded publish/update time.
ALTER TABLE pages ADD COLUMN expires_at TEXT;

UPDATE pages
SET expires_at = datetime(updated_at, '+7 days')
WHERE expires_at IS NULL;

CREATE INDEX idx_pages_expires ON pages(expires_at);

-- Cleanup first removes expired metadata in one transaction, then deletes the
-- public R2 object. Failed R2 deletes remain here for retry, without allowing an
-- expired page to race with an in-place republish.
CREATE TABLE page_expiry_deletions (
  page_id   TEXT PRIMARY KEY,
  slug      TEXT NOT NULL UNIQUE,
  queued_at TEXT NOT NULL DEFAULT (datetime('now'))
);
