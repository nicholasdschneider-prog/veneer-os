-- No accounting grants, assignments or enrollment are created here.
CREATE TABLE qbo_operation_reservations (
 id TEXT PRIMARY KEY, effect_digest TEXT NOT NULL UNIQUE,
 actor_user_id INTEGER NOT NULL, executor_id TEXT NOT NULL,
 request_key TEXT NOT NULL, request_hash TEXT NOT NULL,
 job_id TEXT NOT NULL, scope_hash TEXT NOT NULL, facts_hash TEXT NOT NULL,
 reservation_json TEXT NOT NULL,
 UNIQUE(executor_id,request_key)
);
CREATE TABLE qbo_operation_receipts (
 id TEXT PRIMARY KEY, reservation_id TEXT NOT NULL REFERENCES qbo_operation_reservations(id),
 receipt_hash TEXT NOT NULL UNIQUE, receipt_json TEXT NOT NULL
);
CREATE TRIGGER qbo_reservations_no_update BEFORE UPDATE ON qbo_operation_reservations BEGIN SELECT RAISE(ABORT,'Immutable QBO reservation'); END;
CREATE TRIGGER qbo_reservations_no_delete BEFORE DELETE ON qbo_operation_reservations BEGIN SELECT RAISE(ABORT,'Permanent QBO operation fence'); END;
CREATE TRIGGER qbo_receipts_no_update BEFORE UPDATE ON qbo_operation_receipts BEGIN SELECT RAISE(ABORT,'Immutable QBO receipt'); END;
CREATE TRIGGER qbo_receipts_no_delete BEFORE DELETE ON qbo_operation_receipts BEGIN SELECT RAISE(ABORT,'Permanent QBO receipt'); END;
