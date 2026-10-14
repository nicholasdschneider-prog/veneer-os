import {z} from 'zod';
const id=z.string().min(1).max(500), hash=z.string().regex(/^[a-f0-9]{64}$/);
export const gmailBindingTargetSchema=z.object({
 decision_id:id,expected_version:z.number().int().positive(),draft_id:id,draft_version:z.number().int().positive(),
 thread_id:id,reply_message_id:id,reply_rfc_message_id:id,
}).strict();
export const gmailContextReviewSchema=z.object({
 approved_context_hash:hash,draft_context_hash:hash,
 interpretation:z.literal('operational_provenance_only'),
 // Complete contiguous citations, not keyword consent or a detached reviewer label.
 segments:z.array(z.object({start:z.number().int().nonnegative(),end:z.number().int().positive(),text:z.string().min(1).max(2000),
 classification:z.literal('provenance_without_authority_change'),explanation:z.string().min(20).max(2000)}).strict()).min(1).max(100),
 scope_explanation:z.string().min(20).max(2000),
}).strict();
export const gmailBindSchema=gmailBindingTargetSchema.extend({inspection_hash:hash,review:gmailContextReviewSchema,request_key:id}).strict();
export const gmailSourceSchema=z.object({
 schema_version:z.literal('approved-gmail-source/v1'),
 caller_id:id,user_id:z.number().int().positive(),business_id:id,connection_id:id,principal_id:id,custody_hash:hash,
 account:z.string().email(),thread_id:id,reply_message_id:id,reply_rfc_message_id:id,latest_inbound_id:id,
 recipients:z.array(z.string().email()).min(1).max(20),
 source_revision:hash,material_hash:hash,attachment_hashes:z.array(hash).max(10),
 observed_at:z.string().datetime(),expires_at:z.string().datetime(),
 // Independently verified by server-installed own-account reader, not caller input.
 decision_id:id,decision_version:z.number().int().positive(),scope_hash:hash,
}).strict();
export type GmailSource=z.infer<typeof gmailSourceSchema>;
export type GmailMappingEvidence=GmailSource & {schema_version:'approved-gmail-source/v1';fingerprint:string};
export type GmailTarget=z.infer<typeof gmailBindingTargetSchema>;

export const gmailBindingReceiptSchema=z.object({
 schema_version:z.literal('approved-gmail-binding/v1'),execute:z.literal(false),replayed:z.boolean(),
 delegation_id:id,draft_id:id,decision_id:id,decision_version:z.number().int().positive(),
 approved_payload_hash:hash,draft_payload_hash:hash,inspection_hash:hash,
}).strict();
