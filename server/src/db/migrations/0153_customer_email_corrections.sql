-- Correct rejected v1 without rewriting immutable authority/audit or migration history.
ALTER TABLE customer_email_authorities ADD COLUMN binding_hash TEXT;
-- Only native authenticated, exact original provider acceptance releases OVERLAP.
-- Original source/action/draft/intent/key/UNKNOWN audits remain permanently fenced.
CREATE VIEW customer_email_completed_actions AS
SELECT a.id FROM customer_email_authorities a
JOIN customer_email_associations x ON x.authority_id=a.id
JOIN customer_email_events e ON e.authority_id=a.id AND e.kind='reserved'
JOIN customer_email_events accepted ON accepted.authority_id=a.id AND accepted.kind='accepted'
JOIN customer_email_readbacks b ON b.association_id=x.id AND b.state='SENT_ACCEPTED'
WHERE a.binding_hash IS NOT NULL
 AND json_extract(a.projection_json,'$.schemaVersion')='customer-email-direction-dispatch/v2'
 AND json_extract(b.evidence_json,'$.schemaVersion')='customer-email-intent/v1'
 AND json_extract(b.evidence_json,'$.state')='SENT_ACCEPTED'
 AND json_extract(b.evidence_json,'$.preProviderCommitted')=1
 AND json_extract(b.evidence_json,'$.associationId')=x.id
 AND json_extract(b.evidence_json,'$.authorityId')=a.id
 AND json_extract(b.evidence_json,'$.authorityHash')=json_extract(x.binding_json,'$.input.authority_hash')
 AND json_extract(b.evidence_json,'$.claimId')=e.id
 AND json_extract(b.evidence_json,'$.intentId')=x.intent_id
 AND json_extract(b.evidence_json,'$.requestKey')=x.request_key
 AND json_extract(b.evidence_json,'$.registrationId')=x.registration_id
 AND json_extract(b.evidence_json,'$.principalId')=json_extract(a.projection_json,'$.executorPrincipalId')
 AND json_extract(b.evidence_json,'$.payloadHash')=json_extract(a.projection_json,'$.payloadHash')
 AND json_extract(b.evidence_json,'$.contextRevision')=json_extract(a.projection_json,'$.contextRevision')
 AND json_extract(b.evidence_json,'$.materialHash')=json_extract(a.projection_json,'$.materialHash')
 AND json_extract(b.evidence_json,'$.idempotencyKey')=json_extract(a.projection_json,'$.idempotencyKey')
 AND json_extract(b.evidence_json,'$.receipt.provider')='gmail'
 AND length(json_extract(b.evidence_json,'$.receipt.providerMessageId'))>0
 AND length(json_extract(b.evidence_json,'$.receipt.messageId'))>0
 AND json_extract(b.evidence_json,'$.receipt.account')=a.account
 AND json_extract(b.evidence_json,'$.receipt.recipient')=a.recipient
 AND json_extract(b.evidence_json,'$.receipt.subject')=json_extract(a.projection_json,'$.payload.subject')
 AND json_extract(b.evidence_json,'$.receipt.body')=json_extract(a.projection_json,'$.payload.body')
 AND json_extract(b.evidence_json,'$.receipt.payloadHash')=json_extract(a.projection_json,'$.payloadHash')
 AND json_extract(b.evidence_json,'$.receipt.idempotencyKey')=json_extract(a.projection_json,'$.idempotencyKey')
 AND json_array_length(b.evidence_json,'$.receipt.attachments')=0
 AND json_array_length(b.evidence_json,'$.receipt.cc')=0
 AND json_array_length(b.evidence_json,'$.receipt.bcc')=0;
CREATE VIEW customer_email_overlap_locks AS SELECT a.* FROM customer_email_authorities a
 WHERE NOT EXISTS(SELECT 1 FROM customer_email_completed_actions c WHERE c.id=a.id);
