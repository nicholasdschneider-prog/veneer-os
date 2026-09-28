import { z } from 'zod';
export const timingKey = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/);
export const timingHash = z.string().regex(/^[a-f0-9]{64}$/);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0,10) === v, 'Invalid calendar date');
const window = z.object({start:date,end:date}).strict().refine(v=>v.start<=v.end,'Invalid delivery window');
export const timingOrigin = z.string().url().refine(v=>{const u=new URL(v);return u.protocol==='https:' && !u.username && !u.password && u.pathname==='/' && !u.search && !u.hash && u.origin===v;},'Canonical HTTPS origin required');
export const timingScopeSchema = z.object({
  schema_version:z.literal('orderops-purchase-timing-material/v1'),
  business_id:timingKey,account_id:timingKey,source_origin:timingOrigin,principal_id:timingKey,executor_id:timingKey,
  order_id:timingKey,order_number:timingKey,shopify_order_id:timingKey,
  lines:z.array(z.object({order_line_id:timingKey,shopify_line_id:timingKey,sku:timingKey,quantity:z.number().int().positive().safe()}).strict()).min(1).max(200)
    .refine(v=>new Set(v.map(x=>x.order_line_id)).size===v.length && new Set(v.map(x=>x.shopify_line_id)).size===v.length && v.every((x,i)=>i===0 || v[i-1]!.order_line_id<x.order_line_id),'Unique lines in ascending order_line_id order required'),
  amount_cents:z.number().int().positive().safe(),currency:z.string().regex(/^[A-Z]{3}$/),
  original_delivery:window,checkout_delivery:window,
  timezone:z.string().max(100).refine(v=>{try{new Intl.DateTimeFormat('en',{timeZone:v});return true;}catch{return false;}},'IANA timezone required'),
  source_action_id:timingKey,source_proposal_version:timingKey,material_version:timingKey,cart_version:timingKey,
  material_fingerprint:timingHash,authorization_expires_at:z.string().datetime(),
}).strict();
export const timingProposalSchema=z.object({schema_version:z.literal('veneer-purchase-timing-proposal/v1'),capture_id:timingKey,scope:timingScopeSchema}).strict();
export const timingCaptureSchema=z.object({schema_version:z.literal('veneer-purchase-timing-capture/v1'),trust_id:timingKey,request_key:timingKey,captured_at:z.string().datetime(),scope:timingScopeSchema}).strict();
export const timingRequestSchema=z.object({schema_version:z.literal('veneer-purchase-timing-request/v1'),trust_id:timingKey,request_key:timingKey,decision_id:timingKey,decision_version:z.number().int().positive(),native_proposal_hash:timingHash,source_capture_id:timingKey}).strict();
export const timingEnrollmentSchema=z.object({request_key:timingKey,business_id:timingKey,executor_id:timingKey,source_origin:timingOrigin,account_id:timingKey,principal_id:timingKey,source_deployment:timingKey,custody_receipt:timingKey}).strict();
export type TimingScope=z.infer<typeof timingScopeSchema>;
export type TimingRequest=z.infer<typeof timingRequestSchema>;
// Strict wire responses. The three hash namespaces are deliberately separate.
export const timingProofSchema=z.object({schema_version:z.literal('veneer-purchase-timing/v1'),trust_id:timingKey,decision_id:timingKey,decision_version:z.number().int().positive(),native_proposal_hash:timingHash,source_scope_hash:timingHash,source_material_fingerprint:timingHash,source_material_schema:z.literal('orderops-purchase-timing-material/v1'),scope:timingScopeSchema,approval_event_id:timingKey,approver_id:z.number().int().positive(),approved_at:z.string().datetime(),verified_at:z.string().datetime(),expires_at:z.string().datetime(),timing_only:z.literal(true)}).strict();
export const timingCaptureResponseSchema=z.object({schema_version:z.literal('veneer-purchase-timing/v1'),capture_id:timingKey,source_scope_hash:timingHash,execute:z.literal(false)}).strict();
export const timingVerifyResponseSchema=timingProofSchema.extend({execute:z.literal(false)}).strict();
export const timingClaimResponseSchema=z.object({schema_version:z.literal('veneer-purchase-timing/v1'),claim_id:timingKey,request_key:timingKey,receipt:timingProofSchema,execute:z.boolean(),status:z.literal('claimed'),reconciliation_only:z.boolean()}).strict().refine(p=>p.execute!==p.reconciliation_only,'Only a first claim permits execution');
export const timingExecutionResponseSchema=timingProofSchema.extend({claim_id:timingKey,request_key:timingKey,execute:z.literal(false),applicable:z.literal(true),reconciliation_only:z.literal(false)}).strict();

/** Native watermark, captured inside the human answer transaction. Bot replies
 * cannot advance it; any later human instruction conservatively invalidates proof. */
export function timingHumanContext(db:import('better-sqlite3').Database,conversationId:string,decisionId:string){
 const direct=db.prepare('SELECT COALESCE(max(rowid),0) AS n FROM bot_human_messages WHERE conversation_id=?').get(conversationId) as {n:number};
 const result=db.prepare('SELECT COALESCE(max(r.seq),0) AS n FROM bot_message_replies r JOIN bot_message_threads t ON t.id=r.thread_id WHERE t.conversation_id=? AND r.actor_conversation_id IS NULL').get(conversationId) as {n:number};
 const discussion=db.prepare('SELECT COALESCE(max(rowid),0) AS n FROM bot_decision_threads WHERE decision_id=? AND actor_conversation_id IS NULL').get(decisionId) as {n:number};
 return {direct:direct.n,result:result.n,discussion:discussion.n};
}
