import { z } from 'zod';
import { factsSchema, hash, H, requestSchema } from './contract.js';
const id = z.string().uuid(), time = z.string().datetime({offset:true});
const ref = z.string().min(1).max(200);
const numeric = z.string().regex(/^[1-9][0-9]*$/);
export const observationSchema = z.object({
  schemaVersion:z.literal('qbo-bill-observation/v1'), reservationId:id, businessId:id,
  existingGrantRef:ref, companyRealm:numeric, executorConversationId:id,
  billId:numeric, syncToken:z.string().regex(/^[0-9]+$/), sourceRevision:hash,
  resultDigest:hash, observedAt:time, expiresAt:time,
}).strict();
export const operationV2Schema = z.object({
  kind:z.enum(['read-bill','create-bill','update-bill','attach-pdf','verify-attachment']),
  target:z.object({entity:z.literal('Bill'),id:numeric.nullable(),syncToken:z.string().regex(/^[0-9]+$/).nullable()}).strict(),
  payloadHash:hash,
  providerRequest:z.object({method:z.enum(['GET','POST']),path:z.string().regex(/^\/(bill(?:\/[1-9][0-9]*)?|upload|query)$/)}).strict(),
  attachments:requestSchema.shape.operation.innerType().shape.attachments,
  sourceContext:requestSchema.shape.operation.innerType().shape.sourceContext,
  sourceContextHash:hash, observationHash:hash.nullable(),
}).strict().superRefine((v,c)=>{
  const create=v.kind==='create-bill', read=v.kind==='read-bill', update=v.kind==='update-bill';
  const valid=create ? v.target.id===null && v.target.syncToken===null && v.observationHash===null
    : v.target.id!==null && (read ? v.target.syncToken===null && v.observationHash===null
      : v.observationHash!==null && (update ? v.target.syncToken!==null : v.target.syncToken===null));
  const path=v.kind==='read-bill'?'/bill/'+v.target.id:v.kind==='attach-pdf'?'/upload':v.kind==='verify-attachment'?'/query':'/bill';
  const method=['read-bill','verify-attachment'].includes(v.kind)?'GET':'POST';
  if(v.providerRequest.path!==path||v.providerRequest.method!==method)c.addIssue({code:'custom',message:'Provider operation mismatch'});
  if(!valid || v.attachments.length!==(['attach-pdf','verify-attachment'].includes(v.kind)?1:0)) c.addIssue({code:'custom',message:'Exact operation preconditions required'});
  if(v.sourceContextHash!==H('qbo/source-context/v1',v.sourceContext))c.addIssue({code:'custom',message:'Source context mismatch'});
});
export const requestV2Schema = requestSchema.extend({schemaVersion:z.literal('qbo-operation/v2'),operation:operationV2Schema}).strict();
export const helperDescriptorSchema = z.object({
  runtime:z.enum(['python','node']), dependencyClosureHash:hash,
  executable:z.object({path:z.string().startsWith('/'),sha256:hash}).strict(),
  script:z.object({path:z.string().startsWith('/'),sha256:hash}).strict(),
  dependencies:z.array(z.object({path:z.string().startsWith('/'),sha256:hash}).strict()).max(32),
  uid:z.number().int().nonnegative().safe(), acceptanceHash:hash,
}).strict();
export const factsV2Schema = factsSchema.extend({operation:operationV2Schema,helper:helperDescriptorSchema}).strict();
export type FactsV2=z.infer<typeof factsV2Schema>;
export type RequestV2=z.infer<typeof requestV2Schema>;
export type HelperDescriptor=z.infer<typeof helperDescriptorSchema>;
export const authorityScopeV2=(f:FactsV2)=>H('qbo/authority-scope/v2',{businessId:f.businessId,accountRef:f.accountRef,existingGrantRef:f.existingGrantRef,companyRealm:f.companyRealm,executorConversationId:f.executorConversationId,operation:f.operation});
export const helperHash=(h:HelperDescriptor)=>H('qbo/helper-process/v1',h);
export const bytesSchema=z.object({payloadBase64:z.string().max(2*1024*1024),attachmentsBase64:z.array(z.string().max(36*1024*1024)).max(1)}).strict();
export const invokeSchema=z.object({request:requestV2Schema,bytes:bytesSchema}).strict();
export const eventSchema=z.object({
  schemaVersion:z.literal('qbo-helper-event/v2'),invocationId:id,receiptId:id,
  sequence:z.number().int().positive().safe(),previousHash:hash,
  action:z.enum(['refresh-start','refresh-confirmed','persistence-confirmed','persistence-uncertain','dispatch-start','dispatch-accepted','dispatch-unknown','stop']),
  evidenceHash:hash,providerRequestHash:hash.nullable(),
  billResult:z.object({billId:numeric,companyRealm:numeric,syncToken:z.string().regex(/^[0-9]+$/),sourceRevision:hash,resultDigest:hash,capturedAt:time}).strict().nullable(),
}).strict();
export type HelperEvent=z.infer<typeof eventSchema>;
export const phaseSchema=z.object({
  schemaVersion:z.literal('qbo-phase/v2'),invocationId:id,reservationId:id,jobId:id,effectDigest:hash,scopeHash:hash,payloadHash:hash,
  receiptId:id,sequence:z.number().int().nonnegative().safe(),previousHash:hash.nullable(),eventHash:hash,
  recordedAt:time,refresh:z.enum(['not-started','started','confirmed','UNKNOWN']),
  persistence:z.enum(['not-applicable','uncertain','confirmed']),
  persistenceReason:z.enum(['refresh-not-started','rotation-may-have-occurred','durable-rotation-confirmed']),
  dispatch:z.enum(['not-started','started','accepted','UNKNOWN']),providerRequestHash:hash.nullable(),
  evidenceHash:hash,closed:z.boolean(),observationHash:hash.nullable(),
}).strict();
export type Phase=z.infer<typeof phaseSchema>;
export const readV2Schema=z.object({execute:z.literal(false),refreshEntitlement:z.literal(false),operationEntitlement:z.literal(false),retryAllowed:z.literal(false),status:z.enum(['ABSENT','RESERVED']),phaseProof:z.enum(['ABSENT','V1_ONLY','V2']),phases:z.array(phaseSchema).max(100),observation:observationSchema.nullable()}).strict();

export const providerRequestHash=(r:RequestV2,f:FactsV2)=>H('qbo/provider-request/v2',{companyRealm:f.companyRealm,requestKey:r.requestKey,method:r.operation.providerRequest.method,path:r.operation.providerRequest.path,payloadHash:r.operation.payloadHash,attachments:r.operation.attachments});
