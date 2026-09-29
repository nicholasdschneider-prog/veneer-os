import {composeEvidenceReader} from './composedSmsEvidenceReader.js';
import {composeHash} from './composedSmsContract.js';
import {composeMaterialHash} from './composedSmsContract.js';
import fs from 'node:fs';
import path from 'node:path';
import {z} from 'zod';
import type {AppContext} from '../context.js';
import {BotError} from './service.js';
import {canonicalSha256} from './canonical.js';
import {approvedCaseRegistrySchema,boundedResolverGet} from './approvedCaseResolver.js';
import {readSecretValue} from '../secrets/readSecret.js';
import type {CompositionReader,CompositionEvidence} from './composedSms.js';
const base=approvedCaseRegistrySchema.shape.registrations.element;
export const correspondenceRegistrySchema=z.object({schema_version:z.literal('compose-correspondence-registry/v1'),registrations:z.array(base.extend({
 provenance:base.shape.provenance.extend({authority:z.literal('compose-send-correspondence-custody')}),
})).max(30)}).strict();
type Registry=z.infer<typeof correspondenceRegistrySchema>;
const uuid=z.string().uuid(),text=z.string().nullable(),time=z.string().datetime({offset:true});
const identity=z.object({principalId:z.string(),fullOrderOpsAccess:z.literal(true),accountId:z.string(),nativeBusinessId:uuid,sourceOrigin:z.string(),runtime:z.object({projectId:uuid,environmentId:uuid,serviceId:uuid}).strict()}).strict();
const customer=z.object({id:uuid,name:text,email:text,phone:text,updatedAt:time.nullable()}).strict();
const record=z.object({id:uuid,ticketNumber:text,customerId:uuid,relatedOrderId:uuid.nullable(),status:text,updatedAt:time.nullable(),customer}).strict();
const message=z.object({id:uuid,conversationId:uuid,ticketId:uuid.nullable(),direction:text,channel:text,messageType:text,fromEmail:text,fromPhone:text,fromName:text,toEmail:text,toPhone:text,subject:text,body:z.string(),createdAt:time.nullable(),externalMessageId:text,actorType:text,actorId:text,agentId:text,aiGenerated:z.boolean().nullable()}).strict();
export const correspondenceSchema=z.object({schemaVersion:z.literal('approved-case-correspondence/v1'),identity,cases:z.tuple([record,record]),messages:z.array(message).max(500),complete:z.literal(true),
 counts:z.object({cases:z.literal(2),messages:z.number().int().nonnegative(),messagesByCase:z.array(z.object({conversationId:uuid,count:z.number().int().nonnegative()}).strict()).length(2)}).strict(),
 coverage:z.object({messageSet:z.literal('all_rows_for_exact_cases'),body:z.literal('verbatim'),omitted:z.tuple([z.literal('bodyHtml'),z.literal('transcription'),z.literal('attachments'),z.literal('recordingUrl'),z.literal('actorContext')]),attachmentContent:z.literal('not_included'),mediaContent:z.literal('not_included'),relationClassification:z.literal('not_performed')}).strict(),
 smsSender:z.object({accountId:z.null(),fromPhone:z.null(),active:z.null(),provenance:z.null(),revision:z.null(),missingProof:z.literal('SMS_SENDER_OWNERSHIP_UNVERIFIED')}).strict(),observedAt:time,expiresAt:time,snapshotHash:z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export function loadCorrespondenceRegistry(file:string|null|undefined):Registry{
 let fd:number|undefined;
 try{if(!file||!path.isAbsolute(file))throw Error();fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);const s=fs.fstatSync(fd);if(!s.isFile()||s.uid!==process.getuid?.()||(s.mode&0o777)!==0o600||s.size>128*1024)throw Error();const b=Buffer.alloc(128*1024+1),n=fs.readSync(fd,b,0,b.length,0);if(n>128*1024)throw Error();return correspondenceRegistrySchema.parse(JSON.parse(b.subarray(0,n).toString()));}
 catch{throw new BotError(409,'CORRESPONDENCE_CUSTODY_REQUIRED: separate valid protected registry and endpoint permission required');}finally{if(fd!==undefined)fs.closeSync(fd);}
}
export interface CorrespondenceIO{registry:()=>Registry;secret:(ref:{project:string;config:string;name:string})=>Promise<string>;get:typeof boundedResolverGet;now:()=>number}
export function composedSmsReader(ctx:Pick<AppContext,'db'|'config'|'projectDopplerCli'>,override?:CorrespondenceIO):CompositionReader{
 const io=override??{registry:()=>loadCorrespondenceRegistry(ctx.config.composeCorrespondenceRegistryFile),secret:async ref=>(await readSecretValue({db:ctx.db,projectDopplerCli:ctx.projectDopplerCli??null},ref)).value,get:boundedResolverGet,now:Date.now};
 return async(a,p,owner)=>{
  const draft=ctx.db.prepare('SELECT payload_json FROM bot_message_drafts WHERE id=? AND conversation_id=? AND version=?').get(p.draft_id,p.executor_conversation_id,p.expected_draft_version) as {payload_json:string}|undefined;
  if(!draft)throw new BotError(409,'Exact current executor draft required before source read');
  const payload=JSON.parse(draft.payload_json);if(payload.channel!=='sms')throw new BotError(409,'SMS scope required');
  const entries=io.registry().registrations.filter(r=>r.payload_accounts.includes(payload.account)&&r.callers.some(c=>c.conversation_id===a.conversationId));if(entries.length!==1)throw new BotError(409,'One dedicated correspondence custody registration required');
  const reg=entries[0]!,hash=canonicalSha256(reg),start=io.now();
  function current(){const rows=io.registry().registrations.filter(r=>r.id===reg.id);if(rows.length!==1||canonicalSha256(rows[0])!==hash||!reg.active||Date.parse(reg.expires_at)<=io.now())throw new BotError(409,'Correspondence custody changed or expired');
   const team=ctx.db.prepare("SELECT owner_id FROM business_teams WHERE id=?").get(reg.business_id) as {owner_id:number}|undefined;
   if(team?.owner_id!==reg.business_owner_user_id||!ctx.db.prepare("SELECT 1 FROM users WHERE id=? AND status='active'").get(team.owner_id))throw new BotError(403,'Business owner changed');
   for(const id of new Set([owner,p.executor_conversation_id])){const c=ctx.db.prepare('SELECT user_id,business_team_id,archived FROM conversations WHERE id=?').get(id) as {user_id:number;business_team_id:string;archived:number}|undefined;const bindings=reg.callers.filter(b=>b.conversation_id===id);if(!c||c.archived||c.business_team_id!==reg.business_id||bindings.length!==1||bindings[0]!.user_id!==c.user_id||!ctx.db.prepare('SELECT 1 FROM bot_registrations WHERE conversation_id=? AND active=1').get(id))throw new BotError(403,'Original participants or source binding changed');}
   const caller=reg.callers.find(c=>c.conversation_id===a.conversationId);if(!caller||caller.user_id!==a.user.id||![owner,p.executor_conversation_id].includes(a.conversationId!))throw new BotError(403,'Own authenticated caller required');return caller;
  }
  const caller=current();
  const expected={principalId:caller.principal_id,fullOrderOpsAccess:true as const,accountId:reg.account_id,nativeBusinessId:reg.business_id,sourceOrigin:reg.source_origin,runtime:reg.runtime};
  function verify(value:unknown){if(canonicalSha256(identity.parse(value))!==canonicalSha256(expected))throw new BotError(409,'Source principal, account, business or runtime mismatch');}
  let wire:z.infer<typeof correspondenceSchema>;
  try{const secret=await io.secret(caller.credential);current();const signal=AbortSignal.timeout(10_000);const cap=async()=>{const raw=await io.get(`${reg.source_origin}/api/cs/approved-case/capabilities`,secret,signal);verify(z.object({ok:z.literal(true),access:identity}).parse(raw).access);};await cap();wire=correspondenceSchema.parse(await io.get(`${reg.source_origin}/api/cs/approved-case/correspondence/${p.canonical_case}/${p.contact_case}`,secret,signal));await cap();}
  catch{throw new BotError(409,'Authenticated correspondence unavailable or incompatible; no source error or credential disclosed');}
  verify(wire.identity);const {observedAt,expiresAt,snapshotHash,...material}=wire;
  if(Buffer.byteLength(JSON.stringify(wire))>1024*1024||canonicalSha256(material)!==snapshotHash||p.canonical_case===p.contact_case||wire.cases[0].id!==p.canonical_case||wire.cases[1].id!==p.contact_case||wire.cases.some(c=>c.customerId!==c.customer.id)||wire.counts.messages!==wire.messages.length)throw new BotError(409,'Invalid complete correspondence snapshot');
  let prior='';const seen=new Set<string>();for(const m of wire.messages){const key=m.conversationId+':'+m.id;if(seen.has(m.id)||key<=prior||!wire.cases.some(c=>c.id===m.conversationId))throw new BotError(409,'Invalid message identity or ordering');seen.add(m.id);prior=key;}
  for(let i=0;i<2;i++){const c=wire.cases[i]!,count=wire.counts.messagesByCase[i]!;if(count.conversationId!==c.id||count.count!==wire.messages.filter(m=>m.conversationId===c.id).length)throw new BotError(409,'Incomplete case coverage');}
  const observed=Date.parse(observedAt),expires=Date.parse(expiresAt),received=io.now();
  const assertFresh=()=>{current();if(expires-observed!==15000||observed>io.now()+5000||io.now()>=expires||io.now()-start>15000||io.now()-received>5000||io.now()<received)throw new BotError(409,'Correspondence observation expired');};assertFresh();
  // Caller-specific authentication is checked above; material comparison across
  // original owner and executor excludes only their independently checked identity.
  const {identity:ignored,...facts}=material;
  const evidence:CompositionEvidence={dispatch_material_hash:composeMaterialHash(material),projection:{cases:wire.cases,messages:wire.messages},snapshot_hash:canonicalSha256(facts),registration_hash:hash,business_id:reg.business_id,account_id:reg.account_id,principal_id:caller.principal_id,sms_account:'',sender_phone:'',sender_verified:false,dispatch:{supported:false,contract:null,revision:'approved-case-correspondence/v1',reason:'Verified SMS sender and native action/executor/sender fenced transport are not supplied by this source contract'},assertFresh};
  if(ctx.config.composeEvidenceRegistryFile){
   const positive=await composeEvidenceReader(ctx).sender(a,owner,p.executor_conversation_id,p.canonical_case,p.contact_case,payload.account),r=positive.registration;
   const assertBoundary=()=>{assertFresh();positive.assertFresh();if(!r.guardManifest||r.guardManifest.nativeContextContract!=='compose-sms-current-context/v2'||!r.guardAcceptance||composeHash('compose-sms-guards/v1',r.guardManifest)!==r.guardContractHash||r.guardAcceptance.manifestHash!==r.guardContractHash||Date.parse(r.guardAcceptance.reviewedAt)>io.now()||Date.parse(r.guardAcceptance.expiresAt)<=io.now())throw new BotError(503,'DISPATCH_BOUNDARY_UNAVAILABLE: accountable source guard acceptance required');};assertBoundary();
   evidence.registration_hash=canonicalSha256({correspondence:hash,evidenceCustody:positive.custodyHash});evidence.sms_account=payload.account;evidence.sender_phone=positive.sender.fromPhone;evidence.sender_verified=true;
   evidence.dispatch={supported:true,contract:'native-compose-sms/v3',revision:r.guardContractHash,reason:'Verified sender; source and native execution guards still required'};
   evidence.boundary={registration:r,materialHash:evidence.dispatch_material_hash!,sender:positive.sender,guardContractHash:r.guardContractHash,assertFresh:assertBoundary};evidence.assertFresh=assertBoundary;
  }
  return evidence;
 };
}
