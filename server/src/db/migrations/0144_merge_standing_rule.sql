-- Owner standing rule (addendum to the v4 merge contract): when two open
-- tickets share the same customer record and the same order, the bots may
-- merge them without a human question. The rule is the owner's own switch,
-- append-only, and every automatic approval is a decision record like any other.
CREATE TABLE merge_standing_policies(
 id TEXT PRIMARY KEY, registration_id TEXT NOT NULL, registration_hash TEXT NOT NULL, owner_id INTEGER NOT NULL,
 rule TEXT NOT NULL CHECK(rule IN ('same_customer_record_and_order')), enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
 reason TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
CREATE INDEX merge_standing_policies_registration ON merge_standing_policies(registration_id, created_at);
CREATE TABLE merge_standing_approvals(
 source_id TEXT NOT NULL, business_team_id TEXT NOT NULL, request_key TEXT NOT NULL, request_hash TEXT NOT NULL,
 pair_receipt_id TEXT NOT NULL REFERENCES merge_intents(pair_receipt_id), decision_id TEXT NOT NULL, decision_version INTEGER NOT NULL,
 intent_hash TEXT NOT NULL, answer_event_id TEXT NOT NULL, standing_policy_id TEXT NOT NULL REFERENCES merge_standing_policies(id),
 basis_json TEXT NOT NULL, response_json TEXT NOT NULL, created_at TEXT NOT NULL,
 PRIMARY KEY(source_id,business_team_id,request_key));
CREATE INDEX merge_standing_approvals_decision ON merge_standing_approvals(decision_id, decision_version);
CREATE TRIGGER merge_standing_policy_no_update BEFORE UPDATE ON merge_standing_policies BEGIN SELECT RAISE(ABORT,'Immutable standing rule history'); END;
CREATE TRIGGER merge_standing_policy_no_delete BEFORE DELETE ON merge_standing_policies BEGIN SELECT RAISE(ABORT,'Immutable standing rule history'); END;
CREATE TRIGGER merge_standing_approval_no_update BEFORE UPDATE ON merge_standing_approvals BEGIN SELECT RAISE(ABORT,'Immutable standing approval'); END;
CREATE TRIGGER merge_standing_approval_no_delete BEFORE DELETE ON merge_standing_approvals BEGIN SELECT RAISE(ABORT,'Immutable standing approval'); END;
