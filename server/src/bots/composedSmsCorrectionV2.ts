import {correctionPreflight,correctionPreflightReview} from './correctionPreflight.js';
import {reserveComposeLineage,readComposeLineage} from './composedSmsLineage.js';
import {CORRECTION_DISPATCH,correctionScopeHash,verifyCorrectionDispatch,lineageHash,type CorrectionDispatchAuthority} from './composedSmsCorrectionContract.js';
import {checkCorrectionAcceptance} from './composedSmsTrust.js';
import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import {z} from 'zod';
import {canonicalJson,canonicalSha256} from './canonical.js';
import {checkComposeRegistration} from './composedSmsTrust.js';
import {composeHash,wireSchema} from './composedSmsContract.js';
import {BotError,createBotService,type Actor,type Decision} from './service.js';
import {createInstructionObligations} from './instructionObligations.js';
import {composedInspectionSchema,compositionReviewSchema,type CompositionReader} from './composedSmsTypes.js';
import type {UserRow} from '../db/db.js';

export const CORRECTION_PROOF='native-compose-sms-correction/v2' as const;
export const CORRECTION_DISPATCH_GAP='CORRECTION_SERVICE_ACCEPTANCE_REQUIRED: exact source lineage adoption and custody amendment are not installed';
const id=z.string().min(1).max(200),hash=z.string().regex(/^[a-f0-9]{64}$/);
export const correctionInspectionSchema=composedInspectionSchema.extend({
 decision_id:id,expected_decision_version:z.number().int().positive(),lineage_draft_id:id,
 correction_source_kind:z.enum(['direct_message','result_reply']),correction_source_id:id,
}).strict();
export const correctionReviewSchema=compositionReviewSchema.extend({
 instruction_kind:z.enum(['compose_and_send','wording_edit','status_question','quoted_or_reported','conditional','ambiguous']),
 correction_instruction:z.object({id,text:z.string().min(1).max(12000)}).strict(),
 send_instruction:z.object({id,text:z.string().min(1).max(12000)}).strict(),
 interpretation:z.string().trim().min(20).max(2000),
}).strict();
export const correctionDeriveSchema=correctionInspectionSchema.extend({inspection_hash:hash,request_key:id,review:correctionReviewSchema,context_review:correctionPreflightReview,continuity:z.object({kind:z.literal('narrowing_continuing_compose_and_send'),explanation:z.string().trim().min(20).max(3000)}).strict()}).strict();
const uuid=z.string().uuid(),iso=z.string().datetime({offset:true});
export const correctionAuthoritySchema=z.object({
 schemaVersion:z.literal(CORRECTION_PROOF),authorityId:uuid,actionId:hash,decisionId:id,decisionVersion:z.number().int().positive(),
 correction:z.object({kind:z.enum(['direct_message','result_reply']),source:z.object({id,actor_id:z.number().int().positive(),text:z.string(),created_at:z.string()}).strict(),anchor:z.object({original_result:z.string(),anchor:z.string()}).strict().nullable()}).strict(),
 sourceInstructionHash:hash,contextHash:hash,ownerConversationId:id,executorConversationId:id,businessId:uuid,
 canonicalCaseId:uuid,contactCaseId:uuid,payloadHash:hash,wirePayloadHash:hash,wire:wireSchema,
 nativeBindingHash:hash,reviewHash:hash,historicalConsumptionHash:hash,materialHash:hash,sourcePrincipalId:id,executorPrincipalId:id,
 sourceOrigin:z.string().url(),runtime:z.object({projectId:uuid,environmentId:uuid,serviceId:uuid}).strict(),
 senderReceiptId:uuid,senderReceiptRevision:z.number().int().positive().safe(),evidenceHash:hash,registrationHash:hash,
 derivedAt:iso,expiresAt:iso,authorityHash:hash,
}).strict();
export function verifyCorrectionAuthority(value:unknown){
 const parsed=correctionAuthoritySchema.parse(value),{authorityHash,...tuple}=parsed;
 if(composeHash('native-compose-sms/correction-authority/v2',tuple)!==authorityHash||canonicalSha256(tuple.correction)!==tuple.sourceInstructionHash||composeHash('native-compose-sms/wire/v1',tuple.wire)!==tuple.wirePayloadHash||tuple.actionId!==canonicalSha256({business_id:tuple.businessId,decision_id:tuple.decisionId,channel:'sms'})||Date.parse(tuple.expiresAt)<=Date.parse(tuple.derivedAt))throw new BotError(409,'Correction authority hash, lineage or expiry mismatch');
 return parsed;
}
type Input=z.infer<typeof correctionInspectionSchema>;
type Human={id:string;actor_id:number;actor_conversation_id?:string|null;text:string;created_at:string};
type Draft={created_at:string;id:string;conversation_id:string;version:number;payload_json:string;claim_key:string|null;receipt:string|null;state:string;decision_id:string|null;delegation_id:string|null;authorized_by:number|null};
const time=(s:string)=>Date.parse(/^\d{4}-\d\d-\d\d /.test(s)?s.replace(' ','T')+'Z':s);

