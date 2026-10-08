-- Ordinary owner-source workflow tracking, never native proposal approval or dispatch permission.
CREATE TABLE bot_custom_direction_amendments (
 id TEXT PRIMARY KEY, review_id TEXT NOT NULL REFERENCES bot_custom_direction_reviews(id),
 request_key TEXT NOT NULL, request_hash TEXT NOT NULL, snapshot_json TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(review_id,request_key)
);
CREATE TABLE bot_custom_direction_progress (
 id TEXT PRIMARY KEY, review_id TEXT NOT NULL REFERENCES bot_custom_direction_reviews(id),
 request_key TEXT NOT NULL, request_hash TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('running','blocked','unknown','verified_completed')),
 attempt_key TEXT NOT NULL, payload_json TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(review_id,request_key)
);
CREATE UNIQUE INDEX custom_direction_one_attempt ON bot_custom_direction_progress(review_id) WHERE state='running';
CREATE UNIQUE INDEX custom_direction_one_completion ON bot_custom_direction_progress(review_id) WHERE state='verified_completed';
CREATE TRIGGER custom_direction_amendment_no_update BEFORE UPDATE ON bot_custom_direction_amendments BEGIN SELECT RAISE(ABORT,'Custom direction amendment is immutable'); END;
CREATE TRIGGER custom_direction_amendment_no_delete BEFORE DELETE ON bot_custom_direction_amendments BEGIN SELECT RAISE(ABORT,'Custom direction amendment is immutable'); END;
CREATE TRIGGER custom_direction_progress_no_update BEFORE UPDATE ON bot_custom_direction_progress BEGIN SELECT RAISE(ABORT,'Custom direction progress is immutable'); END;
CREATE TRIGGER custom_direction_progress_no_delete BEFORE DELETE ON bot_custom_direction_progress BEGIN SELECT RAISE(ABORT,'Custom direction progress is immutable'); END;
