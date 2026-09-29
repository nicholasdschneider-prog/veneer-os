import fs from 'node:fs';
import path from 'node:path';
import {z} from 'zod';
import type {AppContext} from '../context.js';
import type {Actor} from './service.js';
import {BotError} from './service.js';
import {uuid,time,hash,text,type ComposeAuthority} from './composedSmsContract.js';
import {checkComposeRegistration,loadComposeServiceRegistry,type ComposeRegistration} from './composedSmsTrust.js';
import {canonicalSha256} from './canonical.js';
import {boundedResolverGet} from './approvedCaseResolver.js';
import {readSecretValue} from '../secrets/readSecret.js';
import {composeEvidenceIdentity,composeClosureSchema,verifyComposeClosure} from './composedSmsClosure.js';
import {composeSenderObservationSchema,verifyComposeSender} from './composedSmsSender.js';
import type {ComposeScopeReader} from './composedSmsScope.js';
const credentialRef=z.object({project:z.string().regex(/^[A-Za-z0-9_.-]+$/),config:z.string().regex(/^[A-Za-z0-9_.-]+$/),name:z.string().regex(/^[A-Z][A-Z0-9_]*$/)}).strict();
const grant=z.object({principalId:text,credential:credentialRef,credentialExpiresAt:time,operations:z.array(z.enum(['sender.read','scope.owner.read','scope.action.read'])).min(1).max(3)}).strict();
export const composeEvidenceRegistrySchema=z.object({schemaVersion:z.literal('compose-evidence-custody/v1'),registrations:z.array(z.object({registrationId:uuid,sourceRegistrationHash:hash,active:z.boolean(),ownerConversationId:uuid,executorConversationId:uuid,payloadAccount:text,expiresAt:time,issuedBy:uuid,receipt:text,receiptHash:hash,
 callers:z.array(grant.extend({conversationId:uuid,userId:z.number().int().positive()})).min(1).max(2),
 serviceScopeReader:grant.optional(),
 scopeAuditIssuance:z.literal('immutable-source-evidence-only'),
 }).strict()).max(30)}).strict();
