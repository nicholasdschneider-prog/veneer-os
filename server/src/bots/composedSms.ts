import {persistComposeDispatchAuthority,type ComposeBoundaryEvidence} from './composedSmsAuthority.js';
import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import {z} from 'zod';
import {canonicalSha256,canonicalJson} from './canonical.js';
import {BotError,createBotService,type Actor} from './service.js';
import {createInstructionObligations,obligationInspectionSchema} from './instructionObligations.js';
import {sendCheckSchema} from './messageDelegation.js';
import type {UserRow} from '../db/db.js';
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
type Authority={id:string;action_id:string;owner_id:string;executor_id:string;source_id:string;draft_id:string;request_key:string;request_hash:string;snapshot_json:string;expires_at:string;created_at:string};
type Native=ReturnType<ReturnType<typeof createInstructionObligations>['inspect']>;
function nativeInput(p:ComposedInput){const {canonical_case,contact_case,...input}=p;return input;}
export function composedSmsService(db:Database.Database,reader:CompositionReader,now=Date.now){
 const obligations=createInstructionObligations(db),bots=createBotService(db);
 function native(a:Actor,p:ComposedInput,authority?:Authority){
  const n=authority && a.conversationId===authority.executor_id && a.conversationId!==authority.owner_id
   ? obligations.inspectDerivedDependency(a,nativeInput(p),authority.id) : obligations.inspect(a,nativeInput(p));
  const owner=bots.chat(a,n.binding.source_owner),executor=bots.chat(a,p.executor_conversation_id);
  if(!a.conversationId||a.user.id!==owner.user_id||executor.user_id!==owner.user_id||!owner.business_team_id||executor.business_team_id!==owner.business_team_id)throw new BotError(403,'Exact active owner/executor business identity required');
  const human=db.prepare("SELECT * FROM users WHERE id=? AND status='active'").get(n.source.actor_id) as UserRow|undefined;
  const decision=db.prepare('SELECT * FROM bot_decisions WHERE id=?').get(n.existing_consumption.decision_id) as Parameters<typeof bots.view>[1];
  if(!human||!bots.view({user:human},decision).can_answer)throw new BotError(403,'Original human authority revoked');
  if(n.existing_consumption.action!=='approve'||n.missing_proof.some(x=>['CONSUMED_PROPOSAL_CHANGED','ORIGINAL_DIRECTION_NOT_ACTIVE_APPROVAL','EXISTING_EFFECT_OR_UNKNOWN_RECONCILE_ONLY','NOT_AN_UNBOUND_ORDINARY_DRAFT','OBLIGATION_REVOKED'].includes(x)))throw new BotError(409,'Original source, proposal, ordinary draft or intent is no longer eligible');
  const pld=n.draft.payload;
  if(pld.channel!=='sms'||pld.recipients.length!==1||!/^\+[1-9][0-9]{7,14}$/.test(pld.recipients[0])||pld.attachments.length||pld.subject||pld.body.length>1600)throw new BotError(409,'Only exact one-recipient plain SMS up to 1600 characters without attachments is supported');
  const duplicates=db.prepare("SELECT payload_json FROM bot_message_drafts WHERE conversation_id=? AND id<>? AND (claim_key IS NOT NULL OR receipt IS NOT NULL OR state IN ('sending','sent','uncertain')) AND json_extract(payload_json,'$.channel')='sms' AND json_extract(payload_json,'$.ticket')=? LIMIT 501").all(p.executor_conversation_id,p.draft_id,pld.ticket) as {payload_json:string}[];
  if(duplicates.length>500||duplicates.some(d=>canonicalSha256(JSON.parse(d.payload_json))===n.binding.payload_hash))throw new BotError(409,'Existing SMS duplicate or UNKNOWN requires reconciliation');
  return n;
 }
 function scope(n:Native,p:ComposedInput,e:CompositionEvidence,requireSender=true){
  e.assertFresh();const c=e.projection.cases.find(c=>c.id===p.canonical_case),s=e.projection.cases.find(c=>c.id===p.contact_case);
  if(!c||!s||p.canonical_case===p.contact_case||s.ticketNumber!==n.draft.payload.ticket||s.customer.phone!==n.draft.payload.recipients[0]||(requireSender&&(e.sms_account!==n.draft.payload.account||!e.sender_verified))||e.business_id!==n.binding.business_id)throw new BotError(409,'Authenticated case, recipient, sender or business evidence differs or remains unverified');
  const email=n.original_proposal.message_delivery;
  if(!email||email.canonical_case!==p.canonical_case)throw new BotError(409,'Original proposal canonical case differs');
  return {input:p,native_hash:n.inspection_hash,evidence_hash:e.snapshot_hash,registration_hash:e.registration_hash,business_id:e.business_id,source_account:e.account_id,sms_sender:e.sender_phone,dispatch_hash:canonicalSha256(e.dispatch),payload_hash:n.binding.payload_hash};
 }
 function review(n:Native,e:CompositionEvidence,p:ComposedInput,r:z.infer<typeof compositionReviewSchema>){
  if(r.mode!=='compose_and_send'||r.unresolved_choices.length)throw new BotError(409,'Composition discretion or a material choice remains unresolved; channel direction alone is insufficient');
  const humans=(n.context.direct_messages as Array<{id:string;actor_id:number;text:string}>).filter(x=>x.actor_id===n.source.actor_id);
  for(const cite of [r.recipient_instruction,r.composition_instruction,r.channel_instruction])if(!humans.some(x=>x.id===cite.id&&x.text===cite.text))throw new BotError(409,'Review must cite exact complete authenticated human instructions');
  // A channel-only message cannot stand alone as evidence of substantive composition.
  if(r.composition_instruction.id===r.channel_instruction.id)throw new BotError(409,'This multi-action continuation requires independently retained substantive composition context');
  const messages=e.projection.messages;
  const cited=r.customer_message_ids.map(id=>messages.find(m=>m.id===id));
  if(cited.some(m=>!m||m.direction!=='inbound'||m.messageType!=='message'||!['email','sms'].includes(m.channel??'')||m.aiGenerated||m.actorType||m.actorId||m.agentId)||
    !cited.some(m=>m!.conversationId===p.canonical_case)||!cited.some(m=>m!.conversationId===p.contact_case&&m!.channel==='sms'&&m!.fromPhone===n.draft.payload.recipients[0]))throw new BotError(409,'Cite customer-origin evidence from both exact cases, including the exact recipient');
  let cursor=0;
  for(const part of r.parts){
   if(part.start!==cursor||part.end<=part.start||part.end>n.draft.payload.body.length||part.assessment!=='supported'||!part.human_ids.length||part.human_ids.some(id=>!humans.some(h=>h.id===id))||part.message_ids.some(id=>!messages.some(m=>m.id===id)))throw new BotError(409,'Every exact draft character requires supported scope review with authenticated citations; additions or ambiguity cannot pass');
   cursor=part.end;
  }
  if(cursor!==n.draft.payload.body.length)throw new BotError(409,'Incomplete exact body review');
 }
 function read(a:Actor,id:string){
  const g=db.prepare('SELECT * FROM bot_composed_sms_authorities WHERE id=?').get(id) as Authority|undefined;
  if(!g)throw new BotError(404,'Derived authority not found');
  if(!a.conversationId||![g.owner_id,g.executor_id].includes(a.conversationId))throw new BotError(403,'Original owner or named executor required');
  for(const chat of [g.owner_id,g.executor_id]){const c=bots.chat(a,chat);if(c.user_id!==a.user.id||c.archived||!db.prepare('SELECT 1 FROM bot_registrations WHERE conversation_id=? AND active=1').get(chat))throw new BotError(403,'Participant access revoked');}
  return g;
 }
 const event=(id:string,kind:string)=>db.prepare('SELECT * FROM bot_composed_sms_events WHERE authority_id=? AND kind=?').get(id,kind) as {actor_id:number;actor_conversation_id:string;request_key:string;payload_json:string}|undefined;
 function append(a:Actor,g:Authority,kind:string,key:string,payload:unknown){
  const json=canonicalJson(payload),old=event(g.id,kind);
  if(old){if(old.actor_id!==a.user.id||old.actor_conversation_id!==a.conversationId||old.request_key!==key||old.payload_json!==json)throw new BotError(409,'Conflicting derived authority event');return;}
  db.prepare('INSERT INTO bot_composed_sms_events(authority_id,kind,actor_id,actor_conversation_id,request_key,payload_json) VALUES(?,?,?,?,?,?)').run(g.id,kind,a.user.id,a.conversationId,key,json);
 }
 function usable(g:Authority){if(event(g.id,'revoked'))throw new BotError(403,'Derived authority revoked');if(Date.parse(g.expires_at)<=now())throw new BotError(409,'Derived authority expired; no new attempt');}
 function result(a:Actor,g:Authority){const dispatched=db.prepare('SELECT action_id FROM bot_composed_sms_dispatch_authorities WHERE authority_id=?').get(g.id) as {action_id:string}|undefined;const associated=db.prepare('SELECT 1 FROM bot_composed_sms_associations WHERE authority_id=?').get(g.id);const claimed=event(g.id,'claimed'),sent=event(g.id,'sent');const serviceReceipt=db.prepare('SELECT r.evidence_json FROM bot_composed_sms_service_receipts r JOIN bot_composed_sms_associations s ON s.id=r.association_id WHERE s.authority_id=?').get(g.id) as {evidence_json:string}|undefined;return {authority_id:g.id,action_id:g.action_id,native_action_id:dispatched?.action_id??null,execute:false,expires_at:g.expires_at,state:serviceReceipt?'SENT_ACCEPTED':sent?'sent':claimed?(dispatched&&!associated?'reserved':'unknown'):event(g.id,'revoked')?'revoked':event(g.id,'accepted')?'accepted':'derived',receipt:serviceReceipt?JSON.parse(serviceReceipt.evidence_json):sent?JSON.parse(sent.payload_json):null,proof_kind:JSON.parse(g.snapshot_json).proofKind??'unchanged-consumption/v1',authority:JSON.parse(g.snapshot_json).tuple??null,scope:JSON.parse(g.snapshot_json).scope,reservation:claimed?JSON.parse(claimed.payload_json):null};}
 async function prepare(a:Actor,p:ComposedInput,g?:Authority,requireSender=true){const n=native(a,p,g),e=await reader(a,p,n.binding.source_owner);const current=native(a,p,g);if(current.inspection_hash!==n.inspection_hash)throw new BotError(409,'Native context changed during source read');return {n:current,e,binding:scope(current,p,e,requireSender)};}
 return {
  async inspect(a:Actor,raw:ComposedInput){const p=composedInspectionSchema.parse(raw),{n,e,binding}=await prepare(a,p,undefined,false);return {ready_for_authority_review:e.sender_verified,missing_proof:e.sender_verified?[]:['SMS_SENDER_OWNERSHIP_UNVERIFIED'],execute:false,inspection_hash:canonicalSha256(binding),native:n,source_evidence:e.projection,source_snapshot_hash:e.snapshot_hash,dispatch:e.dispatch,instructions:'Original owner: interpret full human instructions and customer evidence. Review every exact body span. No keyword acceptance, case merge, alias assertion or later-draft timing disqualification. This inspection does not authorize or send.'};},
  async derive(a:Actor,raw:z.infer<typeof deriveComposedSchema>){
   const r=deriveComposedSchema.parse(raw),{inspection_hash,request_key,review:assessment,...p}=r;
   const {n,e,binding}=await prepare(a,p);
   return db.transaction(()=>{
    const fresh=native(a,p);e.assertFresh();if(fresh.inspection_hash!==n.inspection_hash||canonicalSha256(binding)!==inspection_hash)throw new BotError(409,'Inspection changed; review current evidence');
    review(fresh,e,p,assessment);
    const actionId=canonicalSha256({business_id:binding.business_id,decision_id:n.existing_consumption.decision_id,channel:'sms'});
    const requestHash=canonicalSha256(r);
    const old=db.prepare('SELECT * FROM bot_composed_sms_authorities WHERE action_id=? OR (owner_id=? AND request_key=?)').get(actionId,a.conversationId,request_key) as Authority|undefined;
    if(old){if(old.request_hash!==requestHash)throw new BotError(409,'SMS action already has derived authority; reconcile original action, not another draft or key');return result(a,old);}
    const g={id:crypto.randomUUID(),action_id:actionId,owner_id:a.conversationId!,executor_id:p.executor_conversation_id,source_id:p.source_id,draft_id:p.draft_id,request_key,request_hash:requestHash,
     snapshot_json:canonicalJson({binding,scope:{canonical_case:p.canonical_case,contact_case:p.contact_case,executor_conversation_id:p.executor_conversation_id,payload:n.draft.payload},native:n,source_projection:e.projection,review:assessment,reviewer_user_id:a.user.id,reviewer_conversation_id:a.conversationId}),expires_at:new Date(now()+30*60_000).toISOString()};
    db.prepare('INSERT INTO bot_composed_sms_authorities(id,action_id,owner_id,executor_id,source_id,draft_id,request_key,request_hash,snapshot_json,expires_at) VALUES(@id,@action_id,@owner_id,@executor_id,@source_id,@draft_id,@request_key,@request_hash,@snapshot_json,@expires_at)').run(g);
    if(e.boundary){if(e.dispatch_material_hash!==e.boundary.materialHash)throw new BotError(409,'Versioned correspondence material hash differs');persistComposeDispatchAuthority(db,g,e.boundary,now());}
    return result(a,read(a,g.id));
   }).immediate();
  },
  reconcile(a:Actor,id:string){return result(a,read(a,id));},
  async accept(a:Actor,id:string,key:string,payloadHash:string){const g=read(a,id);if(a.conversationId!==g.executor_id)throw new BotError(403,'Named executor only');const saved=JSON.parse(g.snapshot_json);if(saved.proofKind==='native-compose-sms-correction/v1')throw new BotError(503,'CORRECTION_AUTHORITY_EXPORT_UNAVAILABLE: versioned source correction proof required; no unchanged-consumption fallback');const p=saved.binding.input as ComposedInput;const current=await prepare(a,p,g);
   return db.transaction(()=>{usable(g);current.e.assertFresh();if(native(a,p,g).inspection_hash!==saved.binding.native_hash||canonicalSha256(current.binding)!==canonicalSha256(saved.binding)||payloadHash!==saved.binding.payload_hash)throw new BotError(409,'Exact authority or source snapshot changed');append(a,g,'accepted',key,{payload_hash:payloadHash});return result(a,g);}).immediate();},
  async claim(a:Actor,id:string,key:string,checkInput:unknown){const g=read(a,id);if(a.conversationId!==g.executor_id)throw new BotError(403,'Named executor only');
   if(event(id,'claimed'))return result(a,g);const saved=JSON.parse(g.snapshot_json);if(saved.proofKind==='native-compose-sms-correction/v1')throw new BotError(503,'CORRECTION_AUTHORITY_EXPORT_UNAVAILABLE: versioned source correction proof required; no unchanged-consumption fallback');const p=saved.binding.input as ComposedInput,current=await prepare(a,p,g);const check=sendCheckSchema.parse(checkInput);
   return db.transaction(()=>{usable(g);current.e.assertFresh();if(event(id,'claimed'))return result(a,g);
    if(!event(id,'accepted')||check.payload_hash!==saved.binding.payload_hash||native(a,p,g).inspection_hash!==saved.binding.native_hash||canonicalSha256(current.binding)!==canonicalSha256(saved.binding))throw new BotError(409,'Acceptance, exact payload or fresh evidence changed');
    if(!current.e.dispatch.supported||current.e.dispatch.contract!=='native-compose-sms/v1')throw new BotError(409,'SOURCE_NATIVE_ACTION_TRANSPORT_UNAVAILABLE: '+current.e.dispatch.reason);
    const dispatch=db.prepare('SELECT tuple_json FROM bot_composed_sms_dispatch_authorities WHERE authority_id=?').get(id) as {tuple_json:string}|undefined;
    if(!dispatch)throw new BotError(503,'DISPATCH_BOUNDARY_UNAVAILABLE: accepted prospective service authority required');
    const tuple=JSON.parse(dispatch.tuple_json);
    const boundary=current.e.boundary;if(!boundary)throw new BotError(503,'DISPATCH_BOUNDARY_UNAVAILABLE: current accepted sender and source guard evidence required');
    boundary.assertFresh();
    const stored=db.prepare('SELECT registration_hash,sender_expires_at FROM bot_composed_sms_dispatch_authorities WHERE authority_id=?').get(id) as {registration_hash:string;sender_expires_at:string};
    if(boundary.guardContractHash!==boundary.registration.guardContractHash||boundary.sender.issuerId!==boundary.registration.senderReceiptIssuerId||Date.parse(boundary.sender.expiresAt)<=now()||canonicalSha256(boundary.registration)!==stored.registration_hash||Date.parse(stored.sender_expires_at)<=now()||current.e.dispatch_material_hash!==tuple.materialHash||boundary.materialHash!==tuple.materialHash||boundary.sender.receiptId!==tuple.senderReceiptId||boundary.sender.revision!==tuple.senderReceiptRevision||boundary.sender.providerAccountId!==tuple.senderAccountId||boundary.sender.fromPhone!==tuple.fromPhone)throw new BotError(409,'Current service boundary changed');
    const claim=crypto.randomUUID(),idempotency=tuple.idempotencyKey;
    append(a,g,'claimed',key,{claim_key:claim,native_claim_id:claim,native_action_id:tuple.nativeActionId,authority_hash:tuple.authorityHash,payload_hash:check.payload_hash,idempotency_key:idempotency,transport:current.e.dispatch,check});
    return {...result(a,g),execute:false,native_claim_id:claim,native_action_id:tuple.nativeActionId,claim_key:claim,idempotency_key:idempotency,scope:saved.scope,transport:current.e.dispatch};
   }).immediate();
  },
  // Provider IDs submitted by a bot are not an authenticated source receipt.
  delivery(a:Actor,id:string,_key:string,_claimKey:string,_proofInput:unknown){read(a,id);throw new BotError(503,'Authenticated source receipt reconciliation required; bot-submitted provider proof cannot complete composed SMS');},
  receiptTarget(a:Actor,id:string,claimKey:string){
   const g=read(a,id),claim=event(id,'claimed');
   if(a.conversationId!==g.executor_id||!claim||claim.actor_id!==a.user.id||claim.actor_conversation_id!==a.conversationId||JSON.parse(claim.payload_json).claim_key!==claimKey)throw new BotError(403,'Original claiming executor and existing reservation required');
   const dispatch=db.prepare('SELECT registration_id,action_id FROM bot_composed_sms_dispatch_authorities WHERE authority_id=?').get(id) as {registration_id:string;action_id:string}|undefined;
   if(!dispatch)throw new BotError(503,'DISPATCH_BOUNDARY_UNAVAILABLE: no service-bound authority');return dispatch;
  },
  serviceCurrent(id:string,receiptOnly=false){
   const g=db.prepare('SELECT * FROM bot_composed_sms_authorities WHERE id=?').get(id) as Authority|undefined;
   if(!g)throw new BotError(404,'Authority not found');
   const user=db.prepare("SELECT * FROM users WHERE id=(SELECT user_id FROM conversations WHERE id=?) AND status='active'").get(g.owner_id) as UserRow|undefined;
   if(!user)throw new BotError(403,'Original owner access revoked');
   // Native dependency validation only: no external credential or caller impersonation.
   const actor={user,conversationId:g.owner_id},saved=JSON.parse(g.snapshot_json);
   read(actor,id);if(saved.proofKind==='native-compose-sms-correction/v1')throw new BotError(503,'CORRECTION_AUTHORITY_EXPORT_UNAVAILABLE: versioned source correction proof required');if(!receiptOnly)usable(g);
   if(native(actor,saved.binding.input,g).inspection_hash!==saved.binding.native_hash)throw new BotError(409,'Original source or current native context changed');
  },
  revoke(a:Actor,id:string,key:string,reason:string){return db.transaction(()=>{const g=read(a,id);if(a.conversationId!==g.owner_id)throw new BotError(403,'Original owner only');append(a,g,'revoked',key,{reason:z.string().min(1).max(2000).parse(reason)});return result(a,g);}).immediate();},
 };
}
