import {z} from 'zod';
import {obligationInspectionSchema} from './instructionObligations.js';
import type {Actor} from './service.js';
import type {ComposeBoundaryEvidence} from './composedSmsAuthority.js';
const id=z.string().min(1).max(200),hash=z.string().regex(/^[a-f0-9]{64}$/);
export const composedInspectionSchema=obligationInspectionSchema.extend({canonical_case:z.string().uuid(),contact_case:z.string().uuid()}).strict();
export type ComposedInput=z.infer<typeof composedInspectionSchema>;
const citation=z.object({id,text:z.string().min(1).max(12000)}).strict();
export const compositionReviewSchema=z.object({
 mode:z.enum(['compose_and_send','channel_only','ambiguous']), reviewed_full_context:z.literal(true),
 recipient_instruction:citation,composition_instruction:citation,channel_instruction:citation,
 purpose:z.string().min(1).max(1000),relationship_explanation:z.string().min(1).max(2000),
 customer_message_ids:z.array(id).min(2).max(20),
 parts:z.array(z.object({start:z.number().int().nonnegative(),end:z.number().int().positive(),
  assessment:z.enum(['supported','unsupported','ambiguous']),human_ids:z.array(id).max(20),message_ids:z.array(id).max(20),explanation:z.string().min(1).max(1000)}).strict()).min(1).max(100),
 unresolved_choices:z.array(z.string().min(1).max(500)).max(20),
}).strict();
export const deriveComposedSchema=composedInspectionSchema.extend({inspection_hash:hash,request_key:id,review:compositionReviewSchema}).strict();
// Only a server-owned authenticated reader can produce this object. It is never
// parsed from a tool request or copied evidence file. assertFresh rechecks custody.
export interface CompositionEvidence {
 projection: {cases:Array<{id:string;ticketNumber:string|null;customerId:string;relatedOrderId:string|null;customer:{phone:string|null}}>;messages:Array<{id:string;conversationId:string;direction:string|null;channel:string|null;messageType:string|null;body:string;fromPhone:string|null;actorType:string|null;actorId:string|null;agentId:string|null;aiGenerated:boolean|null}>};
 snapshot_hash:string;registration_hash:string;business_id:string;account_id:string;principal_id:string;
 sms_account:string;sender_phone:string;sender_verified:boolean;
 dispatch: {supported:boolean;contract:string|null;revision:string;reason:string};
 dispatch_material_hash?:string;
 boundary?:ComposeBoundaryEvidence;
 assertFresh:()=>void;
}
export type CompositionReader=(a:Actor,input:ComposedInput,owner:string)=>Promise<CompositionEvidence>;
