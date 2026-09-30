-- Native side of the agreed merge-authorization contract (build 497/498,
-- out/build497-native/native-merge-contract-proposal.md v4). Every table is
-- scoped by the stable (source_id, business_team_id); registration columns are
-- provenance only. Nothing here merges or deletes a case: OrderOps commits under
-- a redeemed reservation and reports the commit as evidence.
-- One row per registration revision: rotating custody re-enrolls and inherits every fence.
CREATE TABLE merge_authorization_enrollments(registration_id TEXT NOT NULL, registration_hash TEXT NOT NULL, owner_id INTEGER NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(registration_id,registration_hash));
CREATE TABLE merge_case_tuples(
 source_id TEXT NOT NULL, business_team_id TEXT NOT NULL, ticket TEXT NOT NULL, case_id TEXT NOT NULL,
 last_material_revision TEXT NOT NULL, observed_at TEXT NOT NULL,
 registration_id TEXT, registration_revision INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 PRIMARY KEY(source_id,business_team_id,ticket), UNIQUE(source_id,business_team_id,case_id));
CREATE TABLE merge_intents(
 pair_receipt_id TEXT PRIMARY KEY, source_id TEXT NOT NULL, business_team_id TEXT NOT NULL, pair_key TEXT NOT NULL,
 case_a TEXT NOT NULL, case_b TEXT NOT NULL, executor_conversation_id TEXT NOT NULL,
 registration_id TEXT, registration_revision INTEGER, created_at TEXT NOT NULL,
 UNIQUE(source_id,business_team_id,pair_key));
CREATE TABLE merge_intent_revisions(
 pair_receipt_id TEXT NOT NULL REFERENCES merge_intents(pair_receipt_id), intent_revision INTEGER NOT NULL,
 request_key TEXT NOT NULL, request_hash TEXT NOT NULL, intent_json TEXT NOT NULL, intent_base_hash TEXT NOT NULL,
 registration_id TEXT, registration_revision INTEGER, created_at TEXT NOT NULL,
 PRIMARY KEY(pair_receipt_id,intent_revision), UNIQUE(pair_receipt_id,request_key));
CREATE TABLE merge_intent_bindings(
 decision_id TEXT NOT NULL, decision_version INTEGER NOT NULL, pair_receipt_id TEXT NOT NULL REFERENCES merge_intents(pair_receipt_id),
 intent_revision INTEGER NOT NULL, direction TEXT NOT NULL CHECK(direction IN ('a_into_b','b_into_a')), intent_hash TEXT NOT NULL, created_at TEXT NOT NULL,
 PRIMARY KEY(decision_id,decision_version));
CREATE TABLE merge_actions(
 pair_receipt_id TEXT PRIMARY KEY REFERENCES merge_intents(pair_receipt_id), source_id TEXT NOT NULL, business_team_id TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('open','fenced','committed','abandoned')), live_generation INTEGER, updated_at TEXT NOT NULL);
CREATE TABLE merge_reservations(
 reservation_id TEXT PRIMARY KEY, pair_receipt_id TEXT NOT NULL REFERENCES merge_intents(pair_receipt_id), generation INTEGER NOT NULL,
 source_id TEXT NOT NULL, business_team_id TEXT NOT NULL, request_key TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('issued','redeemed','committed','revoked','expired_unredeemed','nonexecuted','redeemed_uncertain')),
 intent_revision INTEGER NOT NULL, intent_hash TEXT NOT NULL, direction TEXT NOT NULL,
 decision_id TEXT NOT NULL, decision_version INTEGER NOT NULL, answer_event_id TEXT NOT NULL,
 registration_id TEXT NOT NULL, registration_revision INTEGER NOT NULL,
 issued_at TEXT NOT NULL, expires_at TEXT NOT NULL, reservation_hash TEXT NOT NULL,
 redeem_request_key TEXT, attempt_id TEXT, redemption_id TEXT, redeemed_at TEXT, nonexecution_json TEXT, updated_at TEXT NOT NULL,
 UNIQUE(pair_receipt_id,generation), UNIQUE(source_id,business_team_id,request_key));
CREATE TABLE merge_case_locks(
 source_id TEXT NOT NULL, business_team_id TEXT NOT NULL, case_id TEXT NOT NULL,
 pair_receipt_id TEXT NOT NULL REFERENCES merge_intents(pair_receipt_id), generation INTEGER NOT NULL, created_at TEXT NOT NULL,
 PRIMARY KEY(source_id,business_team_id,case_id));
