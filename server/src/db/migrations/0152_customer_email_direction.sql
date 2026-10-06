-- Dedicated prospective authority. No backfill or ordinary authorization rewrite.
CREATE TABLE customer_email_enrollments(registration_id TEXT PRIMARY KEY,registration_hash TEXT NOT NULL,owner_id INTEGER NOT NULL REFERENCES users(id),request_key TEXT NOT NULL UNIQUE,evidence_json TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE customer_email_enrollment_revocations(registration_id TEXT PRIMARY KEY REFERENCES customer_email_enrollments(registration_id),owner_id INTEGER NOT NULL REFERENCES users(id),reason TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE customer_email_authorities(id TEXT PRIMARY KEY,action_id TEXT NOT NULL UNIQUE,action_fence TEXT NOT NULL UNIQUE,source_owner_id TEXT NOT NULL REFERENCES conversations(id),source_kind TEXT NOT NULL,source_id TEXT NOT NULL,executor_id TEXT NOT NULL REFERENCES conversations(id),draft_id TEXT NOT NULL REFERENCES bot_message_drafts(id),business_id TEXT NOT NULL,account TEXT NOT NULL,recipient TEXT NOT NULL,request_key TEXT NOT NULL,request_hash TEXT NOT NULL,projection_json TEXT NOT NULL,native_json TEXT NOT NULL,review_json TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(source_kind,source_id),UNIQUE(source_owner_id,request_key));
CREATE TABLE customer_email_events(id TEXT PRIMARY KEY,authority_id TEXT NOT NULL REFERENCES customer_email_authorities(id),kind TEXT NOT NULL CHECK(kind IN ('accepted','reserved','revoked')),actor_id INTEGER NOT NULL REFERENCES users(id),actor_conversation_id TEXT NOT NULL REFERENCES conversations(id),request_key TEXT NOT NULL,request_hash TEXT NOT NULL,payload_json TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(authority_id,kind));
CREATE TABLE customer_email_associations(id TEXT PRIMARY KEY,authority_id TEXT NOT NULL UNIQUE REFERENCES customer_email_authorities(id),registration_id TEXT NOT NULL,intent_id TEXT NOT NULL,request_key TEXT NOT NULL,request_hash TEXT NOT NULL,binding_json TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(registration_id,intent_id),UNIQUE(registration_id,request_key));
CREATE TABLE customer_email_readbacks(id TEXT PRIMARY KEY,association_id TEXT NOT NULL REFERENCES customer_email_associations(id),state TEXT NOT NULL CHECK(state IN ('UNKNOWN','NO_EFFECT','SENT_ACCEPTED')),evidence_hash TEXT NOT NULL,evidence_json TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(association_id,evidence_hash));
CREATE UNIQUE INDEX customer_email_provider_receipt ON customer_email_readbacks(json_extract(evidence_json,'$.receipt.account'),json_extract(evidence_json,'$.receipt.providerMessageId')) WHERE state='SENT_ACCEPTED';
-- Native ordinary/delegated/routine claims serialize with this permanent recipient
-- fence. Source accepted guard adoption must serialize return and cross-channel intents.
CREATE TRIGGER customer_email_ordinary_claim BEFORE UPDATE OF claim_key,state,payload_json,conversation_id ON bot_message_drafts
WHEN (NEW.claim_key IS NOT NULL OR NEW.state IN ('sending','sent','uncertain')) AND EXISTS (
 SELECT 1 FROM customer_email_authorities a JOIN compose_context_memberships m ON m.business_id=a.business_id AND m.conversation_id=NEW.conversation_id
 WHERE lower(a.account)=lower(json_extract(NEW.payload_json,'$.account')) AND json_extract(NEW.payload_json,'$.channel')='email' AND EXISTS(SELECT 1 FROM json_each(NEW.payload_json,'$.recipients') WHERE lower(value)=lower(a.recipient)))
BEGIN SELECT RAISE(ABORT,'Customer email action fenced; original dedicated service only'); END;
CREATE TRIGGER customer_email_insert_claim BEFORE INSERT ON bot_message_drafts
WHEN (NEW.claim_key IS NOT NULL OR NEW.state IN ('sending','sent','uncertain')) AND EXISTS (
 SELECT 1 FROM customer_email_authorities a JOIN compose_context_memberships m ON m.business_id=a.business_id AND m.conversation_id=NEW.conversation_id
 WHERE lower(a.account)=lower(json_extract(NEW.payload_json,'$.account')) AND json_extract(NEW.payload_json,'$.channel')='email' AND EXISTS(SELECT 1 FROM json_each(NEW.payload_json,'$.recipients') WHERE lower(value)=lower(a.recipient)))
BEGIN SELECT RAISE(ABORT,'Customer email action fenced; original dedicated service only'); END;
CREATE TRIGGER customer_email_enrollments_no_update BEFORE UPDATE ON customer_email_enrollments BEGIN SELECT RAISE(ABORT,'Immutable customer email audit and fence'); END;
CREATE TRIGGER customer_email_enrollments_no_delete BEFORE DELETE ON customer_email_enrollments BEGIN SELECT RAISE(ABORT,'Immutable customer email audit and fence'); END;
CREATE TRIGGER customer_email_enrollment_revocations_no_update BEFORE UPDATE ON customer_email_enrollment_revocations BEGIN SELECT RAISE(ABORT,'Immutable customer email audit and fence'); END;
CREATE TRIGGER customer_email_enrollment_revocations_no_delete BEFORE DELETE ON customer_email_enrollment_revocations BEGIN SELECT RAISE(ABORT,'Immutable customer email audit and fence'); END;
CREATE TRIGGER customer_email_authorities_no_update BEFORE UPDATE ON customer_email_authorities BEGIN SELECT RAISE(ABORT,'Immutable customer email audit and fence'); END;
CREATE TRIGGER customer_email_authorities_no_delete BEFORE DELETE ON customer_email_authorities BEGIN SELECT RAISE(ABORT,'Immutable customer email audit and fence'); END;
CREATE TRIGGER customer_email_events_no_update BEFORE UPDATE ON customer_email_events BEGIN SELECT RAISE(ABORT,'Immutable customer email audit and fence'); END;
CREATE TRIGGER customer_email_events_no_delete BEFORE DELETE ON customer_email_events BEGIN SELECT RAISE(ABORT,'Immutable customer email audit and fence'); END;
CREATE TRIGGER customer_email_associations_no_update BEFORE UPDATE ON customer_email_associations BEGIN SELECT RAISE(ABORT,'Immutable customer email audit and fence'); END;
CREATE TRIGGER customer_email_associations_no_delete BEFORE DELETE ON customer_email_associations BEGIN SELECT RAISE(ABORT,'Immutable customer email audit and fence'); END;
CREATE TRIGGER customer_email_readbacks_no_update BEFORE UPDATE ON customer_email_readbacks BEGIN SELECT RAISE(ABORT,'Immutable customer email audit and fence'); END;
CREATE TRIGGER customer_email_readbacks_no_delete BEFORE DELETE ON customer_email_readbacks BEGIN SELECT RAISE(ABORT,'Immutable customer email audit and fence'); END;

-- Verified structured canonical roots only; no prose or ticket alias parsing.
CREATE TRIGGER customer_email_prior_cross_action BEFORE INSERT ON customer_email_authorities
WHEN EXISTS(SELECT 1 FROM return_bridge_claims c JOIN return_bridge_mappings m ON m.id=c.mapping_id JOIN return_bridge_trust t ON t.id=m.trust_id WHERE t.business_id=NEW.business_id AND (json_extract(m.capture_json,'$.conversation.id')=json_extract(NEW.projection_json,'$.canonicalCaseId') OR json_extract(m.capture_json,'$.order.id')=json_extract(NEW.projection_json,'$.canonicalOrderId')))
OR EXISTS(SELECT 1 FROM bot_composed_sms_authorities s JOIN compose_context_memberships m ON m.conversation_id=s.executor_id AND m.business_id=NEW.business_id WHERE s.source_id=NEW.source_id OR json_extract(s.snapshot_json,'$.scope.canonical_case')=json_extract(NEW.projection_json,'$.canonicalCaseId') OR json_extract(s.snapshot_json,'$.scope.contact_case')=json_extract(NEW.projection_json,'$.canonicalCaseId'))
BEGIN SELECT RAISE(ABORT,'Permanent shared native return/SMS action fence'); END;
CREATE TRIGGER customer_email_return_claim BEFORE INSERT ON return_bridge_claims
WHEN EXISTS(SELECT 1 FROM return_bridge_mappings m JOIN return_bridge_trust t ON t.id=m.trust_id JOIN customer_email_authorities a ON a.business_id=t.business_id WHERE m.id=NEW.mapping_id AND (json_extract(m.capture_json,'$.conversation.id')=json_extract(a.projection_json,'$.canonicalCaseId') OR json_extract(m.capture_json,'$.order.id')=json_extract(a.projection_json,'$.canonicalOrderId')))
BEGIN SELECT RAISE(ABORT,'Permanent shared native customer email action fence'); END;
CREATE TRIGGER customer_email_sms_authority BEFORE INSERT ON bot_composed_sms_authorities
WHEN EXISTS(SELECT 1 FROM customer_email_authorities a JOIN compose_context_memberships m ON m.business_id=a.business_id AND m.conversation_id=NEW.executor_id WHERE a.source_id=NEW.source_id OR json_extract(NEW.snapshot_json,'$.scope.canonical_case')=json_extract(a.projection_json,'$.canonicalCaseId') OR json_extract(NEW.snapshot_json,'$.scope.contact_case')=json_extract(a.projection_json,'$.canonicalCaseId'))
BEGIN SELECT RAISE(ABORT,'Permanent shared native customer email action fence'); END;
