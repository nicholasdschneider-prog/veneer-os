import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import {z} from 'zod';
import type {Config} from '../config.js';
import type {UserRow} from '../db/db.js';
import {timingConfiguration,type TimingIdentity} from '../identity/purchaseTimingVerifier.js';
import {BotError,createBotService,type Actor} from './service.js';
import {canonicalJson,canonicalSha256} from './canonical.js';
import {timingHumanContext,timingCaptureSchema,timingEnrollmentSchema,timingProposalSchema,timingRequestSchema,timingKey,type TimingScope,type TimingRequest} from './purchaseTimingSchema.js';

type Trust={id:string;request_key:string;owner_id:number;business_id:string;executor_id:string;account_id:string;principal_id:string;source_origin:string;audience:string;client_id:string;enrollment_json:string;created_at:string};
type Capture={id:string;trust_id:string;request_key:string;request_json:string;scope_hash:string;received_at:string};
type Claim={id:string;trust_id:string;request_key:string;decision_id:string;order_id:string;request_json:string;receipt_json:string;created_at:string};
export class TimingError extends BotError {constructor(public code:string,message:string,status=409){super(status,message);}}
const fail=(code:string,message:string,status=409):never=>{throw new TimingError(code,message,status);};
const protocol='veneer-purchase-timing/v1' as const;
export function purchaseTimingService(db:Database.Database,config:Config,now:()=>number=Date.now){
 const bots=createBotService(db);
 const timestamp=()=>new Date(now()).toISOString();
 function user(id:number){const u=db.prepare("SELECT * FROM users WHERE id=? AND status='active'").get(id) as UserRow|undefined;return u??fail('ACCESS_REVOKED','Active native identity required',403);}
 function owner(a:Actor,businessId:string){
  user(a.user.id);
  if(a.conversationId || !db.prepare('SELECT 1 FROM business_teams WHERE id=? AND owner_id=?').get(businessId,a.user.id))fail('OWNER_REQUIRED','The current signed-in business owner must review this setup',403);
 }
 function configured(){return timingConfiguration(config)??fail('SETUP_REQUIRED','Configure a separate purchase-timing Cloudflare Access audience and service client before enrollment',503);}
 function executor(t:Pick<Trust,'owner_id'|'business_id'|'executor_id'>){
  owner({user:user(t.owner_id)},t.business_id);
  const c=bots.chat({user:user(t.owner_id)},t.executor_id);
  if(c.archived || c.user_id!==t.owner_id || c.business_team_id!==t.business_id || !db.prepare('SELECT 1 FROM bot_registrations WHERE conversation_id=? AND active=1').get(c.id))fail('EXECUTOR_REVOKED','Current registered executor and business binding required');
 }
 function trust(id:string,identity:TimingIdentity,current=true){
  const conf=configured();
  if(identity.kind!=='purchase_timing_verifier'||identity.audience!==conf.audience||identity.clientId!==conf.clientId)fail('IDENTITY_REJECTED','Dedicated purchase-timing identity required',403);
  const t=db.prepare('SELECT * FROM purchase_timing_trust WHERE id=?').get(id) as Trust|undefined;
  if(!t)fail('NOT_FOUND','Trust not found',404);
  if(t!.audience!==identity.audience || t!.client_id!==identity.clientId)fail('IDENTITY_REJECTED','Service does not own this trust',403);
  if(current){executor(t!);if(db.prepare('SELECT 1 FROM purchase_timing_revocations WHERE trust_id=?').get(id))fail('TRUST_REVOKED','Trust revoked');}
  return t!;
 }
 function captureRow(id:string,t:Trust,fresh=false){
  const row=db.prepare('SELECT * FROM purchase_timing_captures WHERE id=? AND trust_id=?').get(id,t.id) as Capture|undefined;
  if(!row)fail('NOT_FOUND','Source capture not found in this trust',404);
  const raw=timingCaptureSchema.parse(JSON.parse(row!.request_json));
  if(fresh && (now()-Date.parse(raw.captured_at)>30000 || now()-Date.parse(row!.received_at)>30000 || Date.parse(raw.captured_at)>now()+1000))fail('SOURCE_STALE','Fresh authoritative source capture required');
  return {row:row!,raw};
 }
 function scope(t:Trust,s:TimingScope){
  if(s.business_id!==t.business_id || s.account_id!==t.account_id || s.principal_id!==t.principal_id || s.source_origin!==t.source_origin || s.executor_id!==t.executor_id)fail('SOURCE_BINDING_CHANGED','Source account/origin/principal/executor mismatch');
  if(Date.parse(s.authorization_expires_at)<=now())fail('EXPIRED','Timing authorization expired');
  const days=(Date.parse(s.checkout_delivery.end)-Date.parse(s.original_delivery.end))/86400000;
  if(days<=7)fail('UNSUPPORTED_SCOPE','This contract covers only a purchase delivery delay beyond seven days');
 }
 function nativeProof(t:Trust,p:TimingRequest){
  const d=bots.read({user:user(t.owner_id)},p.decision_id);
  if(d.conversation_id!==t.executor_id || d.version!==p.decision_version)fail('NATIVE_BINDING_CHANGED','Native owner or current proposal version changed');
  const proposal=JSON.parse(d.proposal_json);
  if(canonicalSha256(proposal)!==p.native_proposal_hash)fail('NATIVE_BINDING_CHANGED','Native proposal hash mismatch');
  const events=db.prepare("SELECT rowid,* FROM bot_decision_events WHERE decision_id=? AND version=? AND kind='answered'").all(d.id,d.version) as {rowid:number;id:string;actor_id:number;actor_conversation_id:string|null;payload_json:string;created_at:string}[];
  const e=events[0];
  if(events.length!==1 || !e || e.actor_conversation_id!==null)fail('HUMAN_ANSWER_REQUIRED','Exactly one genuine native human answer required');
  const event=e!,answer=JSON.parse(d.answer_json??'null'),raw=JSON.parse(event.payload_json);
  if(!answer || raw.action!=='approve' || raw.scope!=='this_case' || answer.action!==raw.action || answer.scope!==raw.scope || answer.text!==raw.text || answer.actor_id!==event.actor_id)fail('HUMAN_ANSWER_REQUIRED','Current answer and immutable human attribution disagree');
  const approver={user:user(event.actor_id)};
  bots.read(approver,d.id); // Rechecks the approver's current evidence access too.
  if(!bots.view(approver,d).can_answer)fail('ACCESS_REVOKED','Original approver no longer has authority',403);
  const snapshot=db.prepare("SELECT kind,payload_json,created_at FROM bot_decision_events WHERE decision_id=? AND version=? AND kind IN ('raised','revised') AND rowid<? ORDER BY rowid DESC LIMIT 1").get(d.id,d.version,event.rowid) as {kind:string;payload_json:string;created_at:string}|undefined;
  if(!snapshot)fail('NATIVE_BINDING_CHANGED','Approved proposal snapshot missing');
  const originalProposal=JSON.parse(snapshot!.payload_json);
  if(canonicalSha256(snapshot!.kind==='raised'?originalProposal.proposal:originalProposal)!==p.native_proposal_hash)fail('NATIVE_BINDING_CHANGED','Original approved scope changed');
  const age=now()-Date.parse(event.created_at.replace(' ','T')+'Z');
  if(!Number.isFinite(age)||age< -1000||age>86400000)fail('EXPIRED','Human answer is outside the 24-hour maximum validity');
  const parsed=timingProposalSchema.safeParse(proposal.purchase_timing);
  if(!parsed.success)fail('SOURCE_MAPPING_REQUIRED','Native human approval is retained. Missing authenticated source linkage from this unchanged approved proposal to exact order/line, amount/currency, delivery windows/timezone, executor, and material/action/cart versions. A fresh observation or prose reconstruction cannot establish historical linkage; do not request duplicate consent');
  const approved=parsed.data!;
  const original=captureRow(approved.capture_id,t);
  const current=captureRow(p.source_capture_id,t,true);
  scope(t,approved.scope);scope(t,current.raw.scope);
  const scopeHash=canonicalSha256(approved.scope);
  const newest=db.prepare("SELECT scope_hash FROM purchase_timing_captures WHERE trust_id=? AND json_extract(request_json,'$.scope.order_id')=? ORDER BY rowid DESC LIMIT 1").get(t.id,approved.scope.order_id) as {scope_hash:string}|undefined;
  if(newest?.scope_hash!==scopeHash)fail('SOURCE_SUPERSEDED','Newer authoritative material supersedes this approval');
  if(scopeHash!==original.row.scope_hash || scopeHash!==current.row.scope_hash)fail('SOURCE_BINDING_CHANGED','Approved and fresh authoritative source material differ');
  // Native event timestamps have second precision; allow no later capture
  // to masquerade as evidence that was already in the approved snapshot.
  if(Date.parse(original.row.received_at)>Date.parse(snapshot!.created_at+'Z')+999)fail('NATIVE_BINDING_CHANGED','Source evidence was not retained before the proposal');
  const contextEvent=db.prepare("SELECT payload_json FROM bot_decision_events WHERE decision_id=? AND version=? AND kind='purchase_timing_context'").all(d.id,d.version) as {payload_json:string}[];
  const watermark=contextEvent.length===1?JSON.parse(contextEvent[0]!.payload_json):null;
  if(!watermark || watermark.answer_event_id!==e!.id || canonicalSha256(watermark.context)!==canonicalSha256(timingHumanContext(db,d.conversation_id,d.id)))fail('HUMAN_CONTEXT_CHANGED','Human context changed or native answer watermark is missing');
  if(d.state!=='running')fail('NOT_APPROVED_RUNNING','Native decision must be approved and running');
  const delivered=db.prepare("SELECT 1 FROM conversation_wakeups WHERE id=? AND status='delivered'").get(event.id);
  const result=db.prepare("SELECT payload_json FROM bot_decision_events WHERE decision_id=? AND version=? AND kind='result' ORDER BY rowid DESC LIMIT 1").get(d.id,d.version) as {payload_json:string}|undefined;
  const running=result?JSON.parse(result.payload_json):null;
  if(!delivered || running?.state!=='running' || running.material_evidence_unchanged!==true)fail('NOT_APPROVED_RUNNING','Delivered answer and fresh native running evidence required');
  return {schema_version:protocol,trust_id:t.id,decision_id:d.id,decision_version:d.version,native_proposal_hash:p.native_proposal_hash,
   source_scope_hash:scopeHash,source_material_fingerprint:approved.scope.material_fingerprint,source_material_schema:approved.scope.schema_version,
   scope:approved.scope,approval_event_id:event.id,approver_id:event.actor_id,approved_at:new Date(event.created_at.replace(' ','T')+'Z').toISOString(),
   verified_at:timestamp(),expires_at:new Date(Math.min(now()+5000,Date.parse(approved.scope.authorization_expires_at))).toISOString(),timing_only:true as const};
 }
 function receipt(t:Trust){return {schema_version:protocol,trust_id:t.id,request_key:t.request_key,owner_id:t.owner_id,business_id:t.business_id,executor_id:t.executor_id,account_id:t.account_id,principal_id:t.principal_id,source_origin:t.source_origin,audience:t.audience,client_id:t.client_id,created_at:t.created_at,revoked:!!db.prepare('SELECT 1 FROM purchase_timing_revocations WHERE trust_id=?').get(t.id)};}
 function setupReview(a:Actor,raw:unknown){
  const p=timingEnrollmentSchema.parse(raw);owner(a,p.business_id);executor({...p,owner_id:a.user.id});const conf=configured();
  const enrollment={...p,audience:conf.audience,client_id:conf.clientId,owner_id:a.user.id};
  const rows=db.prepare('SELECT * FROM purchase_timing_trust WHERE request_key=? OR (business_id=? AND account_id=? AND executor_id=?)').all(p.request_key,p.business_id,p.account_id,p.executor_id) as Trust[];
  if(rows.length>1 || rows.some(r=>r.enrollment_json!==canonicalJson(enrollment)))fail('SETUP_CONFLICT','A different immutable registration already exists');
  const existing=rows[0];
  return {schema_version:protocol,enrollment,review_hash:canonicalSha256(enrollment),status:existing?(receipt(existing).revoked?'revoked':'registered'):'ready',receipt:existing?receipt(existing):null};
 }
 return {
  setupOptions(a:Actor){
   if(a.conversationId)fail('OWNER_REQUIRED','Human setup only',403);user(a.user.id);
   const businesses=db.prepare('SELECT id,name FROM business_teams WHERE owner_id=?').all(a.user.id);
   const executors=db.prepare('SELECT c.id,c.title,c.business_team_id FROM conversations c JOIN business_teams b ON b.id=c.business_team_id JOIN bot_registrations r ON r.conversation_id=c.id WHERE b.owner_id=? AND c.user_id=? AND c.archived=0 AND r.active=1').all(a.user.id,a.user.id);
   return {schema_version:protocol,configured:!!timingConfiguration(config),businesses,executors,service:timingConfiguration(config),requires:'Dedicated CF service configuration and verified source deployment/custody receipt. Registration is setup only, never purchase approval. Purchase dispatch is unavailable until an enforced request transport is implemented and accepted.'};
  },
  setupReview,
  enroll(a:Actor,raw:unknown){
   const p=z.object({enrollment:timingEnrollmentSchema,review_hash:z.string(),confirm:z.literal(true)}).strict().parse(raw);
   return db.transaction(()=>{
    const review=setupReview(a,p.enrollment);
    if(review.review_hash!==p.review_hash)fail('SETUP_CHANGED','Review the current setup before confirming');
    if(review.status==='revoked')fail('TRUST_REVOKED','Revoked registrations cannot be reactivated');
    if(review.status==='registered')return review;
    const e=review.enrollment,id=crypto.randomUUID();
    db.prepare('INSERT INTO purchase_timing_trust(id,request_key,owner_id,business_id,executor_id,account_id,principal_id,source_origin,audience,client_id,enrollment_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id,e.request_key,e.owner_id,e.business_id,e.executor_id,e.account_id,e.principal_id,e.source_origin,e.audience,e.client_id,canonicalJson(e));
    return setupReview(a,p.enrollment);
   }).immediate();
  },
  setupStatus(a:Actor,key:string){
   const t=db.prepare('SELECT * FROM purchase_timing_trust WHERE request_key=?').get(timingKey.parse(key)) as Trust|undefined;
   if(!t)fail('NOT_FOUND','No registration with this exact request key',404);owner(a,t!.business_id);return receipt(t!);
  },
  revoke(a:Actor,id:string,reason:string){return db.transaction(()=>{
   const t=db.prepare('SELECT * FROM purchase_timing_trust WHERE id=?').get(id) as Trust|undefined;
   if(!t)fail('NOT_FOUND','Trust not found',404);owner(a,t!.business_id);
   const text=z.string().trim().min(1).max(1000).parse(reason),prior=db.prepare('SELECT reason FROM purchase_timing_revocations WHERE trust_id=?').get(id) as {reason:string}|undefined;
   if(prior && prior.reason!==text)fail('REQUEST_CONFLICT','Revocation reason differs');
   db.prepare('INSERT OR IGNORE INTO purchase_timing_revocations(trust_id,actor_id,reason) VALUES(?,?,?)').run(id,a.user.id,text);return receipt(t!);
  }).immediate();},
  capture(identity:TimingIdentity,raw:unknown){return db.transaction(()=>{
   const p=timingCaptureSchema.parse(raw),t=trust(p.trust_id,identity);scope(t,p.scope);
   const prior=db.prepare('SELECT * FROM purchase_timing_captures WHERE trust_id=? AND request_key=?').get(t.id,p.request_key) as Capture|undefined;
   if(prior){if(prior.request_json!==canonicalJson(p))fail('REQUEST_CONFLICT','Capture key already has different evidence');return {schema_version:protocol,capture_id:prior.id,source_scope_hash:prior.scope_hash,execute:false};}
   if(now()-Date.parse(p.captured_at)>30000 || Date.parse(p.captured_at)>now()+1000 || Date.parse(p.scope.authorization_expires_at)>now()+86400000)fail('SOURCE_STALE','Source capture must be fresh with expiry at most 24 hours away');
   const id=crypto.randomUUID(),hash=canonicalSha256(p.scope);
   db.prepare('INSERT INTO purchase_timing_captures(id,trust_id,request_key,request_json,scope_hash,received_at) VALUES(?,?,?,?,?,?)').run(id,t.id,p.request_key,canonicalJson(p),hash,timestamp());
   return {schema_version:protocol,capture_id:id,source_scope_hash:hash,execute:false};
  }).immediate();},
  captureStatus(identity:TimingIdentity,trustId:string,key:string){const t=trust(trustId,identity,false);const c=db.prepare('SELECT * FROM purchase_timing_captures WHERE trust_id=? AND request_key=?').get(t.id,key) as Capture|undefined;if(!c)fail('NOT_FOUND','Capture not found',404);return {schema_version:protocol,capture_id:c!.id,source_scope_hash:c!.scope_hash,execute:false};},
  verify(identity:TimingIdentity,raw:unknown){return db.transaction(()=>{const p=timingRequestSchema.parse(raw),t=trust(p.trust_id,identity);return {...nativeProof(t,p),execute:false};}).immediate();},
  claim(identity:TimingIdentity,raw:unknown){return db.transaction(()=>{
   const p=timingRequestSchema.parse(raw),t=trust(p.trust_id,identity,false);
   const old=db.prepare('SELECT * FROM purchase_timing_claims WHERE trust_id=? AND request_key=?').get(t.id,p.request_key) as Claim|undefined;
   if(old){if(old.request_json!==canonicalJson(p))fail('REQUEST_CONFLICT','Claim key already binds a different intent');return {schema_version:protocol,claim_id:old.id,request_key:p.request_key,receipt:JSON.parse(old.receipt_json),execute:false,status:'claimed',reconciliation_only:true};}
   trust(t.id,identity);const proof=nativeProof(t,p);
   if(db.prepare('SELECT 1 FROM purchase_timing_claims WHERE decision_id=? OR (business_id=? AND account_id=? AND order_id=?)').get(p.decision_id,t.business_id,t.account_id,proof.scope.order_id))fail('ALREADY_CLAIMED','Decision or source order already claimed; reconcile the original intent');
   // No deployed transport controls the actual browser purchase request. A
   // source transition or operator receipt cannot establish that boundary.
   // Retain historical claims above for UNKNOWN reconciliation, never mint a
   // new bearer grant until a concrete enforcing transport is implemented.
   return fail('EXECUTION_BOUNDARY_UNAVAILABLE','No enforced purchase request transport is deployed. Source transition locks end before generic browser submission; no execution grant was created');
  }).immediate();},
  reconcile(identity:TimingIdentity,trustId:string,key:string){
   const t=trust(trustId,identity,false),c=db.prepare('SELECT * FROM purchase_timing_claims WHERE trust_id=? AND request_key=?').get(t.id,key) as Claim|undefined;
   if(!c)fail('NOT_FOUND','No claim for this exact intent; this is not execution permission',404);
   return {schema_version:protocol,claim_id:c!.id,request_key:key,receipt:JSON.parse(c!.receipt_json),execute:false,status:'claimed',reconciliation_only:true};
  },
  executionCheck(identity:TimingIdentity,raw:unknown){return db.transaction(()=>{
   const p=z.object({schema_version:z.literal('veneer-purchase-timing-execution-check/v1'),trust_id:timingKey,request_key:timingKey,source_capture_id:timingKey}).strict().parse(raw);
   const t=trust(p.trust_id,identity),c=db.prepare('SELECT * FROM purchase_timing_claims WHERE trust_id=? AND request_key=?').get(t.id,p.request_key) as Claim|undefined;
   if(!c)fail('NOT_FOUND','Claim not found',404);
   const original=JSON.parse(c!.receipt_json) as {expires_at:string};
   if(now()>=Date.parse(original.expires_at))fail('EXPIRED','Original one-time claim window expired; no renewed execution');
   nativeProof(t,{...JSON.parse(c!.request_json),source_capture_id:p.source_capture_id});
   return fail('EXECUTION_BOUNDARY_UNAVAILABLE','An existing claim cannot authorize a generic browser purchase. Reconcile the same intent read-only; no renewed execution');
  }).immediate();},
 };
}
