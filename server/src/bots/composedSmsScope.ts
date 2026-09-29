import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import {z} from 'zod';
import {composeHash,uuid,hash,time,verifyAuthority,type ComposeAuthority} from './composedSmsContract.js';
import {canonicalSha256} from './canonical.js';
import {composeCurrentContext,currentContextSchema,contextRecordSchema} from './composedSmsContext.js';
import {checkComposeRegistration,type ComposeRegistration} from './composedSmsTrust.js';
import {BotError,createBotService,type Actor} from './service.js';
const reviewedRecord=contextRecordSchema.extend({scopeStatus:z.enum(['unknown','current_action','completed','unrelated'])});
export const reviewedContextSchema=currentContextSchema.extend({schemaVersion:z.literal('compose-sms-current-context/v2'),holds:z.array(reviewedRecord).max(5000),obligations:z.array(reviewedRecord).max(5000)}).refine(c=>[...c.holds,...c.obligations].every(x=>(x.scopeStatus!=='unrelated'||x.scopeEvidenceId!==null)&&x.blocking===(x.scopeStatus==='unknown'))&&canonicalSha256(c.blockingIds)===canonicalSha256([...c.holds,...c.obligations].filter(x=>x.blocking).map(x=>x.kind+':'+x.id)),'Scope clearance requires evidence and consistent blockers');
type Context=z.infer<typeof currentContextSchema>;
// Internal authenticated-adapter result. Never accepted from a bot tool payload.
export interface ComposeScopeProof {rootId:string;scopeEvidenceId:string;materialHash:string;disjoint:boolean;facts:unknown;expiresAt:string;assertFresh:()=>void}
export type ComposeScopeReader=(r:ComposeRegistration,a:ComposeAuthority,root:string,actor:Actor|null)=>Promise<ComposeScopeProof>;
const item=z.object({kind:z.enum(['decision','instruction','composition','draft','delegation','routine']),id:z.string().min(1).max(200),revision:hash,rootId:uuid,scopeEvidenceId:uuid,classification:z.literal('unrelated'),explanation:z.string().min(1).max(2000)}).strict();
export const composeScopeReviewSchema=z.object({authority_id:uuid,inspection_hash:hash,request_key:z.string().min(1).max(200),reviewed_full_context:z.literal(true),classifications:z.array(item).min(1).max(500)}).strict();
export function composedSmsScope(db:Database.Database,registration:(id:string)=>ComposeRegistration,reader:ComposeScopeReader,nativeCurrent:(id:string)=>void,now=Date.now){
 function target(id:string,actor?:Actor){
  const d=db.prepare('SELECT * FROM bot_composed_sms_dispatch_authorities WHERE authority_id=?').get(id) as {registration_id:string;registration_hash:string;tuple_json:string;expires_at:string;sender_expires_at:string}|undefined;
  if(!d)throw new BotError(404,'Exact composed authority required');nativeCurrent(id);const a=verifyAuthority(JSON.parse(d.tuple_json)),r=registration(d.registration_id);
  if(checkComposeRegistration(db,r,now())!==d.registration_hash)throw new BotError(403,'Scope registration changed');
  if(actor){if(actor.conversationId!==a.ownerConversationId)throw new BotError(403,'Original composition owner only');const chat=createBotService(db).chat(actor,a.ownerConversationId);if(chat.archived||chat.user_id!==actor.user.id||!db.prepare('SELECT 1 FROM bot_registrations WHERE conversation_id=? AND active=1').get(chat.id))throw new BotError(403,'Scope owner access revoked');}
  if(db.prepare("SELECT 1 FROM bot_composed_sms_events WHERE authority_id=? AND kind='revoked'").get(id)||Math.min(Date.parse(d.expires_at),Date.parse(d.sender_expires_at))<=now())throw new BotError(409,'Authority expired or revoked');
  return {a,r,d,c:composeCurrentContext(db,r,a,now(),Math.min(Date.parse(d.expires_at),Date.parse(d.sender_expires_at)))};
 }
 function root(kind:string,id:string):string|null{
  // Only typed immutable case fields. Ordinary ticket strings, prose and deleted
  // rows have no authenticated canonical root and remain unknown.
  try{let value:unknown;
   if(kind==='decision'){const row=db.prepare('SELECT proposal_json FROM bot_decisions WHERE id=?').get(id) as {proposal_json:string}|undefined;value=row&&JSON.parse(row.proposal_json).message_delivery?.canonical_case;}
   if(kind==='delegation'){const row=db.prepare('SELECT scope_json FROM bot_message_delegations WHERE id=?').get(id) as {scope_json:string}|undefined;value=row&&JSON.parse(row.scope_json).canonical_case;}
   return uuid.safeParse(value).success?String(value):null;
  }catch{return null;}
 }
 async function inspect(actor:Actor,id:string){const t=target(id,actor),proofs=new Map<string,ComposeScopeProof>(),records=[];
  for(const row of [...t.c.holds,...t.c.obligations].filter(x=>x.blocking)){
   let reviewContext:unknown=null;try{const decisionId=row.kind==='decision'?row.id:row.kind==='delegation'?(db.prepare('SELECT decision_id FROM bot_message_delegations WHERE id=?').get(row.id) as {decision_id:string}|undefined)?.decision_id:null;if(decisionId){const bots=createBotService(db);reviewContext=bots.view(actor,bots.read(actor,decisionId));}}catch{/* Restricted context never becomes an unrelated classification. */}
   const rootId=reviewContext?root(row.kind,row.id):null;let proof:ComposeScopeProof|undefined;
   if(rootId){proof=proofs.get(rootId);if(!proof){proof=await reader(t.r,t.a,rootId,actor);proofs.set(rootId,proof);}proof.assertFresh();if(proof.rootId!==rootId)throw new BotError(409,'Source root differs');}
   records.push({...row,rootId,reviewContext,proof:proof?{scopeEvidenceId:proof.scopeEvidenceId,materialHash:proof.materialHash,disjoint:proof.disjoint,facts:proof.facts}:null});
  }
  const fresh=target(id,actor);if(fresh.c.contextRevision!==t.c.contextRevision)throw new BotError(409,'Native scope changed during inspection');
  const binding={authorityId:id,authorityHash:t.a.authorityHash,contextRevision:t.c.contextRevision,records};
  return {execute:false,inspection_hash:canonicalSha256({...binding,records:records.map(({proof,...row})=>({...row,proof:proof?{scopeEvidenceId:proof.scopeEvidenceId,materialHash:proof.materialHash,disjoint:proof.disjoint}:null}))}),binding,proofs};
 }
 return {
  async inspect(actor:Actor,id:string){const {proofs,...view}=await inspect(actor,id);return view;},
  async record(actor:Actor,raw:unknown){const p=composeScopeReviewSchema.parse(raw);target(p.authority_id,actor);const prior=db.prepare('SELECT id,request_hash FROM compose_scope_reviews WHERE authority_id=? AND request_key=?').get(p.authority_id,p.request_key) as {id:string;request_hash:string}|undefined;if(prior){if(prior.request_hash!==canonicalSha256(p))throw new BotError(409,'Conflicting scope retry');return {id:prior.id,execute:false};}const i=await inspect(actor,p.authority_id);
   if(i.inspection_hash!==p.inspection_hash)throw new BotError(409,'Scope inspection changed');
   const keys=new Set<string>();for(const x of p.classifications){const key=x.kind+':'+x.id;if(keys.has(key))throw new BotError(409,'Duplicate scope classification');keys.add(key);const row=i.binding.records.find(y=>y.kind===x.kind&&y.id===x.id);
    if(!row||row.revision!==x.revision||row.rootId!==x.rootId||!row.proof?.disjoint||row.proof.scopeEvidenceId!==x.scopeEvidenceId)throw new BotError(409,'Unknown or overlapping source scope cannot be excluded');}
   const requestHash=canonicalSha256(p);return db.transaction(()=>{
    const t=target(p.authority_id,actor);if(t.c.contextRevision!==i.binding.contextRevision)throw new BotError(409,'Scope changed before record');for(const proof of i.proofs.values())proof.assertFresh();
    const old=db.prepare('SELECT id,request_hash FROM compose_scope_reviews WHERE authority_id=? AND request_key=?').get(p.authority_id,p.request_key) as {id:string;request_hash:string}|undefined;
    if(old){if(old.request_hash!==requestHash)throw new BotError(409,'Conflicting scope retry');return {id:old.id,execute:false};}
    const id=crypto.randomUUID(),evidence=p.classifications.map(x=>({...x,materialHash:i.proofs.get(x.rootId)!.materialHash}));
    db.prepare('INSERT INTO compose_scope_reviews(id,authority_id,owner_id,request_key,request_hash,context_revision,evidence_json) VALUES(?,?,?,?,?,?,?)').run(id,p.authority_id,actor.conversationId,p.request_key,requestHash,t.c.contextRevision,JSON.stringify(evidence));return {id,execute:false};
   }).immediate();
  },
  revoke(actor:Actor,id:string,reason:string){if(!reason.trim()||reason.length>2000)throw new BotError(400,'Reason required');const row=db.prepare('SELECT authority_id,owner_id FROM compose_scope_reviews WHERE id=?').get(id) as {authority_id:string;owner_id:string}|undefined;if(!row)throw new BotError(404,'Review not found');target(row.authority_id,actor);const old=db.prepare('SELECT reason FROM compose_scope_revocations WHERE review_id=?').get(id) as {reason:string}|undefined;if(old&&old.reason!==reason)throw new BotError(409,'Conflicting scope revocation');db.prepare('INSERT OR IGNORE INTO compose_scope_revocations(review_id,reason) VALUES(?,?)').run(id,reason);return {execute:false,revoked:true};},
  async prepare(r:ComposeRegistration,a:ComposeAuthority,base:Context){
   const rows=db.prepare('SELECT * FROM compose_scope_reviews WHERE authority_id=? AND context_revision=? AND NOT EXISTS(SELECT 1 FROM compose_scope_revocations WHERE review_id=compose_scope_reviews.id) ORDER BY rowid').all(a.authorityId,base.contextRevision) as Array<{id:string;evidence_json:string}>;
   const accepted=new Map<string,{item:z.infer<typeof item>;proof:ComposeScopeProof;reviewId:string}>();
   for(const row of rows)for(const e of JSON.parse(row.evidence_json) as Array<z.infer<typeof item>&{materialHash:string}>){const proof=await reader(r,a,e.rootId,null);proof.assertFresh();if(proof.rootId!==e.rootId||proof.materialHash!==e.materialHash||proof.scopeEvidenceId!==e.scopeEvidenceId||!proof.disjoint)throw new BotError(409,'Scope source changed');accepted.set(e.kind+':'+e.id,{item:e,proof,reviewId:row.id});}
   return (fresh:Context)=>{
    if(fresh.contextRevision!==base.contextRevision)throw new BotError(409,'Native scope revision changed');const out=reviewedContextSchema.parse({...structuredClone(fresh),schemaVersion:'compose-sms-current-context/v2'});
    for(const row of [...out.holds,...out.obligations]){const x=accepted.get(row.kind+':'+row.id);if(!x)continue;x.proof.assertFresh();if(row.revision!==x.item.revision||db.prepare('SELECT 1 FROM compose_scope_revocations WHERE review_id=?').get(x.reviewId))throw new BotError(409,'Scope review revoked or changed');row.scopeEvidenceId=x.proof.scopeEvidenceId;row.scopeStatus='unrelated';row.blocking=false;}
    if(accepted.size){out.scopeEvidenceRevision=composeHash('compose-sms-scope-review/v1',{base:base.scopeEvidenceRevision,reviews:[...accepted].map(([key,x])=>({key,id:x.reviewId,materialHash:x.proof.materialHash}))});out.contextRevision=composeHash('compose-sms-reviewed-context/v1',{base:base.contextRevision,scope:out.scopeEvidenceRevision});out.expiresAt=new Date(Math.min(Date.parse(out.expiresAt),...[...accepted.values()].map(x=>Date.parse(x.proof.expiresAt)))).toISOString();out.blockingIds=[...out.holds,...out.obligations].filter(x=>x.blocking).map(x=>x.kind+':'+x.id);}
    return reviewedContextSchema.parse(out);
   };
  },
 };
}
