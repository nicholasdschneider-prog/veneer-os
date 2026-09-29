-- One permanent dispatch UUID across every native proof version. Historical
-- mappings are adopted only from immutable native records, never caller JSON.
CREATE TABLE compose_action_lineages (
 original_action_digest TEXT PRIMARY KEY,
 native_action_id TEXT NOT NULL UNIQUE,
 business_id TEXT NOT NULL,
 decision_id TEXT NOT NULL,
 authority_id TEXT NOT NULL UNIQUE REFERENCES bot_composed_sms_authorities(id),
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TRIGGER compose_action_lineages_no_update BEFORE UPDATE ON compose_action_lineages BEGIN SELECT RAISE(ABORT,'immutable action lineage'); END;
CREATE TRIGGER compose_action_lineages_no_delete BEFORE DELETE ON compose_action_lineages BEGIN SELECT RAISE(ABORT,'permanent action lineage'); END;
