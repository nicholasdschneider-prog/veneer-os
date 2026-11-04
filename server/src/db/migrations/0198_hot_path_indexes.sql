-- A browser status read scanned the whole audit table (143k rows) several times,
-- once per active browser, on the runner's event loop.
CREATE INDEX idx_veneer_browser_audit_conversation ON veneer_browser_audit(client_scope, conversation_id, id);
CREATE INDEX idx_veneer_browser_audit_conversation_action ON veneer_browser_audit(client_scope, conversation_id, action, id);
-- Routine wake checks and bot family lookups run for every queued turn.
CREATE INDEX idx_bot_routine_deliveries_wakeup ON bot_routine_deliveries(wakeup_id);
CREATE INDEX idx_coordination_lanes_owner ON coordination_lanes(owner_id);