DROP TRIGGER customer_email_ordinary_claim;
DROP TRIGGER customer_email_insert_claim;
DROP TRIGGER customer_email_return_claim;
DROP TRIGGER customer_email_sms_authority;
CREATE TRIGGER customer_email_ordinary_claim BEFORE UPDATE OF claim_key,state,payload_json,conversation_id ON bot_message_drafts
WHEN (NEW.claim_key IS NOT NULL OR NEW.state IN ('sending','sent','uncertain')) AND (EXISTS (SELECT 1 FROM customer_email_authorities a WHERE a.draft_id=NEW.id)
OR EXISTS(SELECT 1 FROM customer_email_overlap_locks a JOIN compose_context_memberships m ON m.business_id=a.business_id AND m.conversation_id=NEW.conversation_id
 WHERE lower(a.account)=lower(json_extract(NEW.payload_json,'$.account')) AND json_extract(NEW.payload_json,'$.channel')='email'
 AND EXISTS(SELECT 1 FROM json_each(NEW.payload_json,'$.recipients') WHERE lower(value)=lower(a.recipient))))
BEGIN SELECT RAISE(ABORT,'Customer email original action or active overlap fenced'); END;
CREATE TRIGGER customer_email_insert_claim BEFORE INSERT ON bot_message_drafts
WHEN (NEW.claim_key IS NOT NULL OR NEW.state IN ('sending','sent','uncertain')) AND (EXISTS (SELECT 1 FROM customer_email_authorities a WHERE a.draft_id=NEW.id)
OR EXISTS(SELECT 1 FROM customer_email_overlap_locks a JOIN compose_context_memberships m ON m.business_id=a.business_id AND m.conversation_id=NEW.conversation_id
 WHERE lower(a.account)=lower(json_extract(NEW.payload_json,'$.account')) AND json_extract(NEW.payload_json,'$.channel')='email'
 AND EXISTS(SELECT 1 FROM json_each(NEW.payload_json,'$.recipients') WHERE lower(value)=lower(a.recipient))))
BEGIN SELECT RAISE(ABORT,'Customer email original action or active overlap fenced'); END;
CREATE TRIGGER customer_email_vendor_bind BEFORE INSERT ON bot_vendor_email_authorities WHEN EXISTS(SELECT 1 FROM customer_email_authorities a WHERE a.source_kind=NEW.source_kind AND a.source_id=NEW.source_id)
OR EXISTS(SELECT 1 FROM customer_email_overlap_locks a WHERE a.business_id=NEW.business_id AND lower(a.account)=lower(NEW.account) AND lower(a.recipient)=lower(NEW.recipient))
BEGIN SELECT RAISE(ABORT,'Customer email action fenced against vendor bind'); END;
CREATE TRIGGER customer_email_vendor_claim BEFORE INSERT ON bot_vendor_email_events WHEN NEW.kind='claimed' AND EXISTS(SELECT 1 FROM bot_vendor_email_authorities v JOIN customer_email_overlap_locks a ON a.business_id=v.business_id
 WHERE v.id=NEW.authority_id AND lower(a.account)=lower(v.account) AND lower(a.recipient)=lower(v.recipient))
BEGIN SELECT RAISE(ABORT,'Customer email action fenced against vendor claim'); END;
CREATE TRIGGER customer_email_vendor_target_claim BEFORE UPDATE OF claim_key,state,authority_id ON bot_vendor_email_targets WHEN (NEW.claim_key IS NOT NULL OR NEW.state IN ('claimed','uncertain','sent')) AND EXISTS(SELECT 1 FROM bot_vendor_email_authorities v JOIN customer_email_overlap_locks a ON a.business_id=v.business_id
 WHERE v.id=NEW.authority_id AND lower(a.account)=lower(v.account) AND lower(a.recipient)=lower(v.recipient))
BEGIN SELECT RAISE(ABORT,'Customer email action fenced against vendor target claim'); END;
CREATE TRIGGER customer_email_reverse_bind BEFORE INSERT ON customer_email_authorities WHEN EXISTS(SELECT 1 FROM bot_vendor_email_authorities v WHERE v.source_kind=NEW.source_kind AND v.source_id=NEW.source_id)
OR EXISTS(SELECT 1 FROM bot_vendor_email_authorities v WHERE v.business_id=NEW.business_id AND lower(v.account)=lower(NEW.account) AND lower(v.recipient)=lower(NEW.recipient)) OR EXISTS(SELECT 1 FROM bot_message_drafts d JOIN compose_context_memberships m ON m.conversation_id=d.conversation_id AND m.business_id=NEW.business_id
 WHERE d.id<>NEW.draft_id AND (d.claim_key IS NOT NULL OR d.receipt IS NOT NULL OR d.authorized_by IS NOT NULL OR d.state IN ('queued','sending','sent','uncertain'))
 AND json_extract(d.payload_json,'$.channel')='email' AND lower(json_extract(d.payload_json,'$.account'))=lower(NEW.account)
 AND EXISTS(SELECT 1 FROM json_each(d.payload_json,'$.recipients') WHERE lower(value)=lower(NEW.recipient))) OR EXISTS(SELECT 1 FROM customer_email_authorities a WHERE a.draft_id=NEW.draft_id)