/** Prospective authority, not an answer/consumption retrofit. The existing action
 * unique constraint fences this proof and historical composition together.
 * There is deliberately no v1 service export for this distinct proof kind. */
export function composedSmsCorrectionV2(db:Database.Database,reader:CompositionReader,now=Date.now){
 const bots=createBotService(db),obligations=createInstructionObligations(db),preflight=correctionPreflight(db);
 const preflightInput=(p:Input)=>({decision_id:p.decision_id,expected_version:p.expected_decision_version,original_source_id:p.source_id,correction_source_kind:p.correction_source_kind,correction_source_id:p.correction_source_id});
 function native(a:Actor,p:Input){
  const context=preflight.inspect(a,preflightInput(p));
  const historical=obligations.inspect(a,{source_id:p.source_id,draft_id:p.draft_id,expected_draft_version:p.expected_draft_version,executor_conversation_id:p.executor_conversation_id});
  if(historical.existing_consumption.decision_id!==p.decision_id||historical.existing_consumption.action!=='approve')throw new BotError(409,'Exact original approved action lineage required');
  const d=db.prepare('SELECT * FROM bot_decisions WHERE id=?').get(p.decision_id) as Decision;
  if(d.version!==p.expected_decision_version||d.state!=='needs_input'||d.answer_json!==null)throw new BotError(409,'Current unanswered correction revision changed; no reopening');
  if(historical.missing_proof.some(x=>['EXISTING_EFFECT_OR_UNKNOWN_RECONCILE_ONLY','NOT_AN_UNBOUND_ORDINARY_DRAFT','OBLIGATION_REVOKED'].includes(x)))throw new BotError(409,'Existing draft effect, authority or revocation blocks correction');
  const lineage=db.prepare('SELECT * FROM bot_message_drafts WHERE id=?').get(p.lineage_draft_id) as Draft|undefined;
  if(!lineage||lineage.conversation_id!==p.executor_conversation_id||lineage.claim_key||lineage.receipt||lineage.state!=='draft'||lineage.authorized_by||lineage.decision_id||lineage.delegation_id)throw new BotError(409,'Original executor lineage draft unavailable or possibly executed');
  const original=JSON.parse(lineage.payload_json),payload=historical.draft.payload;
  const {body:oldBody,...oldScope}=original,{body,...scope}=payload;
  if(canonicalSha256(oldScope)!==canonicalSha256(scope)||payload.channel!=='sms'||payload.recipients.length!==1||!/^\+[1-9][0-9]{7,14}$/.test(payload.recipients[0])||payload.subject||payload.attachments.length||!body||body.length>1600)throw new BotError(409,'Correction must preserve exact original account, channel, recipient, customer, ticket and executor scope');
  const priorScope=historical.original_proposal.message_delivery;
  const current=JSON.parse(d.proposal_json);
  if(!priorScope||priorScope.canonical_case!==p.canonical_case||current.message_delivery?.canonical_case!==p.canonical_case)throw new BotError(409,'Structured original/current canonical case differs; no alias inference');
  for(const e of [...(current.evidence??[]),...(current.images??[])])bots.chat(a,e.conversation_id);
  const direct=historical.context.direct_messages as Human[];
  const replies=db.prepare('SELECT r.id,r.actor_id,r.actor_conversation_id,r.text,r.created_at,t.id thread_id,t.source_text,t.anchor FROM bot_message_replies r JOIN bot_message_threads t ON t.id=r.thread_id WHERE t.conversation_id=? ORDER BY r.rowid LIMIT 501').all(a.conversationId) as Array<Human&{thread_id:string;source_text:string;anchor:string}>;
  const fullContext=context.context;
  if(replies.length>500||Buffer.byteLength(canonicalJson(fullContext))>120000)throw new BotError(409,'Complete correction context exceeds bounded review; no excerpts');
  const discussion=historical.context.decision_discussion as Human[];
  const source=p.correction_source_kind==='direct_message'?direct.find(x=>x.id===p.correction_source_id):replies.find(x=>x.id===p.correction_source_id&&!x.actor_conversation_id);
  if(!source||source.actor_conversation_id||source.id===p.source_id||time(source.created_at)<=time(historical.source.created_at))throw new BotError(409,'A genuine later authenticated human correction is required');
  if(time(lineage.created_at)>=time(source.created_at))throw new BotError(409,'Original executor lineage must predate correction; a later draft cannot establish original scope');
  const author=db.prepare("SELECT * FROM users WHERE id=? AND status='active'").get(source.actor_id) as UserRow|undefined;
  if(!author||!bots.view({user:author},d).can_answer)throw new BotError(403,'Correction author authority revoked');

  const anchor=p.correction_source_kind==='result_reply'?{original_result:(source as typeof replies[number]).source_text,anchor:(source as typeof replies[number]).anchor}:null;
  const correction={kind:p.correction_source_kind,source:{id:source.id,actor_id:source.actor_id,text:source.text,created_at:source.created_at},anchor};
  const humans=[...direct,...replies].filter(x=>!x.actor_conversation_id);
  const duplicates=db.prepare("SELECT id FROM bot_message_drafts WHERE conversation_id=? AND json_extract(payload_json,'$.channel')='sms' AND json_extract(payload_json,'$.ticket')=? AND (claim_key IS NOT NULL OR receipt IS NOT NULL OR state IN ('sending','sent','uncertain')) LIMIT 1").get(p.executor_conversation_id,payload.ticket);
  if(duplicates)throw new BotError(409,'Existing SMS effect or UNKNOWN requires reconciliation, not a correction attempt');
  const binding={schemaVersion:CORRECTION_PROOF,preflight_hash:context.inspection_hash,input:p,source_owner:a.conversationId!,business_id:historical.binding.business_id,user_id:a.user.id,
   correction_source_hash:canonicalSha256(correction),context_hash:canonicalSha256(fullContext),historical_hash:historical.inspection_hash,
   current_decision:historical.binding.current_decision,lineage_draft:{id:lineage.id,version:lineage.version,payload_hash:canonicalSha256(original)},
   payload_hash:canonicalSha256(payload),body_hash:canonicalSha256(body),executor_id:p.executor_conversation_id};
  return {binding,correction,humans,fullContext,context,historical,current_proposal:current,payload};
 }
 async function prepare(a:Actor,p:Input){
  const n=native(a,p),e=await reader(a,p,n.binding.source_owner),fresh=native(a,p);e.assertFresh();
  if(canonicalSha256(n.binding)!==canonicalSha256(fresh.binding))throw new BotError(409,'Native context changed during authenticated source read');
  const canonical=e.projection.cases.find(c=>c.id===p.canonical_case),contact=e.projection.cases.find(c=>c.id===p.contact_case);
  if(!canonical||!contact||p.canonical_case===p.contact_case||contact.ticketNumber!==n.payload.ticket||contact.customer.phone!==n.payload.recipients[0]||e.business_id!==n.binding.business_id)throw new BotError(409,'Authenticated exact cases, phone or business mismatch');
  if(e.sender_verified&&e.sms_account!==n.payload.account)throw new BotError(409,'Authenticated sender account mismatch');
  const binding={...n.binding,evidence_hash:e.snapshot_hash,projection_hash:canonicalSha256(e.projection),registration_hash:e.registration_hash,
   material_hash:e.dispatch_material_hash??null,source_account:e.account_id,source_principal:e.principal_id,sender_phone:e.sender_phone,
   sender_verified:e.sender_verified,boundary_hash:e.boundary?canonicalSha256({registration:e.boundary.registration,sender:e.boundary.sender,materialHash:e.boundary.materialHash}):null};
  return {n,e,binding,inspection_hash:canonicalSha256(binding)};
 }
 function review(n:ReturnType<typeof native>,e:Awaited<ReturnType<typeof prepare>>['e'],p:Input,r:z.infer<typeof correctionReviewSchema>){
  // Semantics are the authenticated original owner's accountable review, never
  // inferred from keywords, a channel flag, quoted text or the draft timestamp.
  if(r.mode!=='compose_and_send'||r.instruction_kind!=='compose_and_send'||r.unresolved_choices.length)throw new BotError(409,'Explicit unconditional composition AND sending direction required; edits, status, quotations and conditions do not qualify');
  const cites=[r.correction_instruction,r.send_instruction,r.recipient_instruction,r.composition_instruction,r.channel_instruction];
  if(r.correction_instruction.id!==p.correction_source_id||cites.some(c=>!n.humans.some(h=>h.id===c.id&&h.text===c.text)))throw new BotError(409,'Exact complete authenticated human citations required');
  // Fresh owner continuity assessment is required separately; every cited author
  // must still be entitled to instruct this original decision.
  const decision=db.prepare('SELECT * FROM bot_decisions WHERE id=?').get(p.decision_id) as Decision;
  for(const c of cites){const h=n.humans.find(x=>x.id===c.id)!;const u=db.prepare("SELECT * FROM users WHERE id=? AND status='active'").get(h.actor_id) as UserRow|undefined;if(!u||!bots.view({user:u},decision).can_answer)throw new BotError(403,'Cited human authority revoked');}
  if(r.composition_instruction.id===r.channel_instruction.id)throw new BotError(409,'Independent substantive composition citation required');
  if(r.send_instruction.id===p.correction_source_id||time(n.humans.find(x=>x.id===r.send_instruction.id)!.created_at)>=time(n.correction.source.created_at))throw new BotError(409,'Independent original continuing compose/send direction required');
  const messages=e.projection.messages,cited=r.customer_message_ids.map(id=>messages.find(m=>m.id===id));
  if(cited.some(m=>!m||m.direction!=='inbound'||m.messageType!=='message'||!['email','sms'].includes(m.channel??'')||m.aiGenerated||m.actorType||m.actorId||m.agentId)||!cited.some(m=>m!.conversationId===p.canonical_case)||!cited.some(m=>m!.conversationId===p.contact_case&&m!.channel==='sms'&&m!.fromPhone===n.payload.recipients[0]))throw new BotError(409,'Customer-authored evidence from both distinct cases and exact recipient required');
  let cursor=0;
  for(const part of r.parts){if(part.start!==cursor||part.end<=cursor||part.end>n.payload.body.length||part.assessment!=='supported'||!part.human_ids.includes(p.correction_source_id)||part.human_ids.some(id=>!n.humans.some(h=>h.id===id))||part.message_ids.some(id=>!r.customer_message_ids.includes(id)))throw new BotError(409,'Every corrected body span requires supported correction evidence without additions');cursor=part.end;}
  if(cursor!==n.payload.body.length)throw new BotError(409,'Incomplete corrected payload review');
 }
 function validateReview(a:Actor,p:Input,n:ReturnType<typeof native>,input:unknown,assessment:z.infer<typeof correctionReviewSchema>){
  const parsed=correctionPreflightReview.parse(input);
  if(canonicalSha256(preflightInput(p))!==canonicalSha256({decision_id:parsed.decision_id,expected_version:parsed.expected_version,original_source_id:parsed.original_source_id,correction_source_kind:parsed.correction_source_kind,correction_source_id:parsed.correction_source_id}))throw new BotError(409,'Review identifiers differ from correction');
  const checked=preflight.review(a,parsed);
  if(checked.assessment!=='direction_retained_for_semantic_review'||parsed.inspection_hash!==n.context.inspection_hash)throw new BotError(409,'Full context does not retain unconditional continuing direction');
  if(parsed.later_context.some(x=>[assessment.send_instruction,assessment.composition_instruction,assessment.channel_instruction,assessment.recipient_instruction].some(c=>c.id===x.citation.id)))throw new BotError(409,'Later status supplies no composition or sending authority');
 }
 function persistDispatch(authorityId:string,saved:any,boundary:NonNullable<Awaited<ReturnType<typeof prepare>>['e']['boundary']>,nativeActionId:string){
  const r=boundary.registration,amendment=checkCorrectionAcceptance(r,now()),t=verifyCorrectionAuthority(saved.tuple);
  const authority=correctionDispatchFromSnapshot(saved,r,nativeActionId,amendment.nativeIssuer);
  db.prepare('INSERT INTO bot_composed_sms_dispatch_authorities(authority_id,action_id,registration_id,registration_hash,tuple_json,sender_expires_at,expires_at) VALUES(?,?,?,?,?,?,?)').run(authorityId,nativeActionId,r.registrationId,canonicalSha256(r),canonicalJson(authority),boundary.sender.expiresAt,t.expiresAt);
  readComposeLineage(db,nativeActionId,amendment.nativeIssuer);
 }
 function ownerActor(saved:any):Actor{const user=db.prepare("SELECT * FROM users WHERE id=? AND status='active'").get(saved.reviewer_user_id) as UserRow|undefined;if(!user)throw new BotError(403,'Original owner revoked');return {user,conversationId:saved.reviewer_conversation_id};}
 function current(saved:any){const a=ownerActor(saved),p=correctionInspectionSchema.parse(saved.binding.input),n=native(a,p);
  if(canonicalSha256(n.binding)!==canonicalSha256(saved.correction_native.binding))throw new BotError(409,'Correction native context changed');validateReview(a,p,n,saved.context_review,saved.review);
  review(n,{projection:saved.source_projection} as Awaited<ReturnType<typeof prepare>>['e'],p,saved.review);
  const t=verifyCorrectionAuthority(saved.tuple);
  if(t.nativeBindingHash!==canonicalSha256(saved.binding)||t.reviewHash!==canonicalSha256({assessment:saved.review,context_review:saved.context_review,continuity:saved.continuity})||t.payloadHash!==canonicalSha256(saved.scope.payload)||t.contextHash!==n.binding.context_hash||t.sourceInstructionHash!==n.binding.correction_source_hash)throw new BotError(409,'Immutable correction snapshot commitments differ');return n;
 }
 return {
  reconcile(a:Actor,raw:unknown){
   const p=z.object({decision_id:id,source_id:id,request_key:id}).strict().parse(raw);
   if(!a.conversationId)throw new BotError(403,'Original owner bot required');
   const owner=bots.chat(a,a.conversationId);
   if(owner.archived||owner.user_id!==a.user.id||!db.prepare('SELECT 1 FROM bot_registrations WHERE conversation_id=? AND active=1').get(owner.id))throw new BotError(403,'Original owner access revoked');
   const row=db.prepare('SELECT * FROM bot_composed_sms_authorities WHERE owner_id=? AND request_key=?').get(owner.id,p.request_key) as {id:string;source_id:string;snapshot_json:string;expires_at:string}|undefined;
   if(!row)return {recorded:false,execute:false,ready:false};
   const saved=JSON.parse(row.snapshot_json);
   if(row.source_id!==p.source_id||saved.proofKind!==CORRECTION_PROOF||saved.tuple.decisionId!==p.decision_id)throw new BotError(409,'Reconciliation key belongs to different immutable scope');
   let nativeCurrent=true;try{current(saved);nativeCurrent=true;}catch(e){if(!(e instanceof BotError))throw e;nativeCurrent=false;}
   const revoked=!!db.prepare("SELECT 1 FROM bot_composed_sms_events WHERE authority_id=? AND kind='revoked'").get(row.id);
   return {recorded:true,authority_id:row.id,authority:verifyCorrectionAuthority(saved.tuple),execute:false,ready:false,native_current:nativeCurrent,revoked,expired:Date.parse(row.expires_at)<=now(),source_current:'not_checked',missing_proof:[CORRECTION_DISPATCH_GAP]};
  },
  nativeCurrent(saved:unknown){return current(saved);},
  async prepareExisting(actor:Actor,saved:any){
   const n=current(saved),p=correctionInspectionSchema.parse(saved.binding.input);
   if(actor.conversationId!==p.executor_conversation_id||actor.user.id!==saved.reviewer_user_id)throw new BotError(403,'Original executor only');
   const executor=bots.chat(actor,p.executor_conversation_id);if(executor.archived||executor.user_id!==actor.user.id||executor.business_team_id!==n.binding.business_id||!db.prepare('SELECT 1 FROM bot_registrations WHERE conversation_id=? AND active=1').get(executor.id))throw new BotError(403,'Executor access revoked');
   const e=await reader(actor,p,n.binding.source_owner);e.assertFresh();current(saved);
   const t=verifyCorrectionAuthority(saved.tuple),boundary=e.boundary;
   if(!boundary||!e.sender_verified||e.dispatch_material_hash!==t.materialHash||boundary.materialHash!==t.materialHash||e.business_id!==t.businessId||e.account_id!==saved.binding.source_account||e.principal_id!==t.executorPrincipalId||e.sms_account!==saved.scope.payload.account||e.sender_phone!==t.wire.fromPhone)throw new BotError(409,'Current correction source/executor evidence differs');
   boundary.assertFresh();checkComposeRegistration(db,boundary.registration,now());checkCorrectionAcceptance(boundary.registration,now());
   if(boundary.sender.receiptId!==t.senderReceiptId||boundary.sender.revision!==t.senderReceiptRevision||boundary.sender.providerAccountId!==t.wire.senderAccountId||boundary.sender.fromPhone!==t.wire.fromPhone||boundary.sender.issuerId!==boundary.registration.senderReceiptIssuerId||Date.parse(boundary.sender.expiresAt)<=now()||boundary.guardContractHash!==boundary.registration.guardContractHash||boundary.registration.sourceOrigin!==t.sourceOrigin||canonicalSha256(boundary.registration.runtime)!==canonicalSha256(t.runtime)||canonicalSha256({registration:boundary.registration,sender:boundary.sender,materialHash:boundary.materialHash})!==saved.binding.boundary_hash)throw new BotError(409,'Current correction custody/sender boundary changed');
   return {e,nativeFresh:()=>{checkComposeRegistration(db,boundary.registration,now());checkCorrectionAcceptance(boundary.registration,now());return current(saved);}};
  },
  async inspect(a:Actor,raw:unknown){const p=correctionInspectionSchema.parse(raw),n=native(a,p);let v:Awaited<ReturnType<typeof prepare>>;
   try{v=await prepare(a,p);}catch(error){if(!(error instanceof BotError))throw error;return {schemaVersion:CORRECTION_PROOF,execute:false,ready:false,ready_for_authority_review:false,inspection_hash:null,preflight:n.context,binding:n.binding,correction:n.correction,full_context:n.fullContext,current_proposal:n.current_proposal,historical_consumption:n.historical.existing_consumption,payload:n.payload,source_evidence:null,missing_proof:[error.message,CORRECTION_DISPATCH_GAP],instructions:'Native context only. Source evidence is unavailable; do not derive from this incomplete inspection or reuse a previous hash.'};}
   return {schemaVersion:CORRECTION_PROOF,execute:false,ready:false,inspection_hash:v.inspection_hash,preflight:v.n.context,binding:v.binding,correction:v.n.correction,full_context:v.n.fullContext,current_proposal:v.n.current_proposal,historical_consumption:v.n.historical.existing_consumption,payload:v.n.payload,source_evidence:v.e.projection,ready_for_authority_review:v.e.sender_verified&&!!v.e.boundary?.registration.correctionAcceptance,missing_proof:[...(v.e.sender_verified?[]:['SMS_SENDER_OWNERSHIP_UNVERIFIED']),...(v.e.boundary?.registration.correctionAcceptance?[]:[CORRECTION_DISPATCH_GAP])],instructions:'Read full context and exact correction. Original owner must distinguish unconditional compose AND send from wording edits, status questions, quoted/bot text or conditions. This is prospective authority only; no historical approval, duplicate customer approval or dispatch.'};},
  async derive(a:Actor,raw:unknown){
   const r=correctionDeriveSchema.parse(raw),{inspection_hash,request_key,review:assessment,context_review,continuity,...p}=r,v=await prepare(a,p);
   return db.transaction(()=>{
    v.e.assertFresh();const fresh=native(a,p);if(canonicalSha256(fresh.binding)!==canonicalSha256(v.n.binding)||v.inspection_hash!==inspection_hash)throw new BotError(409,'Correction context, exact payload or source evidence changed');
    validateReview(a,p,fresh,context_review,assessment);
    review(fresh,v.e,p,assessment);
    if(!v.e.sender_verified||!v.e.boundary)throw new BotError(409,'Fresh authenticated sender and protected boundary evidence required');
    v.e.boundary.assertFresh();
    const boundary=v.e.boundary,reg=boundary.registration;checkComposeRegistration(db,reg,now());const acceptance=checkCorrectionAcceptance(reg,now());
    if(reg.businessId!==v.binding.business_id||reg.sourceAccountId!==v.e.account_id||!reg.executorBindings.some(x=>x.conversationId===p.executor_conversation_id&&x.userId===a.user.id)||boundary.sender.issuerId!==reg.senderReceiptIssuerId||boundary.sender.fromPhone!==v.e.sender_phone||boundary.materialHash!==v.e.dispatch_material_hash||boundary.guardContractHash!==reg.guardContractHash)throw new BotError(409,'Correction sender, material or executor custody differs');
    const actionId=canonicalSha256({business_id:v.binding.business_id,decision_id:p.decision_id,channel:'sms'}),requestHash=canonicalSha256(r);
    const old=db.prepare('SELECT id,request_hash FROM bot_composed_sms_authorities WHERE action_id=? OR (owner_id=? AND request_key=?)').get(actionId,a.conversationId,request_key) as {id:string;request_hash:string}|undefined;
    if(old){if(old.request_hash!==requestHash)throw new BotError(409,'Original SMS action already reserved; reconcile, never replace draft/key or UNKNOWN');return {authority_id:old.id,action_id:actionId,execute:false,ready:false,replayed:true,missing_proof:[CORRECTION_DISPATCH_GAP]};}
    const expires=Math.min(now()+30*60_000,Date.parse(v.e.boundary.sender.expiresAt),Date.parse(v.e.boundary.registration.expiresAt),Date.parse(acceptance.expiresAt));
    if(!Number.isFinite(expires)||expires<=now())throw new BotError(409,'Correction dependencies expired');
    const wire=wireSchema.parse({senderAccountId:v.e.boundary.sender.providerAccountId,fromPhone:v.e.sender_phone,toPhone:fresh.payload.recipients[0],wireBody:fresh.payload.body,media:[],normalizationPolicy:'sms-identity-utf8/v1'});
    const derivedAt=new Date(now()).toISOString(),authorityId=crypto.randomUUID();
    const tuple={schemaVersion:CORRECTION_PROOF,authorityId,actionId,decisionId:p.decision_id,decisionVersion:p.expected_decision_version,
     correction:v.n.correction,sourceInstructionHash:v.binding.correction_source_hash,contextHash:v.binding.context_hash,
     ownerConversationId:a.conversationId!,executorConversationId:p.executor_conversation_id,businessId:v.binding.business_id,
     canonicalCaseId:p.canonical_case,contactCaseId:p.contact_case,payloadHash:v.binding.payload_hash,wirePayloadHash:composeHash('native-compose-sms/wire/v1',wire),wire,
     nativeBindingHash:canonicalSha256(v.binding),reviewHash:canonicalSha256({assessment,context_review,continuity}),historicalConsumptionHash:canonicalSha256(fresh.historical.existing_consumption),materialHash:v.e.dispatch_material_hash!,sourcePrincipalId:v.e.principal_id,executorPrincipalId:reg.executorBindings.find(x=>x.conversationId===p.executor_conversation_id)!.principalId,sourceOrigin:reg.sourceOrigin,runtime:reg.runtime,senderReceiptId:boundary.sender.receiptId,senderReceiptRevision:boundary.sender.revision,evidenceHash:v.binding.evidence_hash,registrationHash:v.binding.registration_hash,derivedAt,expiresAt:new Date(expires).toISOString()};
    const snapshot={proofKind:CORRECTION_PROOF,tuple:verifyCorrectionAuthority({...tuple,authorityHash:composeHash('native-compose-sms/correction-authority/v2',tuple)}),binding:v.binding,
     scope:{canonical_case:p.canonical_case,contact_case:p.contact_case,executor_conversation_id:p.executor_conversation_id,payload:fresh.payload},
     correction_native:fresh,source_projection:v.e.projection,review:assessment,context_review,continuity,reviewer_user_id:a.user.id,reviewer_conversation_id:a.conversationId};
    db.prepare('INSERT INTO bot_composed_sms_authorities(id,action_id,owner_id,executor_id,source_id,draft_id,request_key,request_hash,snapshot_json,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(authorityId,actionId,a.conversationId,p.executor_conversation_id,p.source_id,p.draft_id,request_key,requestHash,canonicalJson(snapshot),tuple.expiresAt,derivedAt);
    const lineage=reserveComposeLineage(db,authorityId);
    // New service routes remain unavailable without a separately reviewed
    // adoption + custody amendment. Native prospective review is not activation.
    persistDispatch(authorityId,snapshot,boundary,lineage.native_action_id);
    return {authority_id:authorityId,action_id:actionId,native_action_id:lineage.native_action_id,execute:false,ready:false,replayed:false,authority:snapshot.tuple,missing_proof:reg.correctionAcceptance?[]:[CORRECTION_DISPATCH_GAP]};
   }).immediate();
  },
 };
}

export function correctionDispatchFromSnapshot(saved:any,r:import('./composedSmsTrust.js').ComposeRegistration,nativeActionId:string,nativeIssuer:string){
 const t=verifyCorrectionAuthority(saved.tuple),authorityId=t.authorityId;
  const lineage={schemaVersion:'native-compose-sms-action-lineage/v1' as const,nativeIssuer:nativeIssuer,businessId:t.businessId,decisionId:t.decisionId,channel:'sms' as const,originalActionDigest:t.actionId,nativeActionId};
  const current=saved.binding.current_decision;
  const tuple={...t.wire,nativeActionId,authorityId,authorityRevision:1 as const,proofKind:CORRECTION_PROOF,correctionAuthorityHash:t.authorityHash,correctionSourceKind:t.correction.kind,correctionSourceId:t.correction.source.id,correctionSourceHash:t.sourceInstructionHash,contextHash:t.contextHash,decisionId:t.decisionId,decisionVersion:t.decisionVersion,decisionProposalHash:current.proposal_hash,decisionHandlingRevision:current.handling_revision,nativeBindingHash:t.nativeBindingHash,reviewHash:t.reviewHash,originalActionDigest:t.actionId,lineageHash:lineageHash(lineage),payloadHash:t.payloadHash,scopeHash:'0'.repeat(64),materialHash:t.materialHash,materialHashVersion:'compose-correspondence-material/v1' as const,businessId:t.businessId,sourceOrigin:r.sourceOrigin,runtime:r.runtime,ownerConversationId:t.ownerConversationId,executorConversationId:t.executorConversationId,executorPrincipalId:t.executorPrincipalId,canonicalCaseId:t.canonicalCaseId,canonicalTicket:saved.source_projection.cases.find((c:any)=>c.id===t.canonicalCaseId).ticketNumber,contactCaseId:t.contactCaseId,contactTicket:saved.scope.payload.ticket,senderReceiptId:t.senderReceiptId,senderReceiptRevision:t.senderReceiptRevision,wirePayloadHash:t.wirePayloadHash,idempotencyKey:`veneer-compose-sms:${nativeActionId}`,derivedAt:t.derivedAt,authorityExpiresAt:t.expiresAt};
  tuple.scopeHash=correctionScopeHash({...tuple,authorityHash:'0'.repeat(64)} as CorrectionDispatchAuthority);
  return verifyCorrectionDispatch({...tuple,authorityHash:composeHash('native-compose-sms/correction-dispatch-authority/v1',tuple)});
}
