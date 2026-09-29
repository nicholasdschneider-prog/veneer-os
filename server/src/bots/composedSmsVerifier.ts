import {composeCurrentContext,guardManifestSchema} from './composedSmsContext.js';
import {composeOriginalHashes} from './composedSmsAuthority.js';
import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import {BotError} from './service.js';
import {canonicalJson,canonicalSha256} from './canonical.js';
import {associationInputSchema,associationV2Schema,bindingHash,sourceReadbackSchema,sourceReadbackV2Schema,composeHash,verifyAuthority,type ComposeAuthority} from './composedSmsContract.js';
import {checkComposeRegistration,boundaryUnavailable,type ComposeRegistration} from './composedSmsTrust.js';
type Dispatch={authority_id:string;action_id:string;registration_id:string;registration_hash:string;tuple_json:string;sender_expires_at:string;expires_at:string};
type Association={id:string;authority_id:string;action_id:string;claim_id:string;registration_id:string;prepare_id:string;request_key:string;request_hash:string;binding_hash:string;source_evidence_json:string;issued_at:string;expires_at:string};
export interface ComposeVerifierIO {
 registration:(id:string)=>ComposeRegistration;
 // A native-only recheck. It may not borrow executor credentials to fetch source data.
 nativeCurrent:(authorityId:string,receiptOnly:boolean)=>void;
 readback:(r:ComposeRegistration,a:ComposeAuthority)=>Promise<unknown>;
 now:()=>number;
}
export function composedSmsVerifier(db:Database.Database,io:ComposeVerifierIO){
 const event=(id:string,kind:string)=>db.prepare('SELECT actor_id,actor_conversation_id,payload_json FROM bot_composed_sms_events WHERE authority_id=? AND kind=?').get(id,kind) as {actor_id:number;actor_conversation_id:string;payload_json:string}|undefined;
 function bound(registrationId:string,authorityId:string,receiptOnly=false){
  const r=io.registration(registrationId),rh=checkComposeRegistration(db,r,io.now());
  const d=db.prepare('SELECT * FROM bot_composed_sms_dispatch_authorities WHERE authority_id=?').get(authorityId) as Dispatch|undefined;
  if(!d)return boundaryUnavailable();
  if(d.registration_id!==registrationId||d.registration_hash!==rh)throw new BotError(403,'Exact service registration changed');
  let a:ComposeAuthority;try{a=verifyAuthority(JSON.parse(d.tuple_json));}catch{throw new BotError(409,'Immutable authority hash proof missing or incompatible; no retrofit');}
  const g=db.prepare('SELECT * FROM bot_composed_sms_authorities WHERE id=?').get(authorityId) as {owner_id:string;executor_id:string;source_id:string;snapshot_json:string}|undefined;
  const b=r.executorBindings.find(b=>b.conversationId===a.executorConversationId);
  if(!g||g.source_id!==a.sourceInstructionId||g.owner_id!==a.ownerConversationId||g.executor_id!==a.executorConversationId||!b||b.principalId!==a.executorPrincipalId||a.businessId!==r.businessId||a.sourceOrigin!==r.sourceOrigin||canonicalJson(a.runtime)!==canonicalJson(r.runtime))throw new BotError(403,'Authority source, runtime or executor binding differs');
  const original=composeOriginalHashes(JSON.parse(g.snapshot_json),g.source_id,g.owner_id);
  if(a.payloadHash!==original.payloadHash||a.sourceInstructionHash!==original.sourceInstructionHash)throw new BotError(409,'Immutable authority original hashes differ');
  if(event(authorityId,'revoked'))throw new BotError(403,'Authority revoked');
  if(!receiptOnly&&Math.min(Date.parse(d.expires_at),Date.parse(d.sender_expires_at))<=io.now())throw new BotError(409,'Authority or sender evidence expired');
  io.nativeCurrent(authorityId,receiptOnly);
  return {r,d,a,b};
 }
 function view(x:Association,entitled=false){return {schemaVersion:JSON.parse(x.source_evidence_json).schemaVersion,associationId:x.id,nativeActionId:x.action_id,nativeClaimId:x.claim_id,sourcePrepareId:x.prepare_id,bindingHash:x.binding_hash,state:event(x.authority_id,'revoked')?'REVOKED':'ASSOCIATED',dispatchEntitlement:entitled,execute:false,issuedAt:x.issued_at,expiresAt:x.expires_at};}
 async function source(r:ComposeRegistration,a:ComposeAuthority){const started=io.now();let p;try{p=sourceReadbackV2Schema.or(sourceReadbackSchema).parse(await io.readback(r,a));}catch{throw new BotError(503,'Authenticated exact source readback unavailable');}
  if(io.now()-started>10000||Date.parse(p.observedAt)>io.now()+5000||io.now()-Date.parse(p.observedAt)>15000||p.nativeActionId!==a.nativeActionId||p.authorityHash!==a.authorityHash||p.wirePayloadHash!==a.wirePayloadHash||p.idempotencyKey!==a.idempotencyKey)throw new BotError(409,'Stale or conflicting source action readback');return p;}
 function context(reg:string,id:string,revision:number,actionId:string){
  const {r,d,a}=bound(reg,id);if(revision!==a.authorityRevision||actionId!==a.nativeActionId)throw new BotError(409,'Exact authority revision/action required');
  return composeCurrentContext(db,r,a,io.now(),Math.min(Date.parse(d.expires_at),Date.parse(d.sender_expires_at)));
 }
 function guards(r:ComposeRegistration){
  const m=guardManifestSchema.safeParse(r.guardManifest),p=r.guardAcceptance;
  if(!m.success||!p||p.manifestHash!==r.guardContractHash||composeHash('compose-sms-guards/v1',m.data)!==r.guardContractHash||m.data.sourceRegistrationHash!==r.sourceRegistrationHash||m.data.sourceOrigin!==r.sourceOrigin||canonicalJson(m.data.runtime)!==canonicalJson(r.runtime)||Date.parse(p.reviewedAt)>io.now()||Date.parse(p.expiresAt)<=io.now())return boundaryUnavailable();
 }
 return {
  currentContext(reg:string,id:string,revision:number,actionId:string){return db.transaction(()=>context(reg,id,revision,actionId)).deferred();},
  authority(reg:string,id:string,revision:number,actionId:string){const {r,d,a}=bound(reg,id);if(revision!==a.authorityRevision||actionId!==a.nativeActionId)throw new BotError(409,'Exact authority revision/action required');const observedAt=io.now(),expiresAt=Math.min(observedAt+15000,Date.parse(d.expires_at),Date.parse(d.sender_expires_at),Date.parse(r.expiresAt));if(expiresAt<=observedAt)throw new BotError(409,'Authority observation dependencies expired');return {schemaVersion:'native-compose-sms/v1',registrationId:r.registrationId,registrationRevision:r.revision,sourceRegistrationHash:r.sourceRegistrationHash,authority:a,observedAt:new Date(observedAt).toISOString(),expiresAt:new Date(expiresAt).toISOString(),execute:false};},
  async associate(reg:string,raw:unknown){const p=associationV2Schema.or(associationInputSchema).parse(raw),first=bound(reg,p.authorityId);
   if(p.nativeActionId!==first.a.nativeActionId||p.authorityRevision!==first.a.authorityRevision||p.bindingHash!==bindingHash(first.r,first.a))throw new BotError(409,'Exact registered authority binding required');
   const requestHash=canonicalSha256(p);
   const old=db.prepare('SELECT * FROM bot_composed_sms_associations WHERE action_id=?').get(p.nativeActionId) as Association|undefined;
   if(old){if(old.registration_id!==reg||old.request_hash!==requestHash)throw new BotError(409,'Conflicting dispatch association');return view(old);}
   if(p.schemaVersion!=='native-compose-sms/v2')return boundaryUnavailable();
   guards(first.r);
   const observed=await source(first.r,first.a);
   if(observed.schemaVersion!=='native-compose-sms/v2'||observed.contextRevision!==p.contextRevision||observed.scopeEvidenceRevision!==p.scopeEvidenceRevision||observed.guardManifestHash!==p.guardManifestHash||p.guardManifestHash!==first.r.guardContractHash)throw new BotError(409,'Persisted v2 source context and guard binding required');
   // Old v1 observations lacking durable prepare expiry/key never grant entitlement.
   if(!observed.prepareExpiresAt||observed.redeemRequestKey!==p.requestKey||Date.parse(observed.prepareExpiresAt)<=io.now())return boundaryUnavailable();
   if(observed.state!=='REDEEMING'||observed.prepareId!==p.sourcePrepareId||observed.nativeClaimId!==p.nativeClaimId||observed.bindingHash!==p.bindingHash||observed.associationId!==null||observed.attemptId!==null||observed.providerReceipt!==null)throw new BotError(409,'Source must have durably fenced this exact prepare before redemption');
   return db.transaction(()=>{
    const current=bound(reg,p.authorityId);guards(current.r);
    if(Date.parse(observed.prepareExpiresAt!)<=io.now()||canonicalSha256(current.r)!==canonicalSha256(first.r)||io.now()-Date.parse(observed.observedAt)>5000)throw new BotError(409,'Source observation or registration changed');
    const prior=db.prepare('SELECT * FROM bot_composed_sms_associations WHERE action_id=? OR claim_id=? OR (registration_id=? AND (prepare_id=? OR request_key=?))').get(p.nativeActionId,p.nativeClaimId,reg,p.sourcePrepareId,p.requestKey) as Association|undefined;
    if(prior){if(prior.request_hash!==requestHash||prior.registration_id!==reg)throw new BotError(409,'Dispatch already consumed by another tuple');return view(prior);}
    const c=context(reg,p.authorityId,p.authorityRevision,p.nativeActionId);
    if(c.contextRevision!==p.contextRevision||c.scopeEvidenceRevision!==p.scopeEvidenceRevision||c.blockingIds.length)throw new BotError(409,'Native context changed or unresolved scoped obligations remain');

    const accepted=event(p.authorityId,'accepted'),claimed=event(p.authorityId,'claimed'),claim=claimed?JSON.parse(claimed.payload_json):null;
    if(!accepted||!claimed||accepted.actor_conversation_id!==current.a.executorConversationId||claimed.actor_conversation_id!==current.a.executorConversationId||claimed.actor_id!==current.b.userId||claim.native_claim_id!==p.nativeClaimId||claim.native_action_id!==p.nativeActionId||claim.authority_hash!==current.a.authorityHash)throw new BotError(409,'Original named executor acceptance and reservation required');
    const x:Association={id:crypto.randomUUID(),authority_id:p.authorityId,action_id:p.nativeActionId,claim_id:p.nativeClaimId,registration_id:reg,prepare_id:p.sourcePrepareId,request_key:p.requestKey,request_hash:requestHash,binding_hash:p.bindingHash,source_evidence_json:canonicalJson(observed),issued_at:new Date(io.now()).toISOString(),expires_at:new Date(Math.min(io.now()+15000,Date.parse(current.d.expires_at),Date.parse(current.d.sender_expires_at),Date.parse(current.r.expiresAt),Date.parse(current.r.guardAcceptance!.expiresAt),Date.parse(observed.prepareExpiresAt!))).toISOString()};
    db.prepare('INSERT INTO bot_composed_sms_associations(id,authority_id,action_id,claim_id,registration_id,prepare_id,request_key,request_hash,binding_hash,source_evidence_json,issued_at,expires_at) VALUES(@id,@authority_id,@action_id,@claim_id,@registration_id,@prepare_id,@request_key,@request_hash,@binding_hash,@source_evidence_json,@issued_at,@expires_at)').run(x);
    return view(x,true);
   }).immediate();
  },
  association(reg:string,id:string,byAction=false){checkComposeRegistration(db,io.registration(reg),io.now());const x=db.prepare(`SELECT * FROM bot_composed_sms_associations WHERE ${byAction?'action_id':'id'}=? AND registration_id=?`).get(id,reg) as Association|undefined;if(!x)throw new BotError(404,'Association not found');return view(x);},
  async receipt(reg:string,actionId:string){const x=db.prepare('SELECT * FROM bot_composed_sms_associations WHERE action_id=? AND registration_id=?').get(actionId,reg) as Association|undefined;if(!x)throw new BotError(404,'Existing association required');const first=bound(reg,x.authority_id,true),p=await source(first.r,first.a);
   const original=JSON.parse(x.source_evidence_json);
   if(p.schemaVersion!==original.schemaVersion||(p.schemaVersion==='native-compose-sms/v2'&&(p.contextRevision!==original.contextRevision||p.scopeEvidenceRevision!==original.scopeEvidenceRevision||p.guardManifestHash!==original.guardManifestHash)))throw new BotError(409,'Receipt context binding mismatch');
   if(p.prepareId!==x.prepare_id||p.bindingHash!==x.binding_hash||p.nativeClaimId!==x.claim_id||p.associationId!==x.id)throw new BotError(409,'Source receipt association mismatch');
   if(p.state!=='SENT_ACCEPTED')return {execute:false,state:p.state,receipt:null};
   const receipt=p.providerReceipt;
   if(!p.attemptId||!receipt||receipt.providerAccountId!==first.a.senderAccountId||receipt.fromPhone!==first.a.fromPhone||receipt.toPhone!==first.a.toPhone||receipt.wirePayloadHash!==first.a.wirePayloadHash||Date.parse(receipt.checkedAt)>io.now()+5000||Date.parse(receipt.checkedAt)<Date.parse(x.issued_at))throw new BotError(409,'Exact persisted provider acceptance proof required');
   return db.transaction(()=>{bound(reg,x.authority_id,true);if(io.now()-Date.parse(p.observedAt)>5000)throw new BotError(409,'Receipt observation expired');
    const old=db.prepare('SELECT evidence_json FROM bot_composed_sms_service_receipts WHERE association_id=?').get(x.id) as {evidence_json:string}|undefined;
    // Observation time can refresh; immutable effect identity and evidence cannot.
    const {observedAt,...evidence}=p,json=canonicalJson(evidence);
    if(old){if(old.evidence_json!==json)throw new BotError(409,'Conflicting provider receipt');}else{
     if(db.prepare('SELECT 1 FROM bot_composed_sms_service_receipts WHERE provider_account=? AND provider_id=?').get(receipt.providerAccountId,receipt.providerMessageId))throw new BotError(409,'Provider effect already recorded');
     db.prepare('INSERT INTO bot_composed_sms_service_receipts(association_id,registration_id,evidence_json,provider_account,provider_id,recorded_at) VALUES(?,?,?,?,?,?)').run(x.id,reg,json,receipt.providerAccountId,receipt.providerMessageId,new Date(io.now()).toISOString());
    }return {execute:false,state:'SENT_ACCEPTED',receipt:evidence};
   }).immediate();
  },
 };
}
