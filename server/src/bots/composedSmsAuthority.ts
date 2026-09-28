import crypto from 'node:crypto';
import {z} from 'zod';
import type Database from 'better-sqlite3';
import {canonicalSha256,canonicalJson} from './canonical.js';
import {composeHash,verifyAuthority,wireSchema,type ComposeAuthority} from './composedSmsContract.js';
import {checkComposeRegistration,type ComposeRegistration} from './composedSmsTrust.js';
import {BotError} from './service.js';
/** Server-internal result of a separately accepted authenticated sender/guard
 * adapter. NOT a tool/request schema, not a supported:true assertion, and never
 * synthesized from correspondence v1. The production reader currently cannot
 * supply this result. Its assertFresh closure must recheck the accepted issuer,
 * current effective provider client, source guards and both custody boundaries. */
export interface ComposeBoundaryEvidence {
 registration:ComposeRegistration; materialHash:string;
 sender:{receiptId:string;revision:number;issuerId:string;providerAccountId:string;fromPhone:string;expiresAt:string};
 guardContractHash:string;
 assertFresh:()=>void;
}
/** Preserve the already authenticated direct-message hash namespace and provenance.
 * Never substitute a hash of plaintext or patch an existing immutable tuple. */
export function composeOriginalHashes(snapshot:unknown,sourceId:string,ownerId:string){
 const digest=z.string().regex(/^[a-f0-9]{64}$/);
 const shape=z.object({scope:z.object({payload:z.record(z.unknown())}),binding:z.object({payload_hash:digest}),native:z.object({
  binding:z.object({source_id:z.string(),source_owner:z.string(),source_hash:digest,payload_hash:digest}),
  source:z.object({id:z.string(),conversation_id:z.string(),actor_id:z.number().int().positive(),text:z.string(),created_at:z.string()}),
  existing_consumption:z.object({source_kind:z.literal('direct_message'),source_id:z.string(),source_hash:digest}),
 })});
 const parsed=shape.safeParse(snapshot);
 if(!parsed.success)throw new BotError(409,'Original payload/source hash proof missing');
 const s=parsed.data,n=s.native,source=n.source;
 const payloadHash=canonicalSha256(s.scope.payload),sourceInstructionHash=n.binding.source_hash;
 const originalHash=canonicalSha256({kind:'direct_message',source:{id:source.id,actor_id:source.actor_id,text:source.text,created_at:source.created_at},anchor:null});
 if(payloadHash!==s.binding.payload_hash||payloadHash!==n.binding.payload_hash||sourceInstructionHash!==n.existing_consumption.source_hash||sourceInstructionHash!==originalHash||source.id!==sourceId||n.binding.source_id!==sourceId||n.existing_consumption.source_id!==sourceId||source.conversation_id!==ownerId||n.binding.source_owner!==ownerId)throw new BotError(409,'Original payload/source hash provenance mismatch');
 return {payloadHash,sourceInstructionHash};
}
export function persistComposeDispatchAuthority(db:Database.Database,g:{id:string;owner_id:string;executor_id:string;source_id:string;snapshot_json:string;expires_at:string},e:ComposeBoundaryEvidence,now:number){
 e.assertFresh();const r=e.registration,rh=checkComposeRegistration(db,r,now),saved=JSON.parse(g.snapshot_json),scope=saved.scope,payload=scope.payload;
 const originalHashes=composeOriginalHashes(saved,g.source_id,g.owner_id);
 const executor=r.executorBindings.find(x=>x.conversationId===g.executor_id);
 if(!executor||saved.binding.business_id!==r.businessId||saved.binding.source_account!==r.sourceAccountId||e.sender.issuerId!==r.senderReceiptIssuerId||e.guardContractHash!==r.guardContractHash||e.sender.fromPhone!==saved.binding.sms_sender||Date.parse(e.sender.expiresAt)<=now)throw new BotError(409,'Accepted sender, source guard or executor boundary differs');
 const cases=saved.source_projection.cases as {id:string;ticketNumber:string|null}[];
 const wire=wireSchema.parse({senderAccountId:e.sender.providerAccountId,fromPhone:e.sender.fromPhone,toPhone:payload.recipients[0],wireBody:payload.body,media:[],normalizationPolicy:'sms-identity-utf8/v1'});
 if(payload.channel!=='sms'||payload.attachments.length||payload.recipients.length!==1)throw new BotError(409,'Exact plain SMS scope required');
 const nativeActionId=crypto.randomUUID();
 const tuple={...wire,...originalHashes,nativeActionId,authorityId:g.id,authorityRevision:1 as const,scopeHash:canonicalSha256(scope),materialHash:e.materialHash,materialHashVersion:'compose-correspondence-material/v1' as const,sourceInstructionId:g.source_id,businessId:r.businessId,sourceOrigin:r.sourceOrigin,runtime:r.runtime,ownerConversationId:g.owner_id,executorConversationId:g.executor_id,executorPrincipalId:executor.principalId,canonicalCaseId:scope.canonical_case,canonicalTicket:cases.find(x=>x.id===scope.canonical_case)?.ticketNumber,contactCaseId:scope.contact_case,contactTicket:payload.ticket,senderReceiptId:e.sender.receiptId,senderReceiptRevision:e.sender.revision,wirePayloadHash:composeHash('native-compose-sms/wire/v1',wire),idempotencyKey:`veneer-compose-sms:${nativeActionId}`};
 const authority:ComposeAuthority=verifyAuthority({...tuple,authorityHash:composeHash('native-compose-sms/authority/v1',tuple)});
 db.prepare('INSERT INTO bot_composed_sms_dispatch_authorities(authority_id,action_id,registration_id,registration_hash,tuple_json,sender_expires_at,expires_at) VALUES(?,?,?,?,?,?,?)').run(g.id,nativeActionId,r.registrationId,rh,canonicalJson(authority),e.sender.expiresAt,g.expires_at);
 return authority;
}
