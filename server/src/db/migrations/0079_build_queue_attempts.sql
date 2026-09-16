-- Auto-retry accounting: how many times a build was requeued after a
-- timed-out or failed turn. One automatic retry is allowed before the
-- job pauses its scope queue for manual resolution.
ALTER TABLE build_queue ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