type Registry=z.infer<typeof composeEvidenceRegistrySchema>;
export function loadComposeEvidenceRegistry(file:string|null|undefined):Registry{let fd:number|undefined;try{if(!file||!path.isAbsolute(file))throw Error();fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);const s=fs.fstatSync(fd);if(!s.isFile()||s.uid!==process.getuid?.()||(s.mode&0o777)!==0o600||s.size>128*1024)throw Error();const buffer=Buffer.alloc(128*1024+1),size=fs.readSync(fd,buffer,0,buffer.length,0);if(size>128*1024)throw Error();return composeEvidenceRegistrySchema.parse(JSON.parse(buffer.subarray(0,size).toString('utf8')));}catch{throw new BotError(503,'COMPOSE_EVIDENCE_CUSTODY_REQUIRED: separate sender/closure reader and source evidence issuance permission required');}finally{if(fd!==undefined)fs.closeSync(fd);}}
export const serviceScopeEnvelopeSchema=z.object({schemaVersion:z.literal('compose-sms-action-scope/v1'),servicePrincipalId:text,registrationId:uuid,sourceRegistrationHash:hash,nativeActionId:uuid,authorityId:uuid,authorityRevision:z.literal(1),authorityHash:hash,closure:composeClosureSchema}).strict();
export const senderEnvelopeSchema=z.object({schemaVersion:z.literal('compose-sms-evidence/v1'),identity:composeEvidenceIdentity,canonicalCaseId:uuid,contactCaseId:uuid,sender:composeSenderObservationSchema.nullable()}).strict();
export interface ComposeEvidenceIO{registry:()=>Registry;registration:(id:string)=>ComposeRegistration;secret:(ref:z.infer<typeof credentialRef>)=>Promise<string>;get:typeof boundedResolverGet;now:()=>number}
export function composeEvidenceReader(ctx:Pick<AppContext,'db'|'config'|'projectDopplerCli'>,override?:ComposeEvidenceIO){
 const io=override??{registry:()=>loadComposeEvidenceRegistry(ctx.config.composeEvidenceRegistryFile),registration:(id:string)=>{const rs=loadComposeServiceRegistry(ctx.config.composeServiceRegistryFile).registrations.filter(r=>r.registrationId===id);if(rs.length!==1)throw new BotError(503,'Exact service registration required');return rs[0]!;},secret:async(ref:z.infer<typeof credentialRef>)=>(await readSecretValue({db:ctx.db,projectDopplerCli:ctx.projectDopplerCli??null},ref)).value,get:boundedResolverGet,now:Date.now};
 async function fetch(r:ComposeRegistration,owner:string,executor:string,actor:Actor|null,route:string){
  const regs=io.registry().registrations.filter(x=>x.registrationId===r.registrationId);if(regs.length!==1)throw new BotError(503,'One exact evidence custody required');const reg=regs[0]!,digest=canonicalSha256(reg),start=io.now();
  function current(){if(!reg.active||Date.parse(reg.expiresAt)<=io.now()||Date.parse(reg.expiresAt)>Date.parse(r.expiresAt)||reg.sourceRegistrationHash!==r.sourceRegistrationHash||reg.ownerConversationId!==owner||reg.executorConversationId!==executor||canonicalSha256(io.registry().registrations.filter(x=>x.registrationId===r.registrationId))!==canonicalSha256([reg])||checkComposeRegistration(ctx.db,io.registration(r.registrationId),io.now())!==canonicalSha256(r))throw new BotError(403,'Evidence custody changed');
   if(actor){if(!actor.conversationId||![owner,executor].includes(actor.conversationId))throw new BotError(403,'Own original caller required');const grants=reg.callers.filter(x=>x.conversationId===actor.conversationId&&x.userId===actor.user.id);const c=ctx.db.prepare('SELECT user_id,business_team_id,archived FROM conversations WHERE id=?').get(actor.conversationId) as {user_id:number;business_team_id:string;archived:number}|undefined;if(grants.length!==1||Date.parse(grants[0]!.credentialExpiresAt)<=io.now()||Date.parse(grants[0]!.credentialExpiresAt)>Date.parse(reg.expiresAt)||!grants[0]!.operations.includes(route.includes('/scope/')?'scope.owner.read':'sender.read')||(route.includes('/scope/')&&actor.conversationId!==owner)||!c||c.archived||c.user_id!==actor.user.id||c.business_team_id!==r.businessId||!ctx.db.prepare("SELECT 1 FROM users WHERE id=? AND status='active'").get(actor.user.id)||!ctx.db.prepare('SELECT 1 FROM bot_registrations WHERE conversation_id=? AND active=1').get(actor.conversationId))throw new BotError(403,'Evidence caller revoked');return grants[0]!;}
   if(!reg.serviceScopeReader||Date.parse(reg.serviceScopeReader.credentialExpiresAt)<=io.now()||Date.parse(reg.serviceScopeReader.credentialExpiresAt)>Date.parse(reg.expiresAt)||!reg.serviceScopeReader.operations.includes('scope.action.read')||!route.includes('/scope/actions/'))throw new BotError(403,'Dedicated exact-action scope reader required');return reg.serviceScopeReader;
  }
  const caller=current();let value:unknown;try{const credential=await io.secret(caller.credential);current();value=await io.get(r.sourceOrigin+route,credential,AbortSignal.timeout(10000));}catch{throw new BotError(503,'Authenticated composed evidence unavailable');}current();
  const assertFresh=()=>{current();if(io.now()<start||io.now()-start>=5000)throw new BotError(409,'Evidence observation expired');};assertFresh();return {value,caller,assertFresh,reg,digest};
 }
 const scope:ComposeScopeReader=async(r,a,root,actor)=>{uuid.parse(root);const route=actor?`/api/cs/composed-sms/scope/${a.canonicalCaseId}/${a.contactCaseId}/${root}`:`/api/cs/composed-sms/scope/actions/${a.nativeActionId}/${root}`;
  const read=await fetch(r,a.ownerConversationId,a.executorConversationId,actor,route);let raw=read.value;if(!actor){const service=serviceScopeEnvelopeSchema.parse(raw);if(service.servicePrincipalId!==read.caller.principalId||service.registrationId!==r.registrationId||service.sourceRegistrationHash!==r.sourceRegistrationHash||service.nativeActionId!==a.nativeActionId||service.authorityId!==a.authorityId||service.authorityRevision!==a.authorityRevision||service.authorityHash!==a.authorityHash)throw new BotError(403,'Service scope action binding differs');raw=service.closure;}const p=verifyComposeClosure(raw,r,[a.canonicalCaseId,a.contactCaseId,root],actor?read.caller.principalId:a.executorPrincipalId,io.now(),true);return {...p,assertFresh:()=>{read.assertFresh();verifyComposeClosure(raw,r,[a.canonicalCaseId,a.contactCaseId,root],actor?read.caller.principalId:a.executorPrincipalId,io.now(),true);}};};
 return {scope,async sender(actor:Actor,owner:string,executor:string,canonical:string,contact:string,payloadAccount:string){
  uuid.parse(canonical);uuid.parse(contact);const candidates=io.registry().registrations.filter(x=>x.ownerConversationId===owner&&x.executorConversationId===executor&&x.payloadAccount===payloadAccount);if(candidates.length!==1)throw new BotError(503,'Exact sender evidence custody required');const r=io.registration(candidates[0]!.registrationId);
  const read=await fetch(r,owner,executor,actor,`/api/cs/composed-sms/evidence/${canonical}/${contact}`);const w=senderEnvelopeSchema.parse(read.value),expected={principalId:read.caller.principalId,fullOrderOpsAccess:true,accountId:r.sourceAccountId,nativeBusinessId:r.businessId,sourceOrigin:r.sourceOrigin,runtime:r.runtime};
  if(canonicalSha256(w.identity)!==canonicalSha256(expected)||w.canonicalCaseId!==canonical||w.contactCaseId!==contact||!w.sender)throw new BotError(409,'Sender evidence missing or identity differs');
  const sender=verifyComposeSender(w.sender,r,io.now());return {registration:r,sender,custodyHash:read.digest,assertFresh:()=>{read.assertFresh();verifyComposeSender(w.sender,r,io.now());}};
 }};
}
