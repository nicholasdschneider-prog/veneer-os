-- Review/tracking only: never approval, entitlement, or source execution.
CREATE TABLE bot_custom_direction_reviews (
 id TEXT PRIMARY KEY,
 decision_id TEXT NOT NULL UNIQUE REFERENCES bot_decisions(id),
 owner_id TEXT NOT NULL REFERENCES conversations(id),
 answer_event_id TEXT NOT NULL UNIQUE REFERENCES bot_decision_events(id),
 request_key TEXT NOT NULL,
 request_hash TEXT NOT NULL,
 snapshot_json TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE bot_custom_direction_fences (
 id TEXT PRIMARY KEY,
 review_id TEXT NOT NULL REFERENCES bot_custom_direction_reviews(id),
 request_key TEXT NOT NULL,
 request_hash TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('inflight','unknown')),
 evidence TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT (datetime('now')),
 UNIQUE(review_id,request_key)
);
CREATE TRIGGER custom_direction_review_no_update BEFORE UPDATE ON bot_custom_direction_reviews BEGIN SELECT RAISE(ABORT,'Custom direction review is immutable'); END;
CREATE TRIGGER custom_direction_review_no_delete BEFORE DELETE ON bot_custom_direction_reviews BEGIN SELECT RAISE(ABORT,'Custom direction review is immutable'); END;
CREATE TRIGGER custom_direction_fence_no_update BEFORE UPDATE ON bot_custom_direction_fences BEGIN SELECT RAISE(ABORT,'Custom direction fence is permanent'); END;
CREATE TRIGGER custom_direction_fence_no_delete BEFORE DELETE ON bot_custom_direction_fences BEGIN SELECT RAISE(ABORT,'Custom direction fence is permanent'); END;
