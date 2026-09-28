import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { readSecretValue } from '../secrets/readSecret.js';
import { BotError, type Actor } from './service.js';
import { canonicalSha256 } from './canonical.js';
import { messageDelegationService, MissingMessageProof, type CaseMappingCheck, type CaseMappingEvidence } from './messageDelegation.js';

const id=z.string().trim().min(1).max(200);
const uuid=z.string().uuid();
const segment=z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/);
export const approvedCaseRegistrySchema=z.object({schema_version:z.literal('approved-case-registry/v1'),registrations:z.array(z.object({
 id,active:z.boolean(),business_id:uuid,business_owner_user_id:z.number().int().positive(),account_id:id,
 // This integration is specifically the reviewed OrderOps deployment, not an SSRF proxy.
 source_origin:z.literal('https://orderops-dev-web-production.up.railway.app'),
 runtime:z.object({projectId:uuid,environmentId:uuid,serviceId:uuid}).strict(),
 payload_accounts:z.array(id).min(1).max(20),expires_at:z.string().datetime(),
 provenance:z.object({custodian_id:uuid,receipt:id,registered_at:z.string().datetime(),authority:z.literal('approved-message-resolver-custody')}).strict(),
 callers:z.array(z.object({conversation_id:uuid,user_id:z.number().int().positive(),principal_id:id,
 credential:z.object({project:segment,config:segment,name:z.string().regex(/^[A-Z][A-Z0-9_]{0,199}$/)}).strict()}).strict()).min(1).max(100),
}).strict()).max(30)}).strict();
type Registry=z.infer<typeof approvedCaseRegistrySchema>;
type Registration=Registry['registrations'][number];
export function loadApprovedCaseRegistry(file:string|null|undefined):Registry {
 if(!file)throw new MissingMessageProof(['approved-message resolver registration and own-principal credential custody are not configured']);
 let fd:number|undefined;
 try{
  if(!path.isAbsolute(file))throw new Error();
  fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  const stat=fs.fstatSync(fd);
  if(!stat.isFile()||(stat.mode&0o077)!==0||stat.uid!==process.getuid?.()||stat.size>128*1024)throw new Error();
  const bytes=Buffer.alloc(128*1024+1);const count=fs.readSync(fd,bytes,0,bytes.length,0);
  if(count>128*1024)throw new Error();
  return approvedCaseRegistrySchema.parse(JSON.parse(bytes.subarray(0,count).toString('utf8')));
 }catch{throw new MissingMessageProof(['approved-message resolver registry must be a valid owner-only regular configuration file']);}
 finally{if(fd!==undefined)fs.closeSync(fd);}
}
export interface ResolverIO {
 registry:()=>Registry;
 secret:(ref:{project:string;config:string;name:string})=>Promise<string>;
 get:(url:string,bearer:string,signal:AbortSignal)=>Promise<unknown>;
 now:()=>number;
}
export async function boundedResolverGet(url:string,bearer:string,signal:AbortSignal):Promise<unknown>{
 const response=await fetch(url,{method:'GET',headers:{Authorization:`Bearer ${bearer}`,Accept:'application/json'},redirect:'error',signal,cache:'no-store'});
 if(!response.ok||!response.body){await response.body?.cancel();throw new Error('Source unavailable');}
 const reader=response.body.getReader();let bytes=0;const chunks:Uint8Array[]=[];
 try{for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.length;if(bytes>1024*1024)throw new Error('Response exceeds bound');chunks.push(value);}return JSON.parse(Buffer.concat(chunks).toString('utf8'));}
 finally{await reader.cancel().catch(()=>{});}
}
const capability=z.object({ok:z.literal(true),access:z.object({principalId:id,fullOrderOpsAccess:z.literal(true),accountId:id,nativeBusinessId:uuid,sourceOrigin:z.string(),runtime:z.object({projectId:uuid,environmentId:uuid,serviceId:uuid})})});
const projection=z.object({id:uuid,ticketNumber:id,customerId:uuid,updatedAt:z.string().datetime({offset:true}),relatedOrderId:uuid.nullish(),orderBindingVersion:z.number().int().nonnegative().optional(),orderBindingExplicit:z.boolean().optional()});
export function approvedCaseResolver(ctx:Pick<AppContext,'db'|'config'|'projectDopplerCli'>, override?:ResolverIO){
 const io:ResolverIO=override??{
  registry:()=>loadApprovedCaseRegistry(ctx.config?.approvedCaseRegistryFile),
  secret:async ref=>(await readSecretValue({db:ctx.db,projectDopplerCli:ctx.projectDopplerCli??null},ref)).value,
  get:boundedResolverGet,now:Date.now,
 };
 function active(reg:Registration,a:Actor,owner:string,executor:string,account:string){
  if(!reg.active||Date.parse(reg.expires_at)<=io.now()||!reg.payload_accounts.includes(account))throw new MissingMessageProof(['source resolver registration expired, revoked or account differs']);
  const team=ctx.db.prepare('SELECT owner_id FROM business_teams WHERE id=?').get(reg.business_id) as {owner_id:number}|undefined;
  if(team?.owner_id!==reg.business_owner_user_id||!ctx.db.prepare("SELECT 1 FROM users WHERE id=? AND status='active'").get(team.owner_id))throw new MissingMessageProof(['resolver business owner authority changed']);
  for(const chat of new Set([owner,executor])){
   const c=ctx.db.prepare('SELECT user_id,business_team_id FROM conversations WHERE id=?').get(chat) as {user_id:number;business_team_id:string}|undefined;
   const bindings=reg.callers.filter(x=>x.conversation_id===chat);
   if(c?.business_team_id!==reg.business_id||bindings.length!==1||bindings[0]!.user_id!==c.user_id)throw new MissingMessageProof(['each original owner/executor needs verified same-business own-principal custody']);
  }
  const caller=reg.callers.find(x=>x.conversation_id===a.conversationId);
  if(!a.conversationId||![owner,executor].includes(a.conversationId)||!caller||caller.user_id!==a.user.id)throw new BotError(403,'Only the original owner or named executor may resolve this approved case');
  return caller;
 }
 return {async prepare(a:Actor,decisionId:string,version:number,receiptOnly=false):Promise<CaseMappingCheck|undefined>{
  let unequal=false;
  // All approval/ACL checks run before obtaining any source credential. The
  // capture callback supplies no authority and is used only by this read preflight.
  const target=messageDelegationService(ctx.db,()=>{unequal=true;return {} as CaseMappingEvidence;}).mappingTarget(a,decisionId,version,receiptOnly);
  if(!unequal)return undefined;
  if(!uuid.safeParse(target.scope.canonical_case).success)throw new MissingMessageProof(['canonical case must be an exact source UUID for authenticated resolution']);
  const entries=io.registry().registrations.filter(r=>r.payload_accounts.includes(target.scope.payload.account)&&r.callers.some(c=>c.conversation_id===a.conversationId));
  if(entries.length!==1)throw new MissingMessageProof(['one unambiguous approved-message source registration for this caller/account is required']);
  const reg=entries[0]!, caller=active(reg,a,target.d.conversation_id,target.scope.executor_conversation_id,target.scope.payload.account);
  const registrationHash=canonicalSha256(reg), proposalHash=target.proposal_hash, started=io.now();
  const checkRegistry=()=>{
   const current=io.registry().registrations.filter(r=>r.id===reg.id);
   if(current.length!==1||canonicalSha256(current[0])!==registrationHash)throw new MissingMessageProof(['source registration changed or was revoked during resolution']);
   active(current[0]!,a,target.d.conversation_id,target.scope.executor_conversation_id,target.scope.payload.account);
  };
  const verifyCapability=(value:unknown)=>{
   const cap=capability.safeParse(value);
   if(!cap.success||cap.data.access.principalId!==caller.principal_id||cap.data.access.accountId!==reg.account_id||cap.data.access.nativeBusinessId!==reg.business_id||cap.data.access.sourceOrigin!==reg.source_origin||canonicalSha256(cap.data.access.runtime)!==canonicalSha256(reg.runtime))throw new MissingMessageProof(['authenticated source capability must prove the registered own principal, account, business and runtime boundary']);
  };
  let source:z.infer<typeof projection>;
  try{
   const secret=await io.secret(caller.credential);checkRegistry();
   const signal=AbortSignal.timeout(10_000);
   verifyCapability(await io.get(`${reg.source_origin}/api/cs/approved-case/capabilities`,secret,signal));
   const raw=await io.get(`${reg.source_origin}/api/cs/approved-case/conversations/${encodeURIComponent(target.scope.canonical_case)}`,secret,signal);
   const parsed=projection.safeParse(raw);if(!parsed.success)throw new MissingMessageProof(['source case projection is missing exact identity/customer/revision fields']);source=parsed.data;
   verifyCapability(await io.get(`${reg.source_origin}/api/cs/approved-case/capabilities`,secret,signal));
  }catch(e){if(e instanceof MissingMessageProof)throw e;throw new MissingMessageProof(['authenticated source capability/case read unavailable; no source error body or credential is exposed']);}
  if(source.id!==target.scope.canonical_case||source.ticketNumber!==target.scope.payload.ticket)throw new MissingMessageProof(['authenticated canonical case and approved ticket do not identify the same source record']);
  checkRegistry();const observed=io.now();
  const identity={registration_hash:registrationHash,account_id:reg.account_id,business_id:reg.business_id,canonical_case:source.id,ticket:source.ticketNumber,customer_id:source.customerId,related_order_id:source.relatedOrderId??null,order_binding_version:source.orderBindingVersion??null,order_binding_explicit:source.orderBindingExplicit??null};
  const evidence:CaseMappingEvidence={schema_version:'approved-case-mapping/v1',fingerprint:canonicalSha256(identity),source_revision:source.updatedAt,observed_at:new Date(observed).toISOString(),registration_id:reg.id,registration_hash:registrationHash,source_origin:reg.source_origin,account_id:reg.account_id,business_id:reg.business_id,principal_id:caller.principal_id,caller_id:caller.conversation_id,canonical_case:source.id,ticket:source.ticketNumber,customer_id:source.customerId,related_order_id:identity.related_order_id,order_binding_version:identity.order_binding_version,order_binding_explicit:identity.order_binding_explicit,runtime:structuredClone(reg.runtime),provenance:structuredClone(reg.provenance)};
  return (actor,d,scope)=>{
   checkRegistry();if(io.now()-started>15_000||io.now()-observed>5_000||io.now()<observed||actor.user.id!==a.user.id||actor.conversationId!==a.conversationId||d.id!==decisionId||d.version!==version||canonicalSha256(JSON.parse(d.proposal_json))!==proposalHash||canonicalSha256(scope)!==target.payload_hash)throw new MissingMessageProof(['source mapping observation expired or exact caller/approval scope changed']);
   return evidence;
  };
 }};
}