CREATE TABLE case_merges(
 pair_receipt_id TEXT PRIMARY KEY REFERENCES merge_intents(pair_receipt_id), reservation_id TEXT NOT NULL UNIQUE REFERENCES merge_reservations(reservation_id),
 source_id TEXT NOT NULL, business_team_id TEXT NOT NULL, generation INTEGER NOT NULL,
 from_case_id TEXT NOT NULL, into_case_id TEXT NOT NULL, from_ticket TEXT NOT NULL, into_ticket TEXT NOT NULL,
 commit_json TEXT NOT NULL, committed_at TEXT NOT NULL, registration_id TEXT, registration_revision INTEGER, created_at TEXT NOT NULL,
 UNIQUE(source_id,business_team_id,from_case_id));
CREATE TABLE duplicate_candidates(
 candidate_id TEXT PRIMARY KEY, source_id TEXT NOT NULL, business_team_id TEXT NOT NULL,
 pair_receipt_id TEXT NOT NULL REFERENCES merge_intents(pair_receipt_id), intent_revision INTEGER NOT NULL, evidence_revision TEXT NOT NULL,
 assigned_bot TEXT NOT NULL, supersedes TEXT, candidate_hash TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('recorded','superseded_by_merge')), accepted_at TEXT NOT NULL,
 registration_id TEXT, registration_revision INTEGER);
CREATE TABLE bot_event_receipts(
 source_id TEXT NOT NULL, business_team_id TEXT NOT NULL, event_id TEXT NOT NULL, event_hash TEXT NOT NULL, payload_hash TEXT NOT NULL,
 event_json TEXT NOT NULL, response_json TEXT NOT NULL, accepted_at TEXT NOT NULL,
 PRIMARY KEY(source_id,event_id));
CREATE TRIGGER merge_enrollment_no_update BEFORE UPDATE ON merge_authorization_enrollments BEGIN SELECT RAISE(ABORT,'Immutable merge enrollment'); END;
CREATE TRIGGER merge_enrollment_no_delete BEFORE DELETE ON merge_authorization_enrollments BEGIN SELECT RAISE(ABORT,'Immutable merge enrollment'); END;
CREATE TRIGGER merge_intent_revision_no_update BEFORE UPDATE ON merge_intent_revisions BEGIN SELECT RAISE(ABORT,'Immutable intent revision'); END;
CREATE TRIGGER merge_intent_revision_no_delete BEFORE DELETE ON merge_intent_revisions BEGIN SELECT RAISE(ABORT,'Immutable intent revision'); END;
CREATE TRIGGER merge_binding_no_update BEFORE UPDATE ON merge_intent_bindings BEGIN SELECT RAISE(ABORT,'Immutable intent binding'); END;
CREATE TRIGGER merge_binding_no_delete BEFORE DELETE ON merge_intent_bindings BEGIN SELECT RAISE(ABORT,'Immutable intent binding'); END;
CREATE TRIGGER merge_reservation_no_delete BEFORE DELETE ON merge_reservations BEGIN SELECT RAISE(ABORT,'Immutable reservation generation'); END;
CREATE TRIGGER case_merge_no_update BEFORE UPDATE ON case_merges BEGIN SELECT RAISE(ABORT,'Immutable merge record'); END;
CREATE TRIGGER case_merge_no_delete BEFORE DELETE ON case_merges BEGIN SELECT RAISE(ABORT,'Immutable merge record'); END;
CREATE TRIGGER event_receipt_no_update BEFORE UPDATE ON bot_event_receipts BEGIN SELECT RAISE(ABORT,'Immutable event receipt'); END;
CREATE TRIGGER event_receipt_no_delete BEFORE DELETE ON bot_event_receipts BEGIN SELECT RAISE(ABORT,'Immutable event receipt'); END;
-- Routine kinds gain the two new events (table rebuild: SQLite cannot alter a CHECK).
CREATE TABLE bot_routines_new (
 id TEXT PRIMARY KEY,
 conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
 created_by INTEGER NOT NULL REFERENCES users(id),
 name TEXT NOT NULL,
 instructions TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('schedule','ticket.created','customer.replied','ticket.merged','ticket.duplicate_candidate')),
 source TEXT NOT NULL DEFAULT '',
 schedule_json TEXT,
 timezone TEXT NOT NULL DEFAULT 'UTC',
 enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
 next_run_at TEXT,
 created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO bot_routines_new (id,conversation_id,created_by,name,instructions,kind,source,schedule_json,timezone,enabled,next_run_at,created_at)
 SELECT id,conversation_id,created_by,name,instructions,kind,source,schedule_json,timezone,enabled,next_run_at,created_at FROM bot_routines;
DROP TABLE bot_routines;
ALTER TABLE bot_routines_new RENAME TO bot_routines;
CREATE INDEX bot_routines_due ON bot_routines(enabled,next_run_at);
