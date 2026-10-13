-- Technical phase evidence only; no grants, enrollment or accounting assignment.
CREATE TABLE qbo_v2_invocations (
 id TEXT PRIMARY KEY REFERENCES qbo_operation_reservations(id),
 grant_digest TEXT NOT NULL, request_json TEXT NOT NULL, facts_json TEXT NOT NULL
);
CREATE TABLE qbo_v2_phases (
 receipt_id TEXT PRIMARY KEY, invocation_id TEXT NOT NULL REFERENCES qbo_v2_invocations(id),
 sequence INTEGER NOT NULL, event_hash TEXT NOT NULL, phase_hash TEXT NOT NULL UNIQUE, phase_json TEXT NOT NULL,
 UNIQUE(invocation_id,sequence)
);
CREATE TABLE qbo_bill_observations (
 hash TEXT PRIMARY KEY, invocation_id TEXT NOT NULL UNIQUE REFERENCES qbo_v2_invocations(id), observation_json TEXT NOT NULL
);
CREATE TRIGGER qbo_v2_invocations_no_update BEFORE UPDATE ON qbo_v2_invocations BEGIN SELECT RAISE(ABORT,'Immutable QBO invocation'); END;
CREATE TRIGGER qbo_v2_invocations_no_delete BEFORE DELETE ON qbo_v2_invocations BEGIN SELECT RAISE(ABORT,'Permanent QBO invocation'); END;
CREATE TRIGGER qbo_v2_phases_no_update BEFORE UPDATE ON qbo_v2_phases BEGIN SELECT RAISE(ABORT,'Immutable QBO phase'); END;
CREATE TRIGGER qbo_v2_phases_no_delete BEFORE DELETE ON qbo_v2_phases BEGIN SELECT RAISE(ABORT,'Permanent QBO phase'); END;
CREATE TRIGGER qbo_observations_no_update BEFORE UPDATE ON qbo_bill_observations BEGIN SELECT RAISE(ABORT,'Immutable QBO observation'); END;
CREATE TRIGGER qbo_observations_no_delete BEFORE DELETE ON qbo_bill_observations BEGIN SELECT RAISE(ABORT,'Permanent QBO observation'); END;
