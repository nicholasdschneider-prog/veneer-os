-- Standing authority for one fixed customer request on the ordinary send path.
-- The owner enrolls a policy; a named bot's exact-template draft is then queued
-- without a per-message approval. Claim, send-once and receipt are unchanged.
CREATE TABLE cs_standing_policies (
 id TEXT PRIMARY KEY,
 business_id TEXT NOT NULL REFERENCES business_teams(id),
 template_key TEXT NOT NULL,
 version INTEGER NOT NULL CHECK(version>0),
 issuer_id INTEGER NOT NULL REFERENCES users(id),
 request_key TEXT NOT NULL,
 daily_cap INTEGER NOT NULL CHECK(daily_cap BETWEEN 1 AND 200),
 snapshot_json TEXT NOT NULL,
 snapshot_hash TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT (datetime('now')),
 UNIQUE(business_id,template_key,version),
 UNIQUE(business_id,request_key)
);
CREATE TRIGGER cs_standing_policies_no_update BEFORE UPDATE ON cs_standing_policies BEGIN SELECT RAISE(ABORT,'Standing policy enrollment is immutable'); END;
CREATE TRIGGER cs_standing_policies_no_delete BEFORE DELETE ON cs_standing_policies BEGIN SELECT RAISE(ABORT,'Standing policy enrollment is immutable'); END;

CREATE TABLE cs_standing_policy_revocations (
 policy_id TEXT PRIMARY KEY REFERENCES cs_standing_policies(id),
 actor_id INTEGER NOT NULL REFERENCES users(id),
 reason TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TRIGGER cs_standing_policy_revocations_no_update BEFORE UPDATE ON cs_standing_policy_revocations BEGIN SELECT RAISE(ABORT,'Standing policy revocation is immutable'); END;
CREATE TRIGGER cs_standing_policy_revocations_no_delete BEFORE DELETE ON cs_standing_policy_revocations BEGIN SELECT RAISE(ABORT,'Standing policy revocation is immutable'); END;

-- One row per draft queued under a policy. authorized_by on the draft stays NULL:
-- no person approved this message, the policy did.
CREATE TABLE cs_standing_authorizations (
 draft_id TEXT PRIMARY KEY REFERENCES bot_message_drafts(id) ON DELETE CASCADE,
 policy_id TEXT NOT NULL REFERENCES cs_standing_policies(id),
 policy_version INTEGER NOT NULL,
 business_id TEXT NOT NULL REFERENCES business_teams(id),
 template_key TEXT NOT NULL,
 executor_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
 ticket TEXT NOT NULL COLLATE NOCASE,
 draft_version INTEGER NOT NULL,
 payload_hash TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT (datetime('now')),
 -- One request per ticket for the life of the business, across policy versions.
 UNIQUE(business_id,template_key,ticket)
);
CREATE INDEX cs_standing_authorizations_day ON cs_standing_authorizations(business_id,created_at);
CREATE TRIGGER cs_standing_authorizations_no_update BEFORE UPDATE ON cs_standing_authorizations BEGIN SELECT RAISE(ABORT,'Standing authorization audit is immutable'); END;