OR EXISTS(SELECT 1 FROM customer_email_overlap_locks a WHERE a.business_id=NEW.business_id AND
 ((lower(a.account)=lower(NEW.account) AND lower(a.recipient)=lower(NEW.recipient)) OR
 json_extract(a.projection_json,'$.canonicalOrderId')=json_extract(NEW.projection_json,'$.canonicalOrderId') OR
 json_extract(a.projection_json,'$.canonicalCaseId')=json_extract(NEW.projection_json,'$.canonicalCaseId')))
BEGIN SELECT RAISE(ABORT,'Competing email authority, attempt or unresolved overlap fenced'); END;
CREATE TRIGGER customer_email_reverse_reserve BEFORE INSERT ON customer_email_events WHEN NEW.kind IN ('accepted','reserved') AND EXISTS(SELECT 1 FROM customer_email_authorities a JOIN bot_vendor_email_authorities v ON v.business_id=a.business_id WHERE a.id=NEW.authority_id AND lower(v.account)=lower(a.account) AND lower(v.recipient)=lower(a.recipient))
BEGIN SELECT RAISE(ABORT,'Competing vendor action fenced at customer consumption'); END;
CREATE TRIGGER customer_email_reverse_associate BEFORE INSERT ON customer_email_associations WHEN EXISTS(SELECT 1 FROM customer_email_authorities a JOIN bot_vendor_email_authorities v ON v.business_id=a.business_id WHERE a.id=NEW.authority_id AND lower(v.account)=lower(a.account) AND lower(v.recipient)=lower(a.recipient))
BEGIN SELECT RAISE(ABORT,'Competing vendor action fenced at customer consumption'); END;
CREATE TRIGGER customer_email_sms_authority BEFORE INSERT ON bot_composed_sms_authorities
WHEN EXISTS(SELECT 1 FROM customer_email_authorities a WHERE a.source_id=NEW.source_id)
OR EXISTS(SELECT 1 FROM customer_email_overlap_locks a JOIN compose_context_memberships m ON m.business_id=a.business_id AND m.conversation_id=NEW.executor_id WHERE json_extract(NEW.snapshot_json,'$.scope.canonical_case')=json_extract(a.projection_json,'$.canonicalCaseId') OR json_extract(NEW.snapshot_json,'$.scope.contact_case')=json_extract(a.projection_json,'$.canonicalCaseId'))
BEGIN SELECT RAISE(ABORT,'Customer email original source or active SMS overlap fenced'); END;
CREATE TRIGGER customer_email_return_claim BEFORE INSERT ON return_bridge_claims
WHEN EXISTS(SELECT 1 FROM return_bridge_mappings m JOIN return_bridge_trust t ON t.id=m.trust_id JOIN customer_email_overlap_locks a ON a.business_id=t.business_id WHERE m.id=NEW.mapping_id AND (json_extract(m.capture_json,'$.conversation.id')=json_extract(a.projection_json,'$.canonicalCaseId') OR json_extract(m.capture_json,'$.order.id')=json_extract(a.projection_json,'$.canonicalOrderId')))
BEGIN SELECT RAISE(ABORT,'Customer email active return overlap fenced'); END;

-- SQL fallback preserves vendor/ordinary serialization even outside the normal
-- service transaction. Delegated/routine sends use the same native draft claim.
CREATE TRIGGER vendor_email_ordinary_claim BEFORE UPDATE OF claim_key,state,payload_json,conversation_id ON bot_message_drafts
WHEN (NEW.claim_key IS NOT NULL OR NEW.state IN ('sending','sent','uncertain')) AND EXISTS(
 SELECT 1 FROM bot_vendor_email_authorities v JOIN compose_context_memberships m ON m.business_id=v.business_id AND m.conversation_id=NEW.conversation_id
 WHERE json_extract(NEW.payload_json,'$.channel')='email' AND lower(v.account)=lower(json_extract(NEW.payload_json,'$.account'))
 AND EXISTS(SELECT 1 FROM json_each(NEW.payload_json,'$.recipients') WHERE lower(value)=lower(v.recipient)))
