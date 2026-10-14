-- Prospective technical binding only. No production approval or enrollment.
CREATE TABLE approved_gmail_draft_bindings (
 decision_id TEXT PRIMARY KEY REFERENCES bot_decisions(id),
 delegation_id TEXT NOT NULL UNIQUE REFERENCES bot_message_delegations(id),
 draft_id TEXT NOT NULL UNIQUE REFERENCES bot_message_drafts(id),
 draft_version INTEGER NOT NULL,
 request_key TEXT NOT NULL,
 request_hash TEXT NOT NULL,
 action_hash TEXT NOT NULL UNIQUE,
 send_material_hash TEXT NOT NULL,
 draft_payload_hash TEXT NOT NULL,
 approved_payload_hash TEXT NOT NULL,
 target_json TEXT NOT NULL,
 review_json TEXT NOT NULL,
 inspection_hash TEXT NOT NULL,
 authority_context_hash TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TRIGGER approved_gmail_binding_no_update BEFORE UPDATE ON approved_gmail_draft_bindings BEGIN SELECT RAISE(ABORT,'Immutable approved Gmail binding'); END;
CREATE TRIGGER approved_gmail_binding_no_delete BEFORE DELETE ON approved_gmail_draft_bindings BEGIN SELECT RAISE(ABORT,'Permanent approved Gmail binding'); END;

CREATE TRIGGER approved_gmail_draft_material_immutable BEFORE UPDATE ON bot_message_drafts
WHEN EXISTS(SELECT 1 FROM approved_gmail_draft_bindings WHERE draft_id=OLD.id)
AND (NEW.payload_json IS NOT OLD.payload_json OR NEW.version IS NOT OLD.version OR NEW.conversation_id IS NOT OLD.conversation_id OR NEW.decision_id IS NOT OLD.decision_id OR NEW.decision_version IS NOT OLD.decision_version OR NEW.delegation_id IS NOT OLD.delegation_id OR NEW.authorized_by IS NOT OLD.authorized_by)
BEGIN SELECT RAISE(ABORT,'Immutable approved Gmail draft material'); END;
