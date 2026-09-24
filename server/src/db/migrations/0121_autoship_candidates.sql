CREATE TABLE autoship_candidate_sources (
 id TEXT PRIMARY KEY, business_id TEXT NOT NULL REFERENCES business_teams(id),
 owner_id INTEGER NOT NULL REFERENCES users(id), recipient_id TEXT NOT NULL REFERENCES conversations(id),
 account_id TEXT NOT NULL, source_origin TEXT NOT NULL, client_id TEXT NOT NULL, audience TEXT NOT NULL,
 request_key TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE autoship_candidate_revocations (
 source_id TEXT PRIMARY KEY REFERENCES autoship_candidate_sources(id), actor_id INTEGER NOT NULL REFERENCES users(id),
 reason TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE autoship_candidate_events (
 delivery_id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES autoship_candidate_sources(id),
 event_id TEXT NOT NULL, payload_hash TEXT NOT NULL, payload_json TEXT NOT NULL, receipt_json TEXT NOT NULL,
 wakeup_id TEXT NOT NULL UNIQUE REFERENCES conversation_wakeups(id), UNIQUE(source_id,event_id)
);
CREATE TABLE autoship_candidate_starts (
 delivery_id TEXT PRIMARY KEY REFERENCES autoship_candidate_events(delivery_id), started_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TRIGGER candidate_source_immutable_update BEFORE UPDATE ON autoship_candidate_sources BEGIN SELECT RAISE(ABORT,'Immutable candidate source'); END;
CREATE TRIGGER candidate_source_immutable_delete BEFORE DELETE ON autoship_candidate_sources BEGIN SELECT RAISE(ABORT,'Immutable candidate source'); END;
CREATE TRIGGER candidate_revocation_immutable_update BEFORE UPDATE ON autoship_candidate_revocations BEGIN SELECT RAISE(ABORT,'Immutable candidate revocation'); END;
CREATE TRIGGER candidate_revocation_immutable_delete BEFORE DELETE ON autoship_candidate_revocations BEGIN SELECT RAISE(ABORT,'Immutable candidate revocation'); END;
CREATE TRIGGER candidate_event_immutable_update BEFORE UPDATE ON autoship_candidate_events BEGIN SELECT RAISE(ABORT,'Immutable candidate event'); END;
CREATE TRIGGER candidate_event_immutable_delete BEFORE DELETE ON autoship_candidate_events BEGIN SELECT RAISE(ABORT,'Immutable candidate event'); END;
CREATE TRIGGER candidate_start_immutable_update BEFORE UPDATE ON autoship_candidate_starts BEGIN SELECT RAISE(ABORT,'Immutable candidate start'); END;
CREATE TRIGGER candidate_start_immutable_delete BEFORE DELETE ON autoship_candidate_starts BEGIN SELECT RAISE(ABORT,'Immutable candidate start'); END;