BEGIN SELECT RAISE(ABORT,'Vendor email active overlap fenced against ordinary claim'); END;
CREATE TRIGGER vendor_email_insert_claim BEFORE INSERT ON bot_message_drafts
WHEN (NEW.claim_key IS NOT NULL OR NEW.state IN ('sending','sent','uncertain')) AND EXISTS(
 SELECT 1 FROM bot_vendor_email_authorities v JOIN compose_context_memberships m ON m.business_id=v.business_id AND m.conversation_id=NEW.conversation_id
 WHERE json_extract(NEW.payload_json,'$.channel')='email' AND lower(v.account)=lower(json_extract(NEW.payload_json,'$.account'))
 AND EXISTS(SELECT 1 FROM json_each(NEW.payload_json,'$.recipients') WHERE lower(value)=lower(v.recipient)))
BEGIN SELECT RAISE(ABORT,'Vendor email active overlap fenced against ordinary claim'); END;
CREATE TRIGGER vendor_email_reverse_ordinary_bind BEFORE INSERT ON bot_vendor_email_authorities
WHEN EXISTS(SELECT 1 FROM (SELECT NEW.business_id AS business_id,NEW.account AS account,NEW.recipient AS recipient) v WHERE EXISTS(SELECT 1 FROM bot_message_drafts d JOIN compose_context_memberships m ON m.conversation_id=d.conversation_id AND m.business_id=v.business_id WHERE
 (d.claim_key IS NOT NULL OR d.receipt IS NOT NULL OR d.authorized_by IS NOT NULL OR d.state IN ('queued','sending','sent','uncertain'))
 AND json_extract(d.payload_json,'$.channel')='email' AND lower(json_extract(d.payload_json,'$.account'))=lower(v.account)
 AND EXISTS(SELECT 1 FROM json_each(d.payload_json,'$.recipients') WHERE lower(value)=lower(v.recipient))))
BEGIN SELECT RAISE(ABORT,'Existing ordinary authorized or attempted action fenced against vendor bind'); END;
CREATE TRIGGER vendor_email_reverse_ordinary_claim BEFORE INSERT ON bot_vendor_email_events
WHEN NEW.kind='claimed' AND EXISTS(SELECT 1 FROM bot_vendor_email_authorities v WHERE v.id=NEW.authority_id AND EXISTS(SELECT 1 FROM bot_message_drafts d JOIN compose_context_memberships m ON m.conversation_id=d.conversation_id AND m.business_id=v.business_id WHERE
 (d.claim_key IS NOT NULL OR d.receipt IS NOT NULL OR d.authorized_by IS NOT NULL OR d.state IN ('queued','sending','sent','uncertain'))
 AND json_extract(d.payload_json,'$.channel')='email' AND lower(json_extract(d.payload_json,'$.account'))=lower(v.account)
 AND EXISTS(SELECT 1 FROM json_each(d.payload_json,'$.recipients') WHERE lower(value)=lower(v.recipient))))
BEGIN SELECT RAISE(ABORT,'Existing ordinary authorized or attempted action fenced against vendor claim'); END;

CREATE TRIGGER customer_email_vendor_original_source_claim BEFORE INSERT ON bot_vendor_email_events
WHEN NEW.kind='claimed' AND EXISTS(SELECT 1 FROM bot_vendor_email_authorities v JOIN customer_email_authorities a ON a.source_kind=v.source_kind AND a.source_id=v.source_id WHERE v.id=NEW.authority_id)
BEGIN SELECT RAISE(ABORT,'Permanent original human source fenced against vendor claim'); END;
CREATE TRIGGER customer_email_vendor_original_source_target BEFORE UPDATE OF claim_key,state,authority_id ON bot_vendor_email_targets
WHEN (NEW.claim_key IS NOT NULL OR NEW.state IN ('claimed','uncertain','sent')) AND EXISTS(SELECT 1 FROM bot_vendor_email_authorities v JOIN customer_email_authorities a ON a.source_kind=v.source_kind AND a.source_id=v.source_id WHERE v.id=NEW.authority_id)
BEGIN SELECT RAISE(ABORT,'Permanent original human source fenced against vendor target claim'); END;
