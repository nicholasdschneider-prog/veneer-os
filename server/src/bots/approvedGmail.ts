import type Database from 'better-sqlite3';
import {BotError,type Actor} from './service.js';
import {canonicalSha256} from './canonical.js';
import {messageDelegationService,MissingMessageProof,type CaseMappingCheck,type CaseMappingEvidence} from './messageDelegation.js';
import {gmailBindingTargetSchema,gmailSourceSchema,type GmailTarget} from './approvedGmailContract.js';
import type {approvedMessageSchema} from './draftPayload.js';
import type {z} from 'zod';
export interface ApprovedGmailReader {
 // Installed by native integration, never HTTP/agent input. Must read the actual
 // caller's account, entire bounded thread, anchor/latest inbound and attachment bytes.
 read(a:Actor,target:GmailTarget,scope:z.infer<typeof approvedMessageSchema>):Promise<{
   evidence:unknown;
   // Synchronous own-caller/custody/connection revocation recheck inside IMMEDIATE.
   revalidate:()=>void;
 }>;
}
export function approvedGmailResolver(db:Database.Database,reader?:ApprovedGmailReader,now=Date.now){
 return {async prepare(a:Actor,raw:unknown,receiptOnly=false):Promise<CaseMappingCheck>{
   const target=gmailBindingTargetSchema.parse(raw);
   const pre=messageDelegationService(db,()=>({} as CaseMappingEvidence)).mappingTarget(a,target.decision_id,target.expected_version,receiptOnly);
   if(a.conversationId!==pre.d.conversation_id||pre.scope.executor_conversation_id!==a.conversationId)throw new BotError(403,'Original Gmail decision owner and executor required');
   if(pre.scope.payload.channel!=='email'||pre.scope.canonical_case!==target.thread_id||pre.scope.canonical_case===pre.scope.payload.ticket)throw new MissingMessageProof(['explicit exact Gmail thread scope required; no alias or UUID inference']);
   const owner=db.prepare('SELECT user_id,business_team_id FROM conversations WHERE id=?').get(a.conversationId) as {user_id:number;business_team_id:string};
   if(owner.user_id!==a.user.id)throw new BotError(403,'Original caller ownership changed');
   if(!reader)throw new MissingMessageProof(['approved-gmail-source/v1 native own-account reader unavailable: actual caller connection/account identity, complete bounded thread and reply/latest-inbound, material and attachment verification, synchronous custody revocation recheck; original connector custodian and Platform integration required']);
   const started=now(),result=await reader.read(a,target,pre.scope),source=gmailSourceSchema.parse(result.evidence),at=now();
   if(source.caller_id!==a.conversationId||source.user_id!==a.user.id||owner.user_id!==a.user.id||source.business_id!==owner.business_team_id||
     source.account!==pre.scope.payload.account||source.thread_id!==target.thread_id||source.reply_message_id!==target.reply_message_id||
     source.reply_rfc_message_id!==target.reply_rfc_message_id||source.latest_inbound_id!==target.reply_message_id||
     source.decision_id!==target.decision_id||source.decision_version!==target.expected_version||source.scope_hash!==pre.payload_hash||
     canonicalSha256(source.recipients)!==canonicalSha256(pre.scope.payload.recipients)||
     canonicalSha256(source.attachment_hashes)!==canonicalSha256(pre.scope.payload.attachments.map(x=>x.sha256)))
     throw new MissingMessageProof(['authenticated Gmail caller/account/thread/anchor/recipient/attachment scope differs']);
   const {observed_at,expires_at,source_revision,material_hash,...identity}=source;
   const fingerprint=canonicalSha256({...identity,material_hash});
   return (actor,decision,scope)=>{
     result.revalidate();
     const t=now();
     if(t<at||t-started>15000||Date.parse(observed_at)>t||t-Date.parse(observed_at)>5000||Date.parse(expires_at)<=t||
       Date.parse(expires_at)-Date.parse(observed_at)>15000||actor.user.id!==a.user.id||actor.conversationId!==a.conversationId||
       decision.id!==target.decision_id||decision.version!==target.expected_version||
       canonicalSha256(JSON.parse(decision.proposal_json))!==pre.proposal_hash||canonicalSha256(scope)!==source.scope_hash)
       throw new MissingMessageProof(['Gmail source observation expired, revoked or exact approval changed']);
     return {...source,fingerprint};
   };
 }};
}
