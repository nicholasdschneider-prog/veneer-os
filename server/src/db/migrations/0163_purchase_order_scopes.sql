-- Reviewed identity mapping only: no authority, decision answer or purchase fence changes.
CREATE TABLE purchase_order_scopes (
 source_id TEXT NOT NULL,
 order_id TEXT NOT NULL,
 order_number TEXT NOT NULL,
 evidence_reference TEXT NOT NULL,
 evidence_sha256 TEXT NOT NULL CHECK(length(evidence_sha256)=64),
 PRIMARY KEY(source_id,order_number), UNIQUE(source_id,order_id)
);
-- Genuine retained original Sage source readbacks, checked in build 655.
-- Only associate an already retained canonical receipt from this exact source.
INSERT INTO purchase_order_scopes
SELECT DISTINCT source_id,'087620d4-c538-4c02-8285-6004cd710766','100122466',
 '/Users/archerclawdington/Projects/ERVP/out/sage/100122466-original-source-current-20261007.json#eligibility.data.candidate',
 'ae5e1dda4405764bb6eb0c04aeb427a76b908f3fab7e468feaa752732c8b1c75'
FROM purchase_event_receipts WHERE source_id='90ef6920-4bbd-4bb9-852d-02868dd8b05b'
 AND json_extract(payload_json,'$.order_id')='087620d4-c538-4c02-8285-6004cd710766';
INSERT INTO purchase_order_scopes
SELECT DISTINCT source_id,'2e0f7eff-087d-4c60-80a2-1bf9ae353b33','100122455',
 '/Users/archerclawdington/Projects/ERVP/out/sage/lippert-ten-six-current-20261007.json',
 '2247948142c64a83ecd5d49dc6d1ab8f90efde88449de875ee20bbc8af755fcd'
FROM purchase_event_receipts WHERE source_id='90ef6920-4bbd-4bb9-852d-02868dd8b05b'
 AND json_extract(payload_json,'$.order_id')='2e0f7eff-087d-4c60-80a2-1bf9ae353b33';
CREATE TRIGGER purchase_order_scopes_no_update BEFORE UPDATE ON purchase_order_scopes BEGIN SELECT RAISE(ABORT,'Immutable source scope'); END;
CREATE TRIGGER purchase_order_scopes_no_delete BEFORE DELETE ON purchase_order_scopes BEGIN SELECT RAISE(ABORT,'Immutable source scope'); END;

-- Exact original source-custodian chat, not an assistant display-name match.
CREATE TABLE purchase_task_decision_owners (
 task_id TEXT PRIMARY KEY,
 source_id TEXT NOT NULL,
 conversation_id TEXT NOT NULL,
 evidence_reference TEXT NOT NULL
);
INSERT INTO purchase_task_decision_owners
SELECT b.task_id,b.source_id,c.id,'Original source Sage a6a9b2d4; build655 coordination 8b174872-0a5e-4660-92da-de04a8da9574'
FROM purchase_event_bindings b JOIN scheduled_tasks t ON t.id=b.task_id
JOIN conversations c ON c.id='a6a9b2d4-384c-423a-a2fa-4f623aaeeb98'
 AND c.user_id=t.user_id AND c.project_id=t.project_id AND c.assistant_id=t.assistant_id
WHERE b.source_id='90ef6920-4bbd-4bb9-852d-02868dd8b05b' AND b.task_id='9c72a42a-40df-4477-9ba6-07f74ac08bf3';
CREATE TRIGGER purchase_task_decision_owners_no_update BEFORE UPDATE ON purchase_task_decision_owners BEGIN SELECT RAISE(ABORT,'Immutable source owner'); END;
CREATE TRIGGER purchase_task_decision_owners_no_delete BEFORE DELETE ON purchase_task_decision_owners BEGIN SELECT RAISE(ABORT,'Immutable source owner'); END;
