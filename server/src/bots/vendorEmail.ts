import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import {z} from 'zod';
import {canonicalSha256, canonicalJson} from './canonical.js';
import {BotError,createBotService,type Actor} from './service.js';
import {canSendToConversation} from '../conversations/access.js';
import {refuseUnregisteredChat} from './unregisteredChat.js';
import type {UserRow} from '../db/db.js';

const id=z.string().min(1).max(500).refine(s=>s===s.trim()&&!/[\r\n\0]/.test(s));
const hash=z.string().regex(/^[a-f0-9]{64}$/);
const explanation=z.string().trim().min(20).max(3000);
const kind=z.enum(['direct_message','result_reply','decision_discussion','voice_dispatch']);
const citation=z.object({kind,id,text:z.string().min(1).max(120000)}).strict();
export const vendorEmailScope=z.object({
 executor_conversation_id:id,channel:z.literal('email'),account:z.string().email(),recipient:z.string().email(),
 thread_id:id.refine(s=>s===s.toLowerCase(),'Exact lowercase Gmail thread ID required'),in_reply_to:id.refine(s=>s===s.toLowerCase(),'Exact lowercase Gmail message ID required'),subject:id,body:z.string().min(1).max(12000),
 attachments:z.array(z.object({name:id,path:id,sha256:hash}).strict()).max(10),
}).strict();
export const vendorEmailInput=z.object({source_kind:z.enum(['direct_message','result_reply']),source_id:id,scope:vendorEmailScope}).strict();
export const vendorEmailReview=z.object({
 reviewed_full_context:z.literal(true),interpretation:z.literal('unconditional_compose_and_send'),instruction:citation,
 explanation,scope_explanation:explanation,
 later_context:z.array(z.object({citation,classification:z.enum(['unrelated','status_only','supersedes','ambiguous']),explanation}).strict()).max(2000),
 // Review every native draft and decision in the returned own-chat inventory. No keyword routing.
 records:z.array(z.object({kind:z.enum(['draft','decision']),id,classification:z.enum(['unrelated','same_reply_unapproved','blocking']),explanation}).strict()).max(1000),
 body_parts:z.array(z.object({start:z.number().int().nonnegative(),end:z.number().int().positive(),human_ids:z.array(id).min(1),evidence:explanation}).strict()).min(1).max(100),
 unresolved_choices:z.array(z.string()).length(0),
}).strict();
export const vendorEmailCheck=z.object({
 observed_at:z.string().datetime(),payload_hash:hash,
 account_thread_recipient_verified:z.literal(true),permissions_verified:z.literal(true),
 attachments_verified:z.literal(true),no_prior_or_uncertain_send:z.literal(true),exclusive_source_ownership:z.literal(true),
 evidence:explanation,
}).strict();
export const vendorEmailBind=vendorEmailInput.extend({inspection_hash:hash,review:vendorEmailReview,source_check:vendorEmailCheck,request_key:id,supersedes_id:id.optional()}).strict();
export const vendorEmailClaim=z.object({authority_id:id,claim_key:id,inspection_hash:hash,review:vendorEmailReview,source_check:vendorEmailCheck}).strict();
export const vendorEmailReceipt=z.object({authority_id:id,claim_key:id,request_key:id,state:z.enum(['sent','uncertain','failed']),evidence:explanation,
 proof:z.object({provider:z.literal('gmail'),provider_message_id:id,account:z.string().email(),recipient:z.string().email(),thread_id:id,in_reply_to:id,payload_hash:hash,idempotency_key:id,verified:z.literal(true)}).strict().optional(),
}).strict();
type Scope=z.infer<typeof vendorEmailScope>;
type Input=z.infer<typeof vendorEmailInput>;
type Message={id:string;kind:z.infer<typeof kind>;actor_id:number;actor_conversation_id?:string|null;text:string;created_at:string};
type Authority={id:string;conversation_id:string;executor_user_id:number;business_id:string;source_kind:Input['source_kind'];source_id:string;author_id:number;target_key:string;account:string;recipient:string;scope_json:string;payload_hash:string;source_hash:string;request_key:string;request_hash:string;review_json:string;supersedes_id:string|null};
type Target={target_key:string;authority_id:string;claim_key:string|null;state:string};
type DraftRecord={id:string;kind:'draft';payload_json:string;state:string;authorized_by:number|null;claim_key:string|null;delegation_id:string|null};
type DecisionRecord={id:string;kind:'decision';state:string;proposal_json:string};
const stamp=(s:string)=>Date.parse(/^\d{4}-\d\d-\d\d /.test(s)?s.replace(' ','T')+'Z':s);
const targetKey=(business:string,s:Scope)=>canonicalSha256({business,account:s.account.toLowerCase(),thread:s.thread_id});

/** Guarded native authority, not a transport. Only the original connected bot may use
 * a first execute:true response once. Source facts are accountable executor readback,
 * like approved-message delivery, not a server Gmail attestation. */
export function vendorEmailService(db:Database.Database,verifyAttachments?:(a:Actor,s:Scope)=>Promise<void>){
 const bots=createBotService(db);
 function user(n:number){const u=db.prepare("SELECT * FROM users WHERE id=? AND status='active'").get(n) as UserRow|undefined;if(!u)throw new BotError(403,'Participant access revoked');return u;}
 function owner(a:Actor){
  if(!a.conversationId)throw new BotError(403,'Original registered executor required');
  refuseUnregisteredChat(db,a.conversationId);
  const u=user(a.user.id),c=bots.chat({...a,user:u},a.conversationId);
  if(c.user_id!==u.id||c.archived||!c.business_team_id||!canSendToConversation(u,c,db)||!db.prepare('SELECT 1 FROM bot_registrations WHERE conversation_id=? AND active=1').get(c.id))throw new BotError(403,'Original executor ownership or access revoked');
  return c;
 }
 function bounded<T>(rows:T[],limit=500){if(rows.length>limit)throw new BotError(409,'Complete native context too large; no truncated authority review');return rows;}
 function nativeContext(a:Actor){
  const c=owner(a);
  const direct=bounded(db.prepare('SELECT id,actor_id,text,proposals_json,created_at FROM bot_human_messages WHERE conversation_id=? ORDER BY rowid LIMIT 501').all(c.id)).map(m=>({...m as Message,kind:'direct_message' as const}));
  const replies=bounded(db.prepare('SELECT r.id,r.actor_id,r.actor_conversation_id,r.text,r.created_at,t.id thread_id,t.source_text,t.anchor FROM bot_message_replies r JOIN bot_message_threads t ON t.id=r.thread_id WHERE t.conversation_id=? ORDER BY r.rowid LIMIT 501').all(c.id)).map(m=>({...m as Message,kind:'result_reply' as const}));
  const discussion=bounded(db.prepare('SELECT t.id,t.actor_id,t.actor_conversation_id,t.text,t.created_at,t.decision_id FROM bot_decision_threads t JOIN bot_decisions d ON d.id=t.decision_id WHERE d.conversation_id=? ORDER BY t.rowid LIMIT 501').all(c.id)).map(m=>({...m as Message,kind:'decision_discussion' as const}));
  const decisions=bounded(db.prepare('SELECT * FROM bot_decisions WHERE conversation_id=? ORDER BY rowid LIMIT 501').all(c.id)).map(d=>({...d as DecisionRecord,kind:'decision' as const}));
  // Current ACLs on attached evidence apply before returning any proposal context.
  for(const d of decisions){const p=JSON.parse(d.proposal_json);for(const e of [...(p.evidence??[]),...(p.images??[])])bots.chat(a,e.conversation_id);}
  const drafts=bounded(db.prepare('SELECT * FROM bot_message_drafts WHERE conversation_id=? ORDER BY rowid LIMIT 501').all(c.id)).map(d=>({...d as DraftRecord,kind:'draft' as const}));
  // Only text already shared into this bot's conversation. Caller-private voice
  // sessions/entries are never exposed or treated as source authority here.
  const voice=bounded(db.prepare('SELECT user_id actor_id,instruction_id,text,result_json,created_at FROM voice_dispatches WHERE conversation_id=? ORDER BY rowid LIMIT 501').all(c.id)).map(x=>{const m=x as {actor_id:number;instruction_id:string;text:string;created_at:string};return {...m,id:`${m.actor_id}:${m.instruction_id}`,kind:'voice_dispatch' as const};});
  const context={direct_messages:direct,result_replies:replies,decision_discussion:discussion,voice_dispatches:voice,decisions,drafts};
  if(Buffer.byteLength(JSON.stringify(context))>2000000)throw new BotError(409,'Complete native context exceeds 2 MB; no excerpt authority');
  return context;
 }
 function snapshot(a:Actor,p:Input){
  const c=owner(a);if(p.scope.executor_conversation_id!==c.id)throw new BotError(403,'No delegation or substitute executor');
  const context=nativeContext(a),all:Message[]=[...context.direct_messages,...context.result_replies,...context.decision_discussion,...context.voice_dispatches];
  const source=all.find(m=>m.kind===p.source_kind&&m.id===p.source_id&&!m.actor_conversation_id);
  if(!source||!Number.isFinite(stamp(source.created_at)))throw new BotError(409,'Exact authenticated human source in this original conversation required; handoffs, bot text and imported transcripts are not authority');
  const author=user(source.actor_id);if(!canSendToConversation(author,c,db))throw new BotError(403,'Human instruction author access revoked');
  if(db.prepare('SELECT 1 FROM bot_conversational_answers WHERE source_kind=? AND source_id=?').get(p.source_kind,p.source_id))throw new BotError(409,'Human source already consumed by an existing native decision; preserve its approval and named executor, do not derive a second vendor authority');
  const context_hash=canonicalSha256(context),source_hash=canonicalSha256(source),payload_hash=canonicalSha256(p.scope);
  const inspection_hash=canonicalSha256({schema:'native-vendor-email/v1',input:p,context_hash,source_hash,user_id:c.user_id,business:c.business_team_id,author:{id:author.id,role:author.role,status:author.status}});
  if(all.some(m=>!Number.isFinite(stamp(m.created_at))))throw new BotError(409,'Native chronology unavailable; no inferred ordering');
  const later_human_context=all.filter(m=>!m.actor_conversation_id&&!(m.id===source.id&&m.kind===source.kind)&&stamp(m.created_at)>=stamp(source.created_at));
  return {execute:false as const,authority:false as const,inspection_hash,payload_hash,source_hash,source,context,later_human_context,
   coverage:{complete:true,native_text_only:true,omitted:['external mailbox contents','human attachment/media contents']},
   instructions:'Read ALL native context and result anchors. Review actual source and media through your existing connection. Semantically classify explicit unconditional compose AND send; status, quotation, conditions and wording edits are not consent. Cite each later human message and every draft/decision. No keyword consent, guessed aliases, borrowed account or financial authority. This inspection does not execute or authorize a send.'};
 }
 function review(current:ReturnType<typeof snapshot>,r:z.infer<typeof vendorEmailReview>,s:Scope){
  const matches=(x:z.infer<typeof citation>,m:Message)=>x.kind===m.kind&&x.id===m.id&&x.text===m.text;
  if(!matches(r.instruction,current.source))throw new BotError(409,'Complete exact human instruction citation required');
  const seen=new Set<string>();
  for(const x of r.later_context){const k=x.citation.kind+':'+x.citation.id;if(seen.has(k)||!current.later_human_context.some(m=>matches(x.citation,m)))throw new BotError(409,'Exact later-human citations without duplicates required');seen.add(k);if(['supersedes','ambiguous'].includes(x.classification))throw new BotError(409,'Later correction, hold or ambiguity blocks this instruction');}
  if(seen.size!==current.later_human_context.length)throw new BotError(409,'Review every later human message');
  const records=[...current.context.drafts,...current.context.decisions],recordSeen=new Set<string>();
  for(const x of r.records){const k=x.kind+':'+x.id,found=records.find(m=>m.kind===x.kind&&m.id===x.id);if(!found||recordSeen.has(k))throw new BotError(409,'Exact complete draft/decision review required');recordSeen.add(k);
   if(x.classification==='blocking')throw new BotError(409,'Existing native record blocks this reply');
   if(x.classification==='same_reply_unapproved'&&(found.kind!=='draft'||found.state!=='draft'||found.authorized_by!==null||found.claim_key!==null||found.delegation_id!==null))throw new BotError(409,'Only untouched ordinary unapproved drafts may be superseded in scope; records remain unchanged');
  }
  if(recordSeen.size!==records.length)throw new BotError(409,'Review every draft and decision; do not dismiss holds by identifier guessing');
  let end=0;const humans=[...current.context.direct_messages,...current.context.result_replies,...current.context.decision_discussion].filter(m=>!m.actor_conversation_id);
  for(const p of r.body_parts){if(p.start!==end||p.end<=p.start||p.end>s.body.length||p.human_ids.some(id=>!humans.some(m=>m.id===id)))throw new BotError(409,'Contiguous full body support tied to authentic human context required');end=p.end;}
  if(end!==s.body.length)throw new BotError(409,'Review support for the entire composed body');
 }
 function check(raw:z.infer<typeof vendorEmailCheck>,payloadHash:string){const age=Date.now()-Date.parse(raw.observed_at);if(raw.payload_hash!==payloadHash||age< -5000||age>300000)throw new BotError(409,'Fresh exact source/permission/duplicate/attachment check required (five minutes)');}
 async function files(a:Actor,s:Scope){if(s.attachments.length){if(!verifyAttachments)throw new BotError(409,'Attachment verification unavailable');await verifyAttachments(a,s);}}
 function authority(a:Actor,id:string){const c=owner(a),g=db.prepare('SELECT * FROM bot_vendor_email_authorities WHERE id=?').get(id) as Authority|undefined;if(!g||g.conversation_id!==c.id||g.executor_user_id!==a.user.id||g.business_id!==c.business_team_id)throw new BotError(403,'Original authority executor required');return g;}
 function target(g:Authority){return db.prepare('SELECT * FROM bot_vendor_email_targets WHERE target_key=?').get(g.target_key) as Target;}
 function event(a:Actor,g:Authority,kind:string,key:string,payload:unknown){db.prepare('INSERT INTO bot_vendor_email_events(id,authority_id,actor_id,actor_conversation_id,kind,request_key,payload_json) VALUES(?,?,?,?,?,?,?)').run(crypto.randomUUID(),g.id,a.user.id,a.conversationId,kind,key,canonicalJson(payload));}
 function read(a:Actor,id:string){const g=authority(a,id);return {execute:false as const,authority:g,target:target(g),events:db.prepare('SELECT * FROM bot_vendor_email_events WHERE authority_id=? ORDER BY rowid').all(g.id),idempotency_key:`veneer-vendor-email:${g.target_key}`};}
 // All existing native channels keep their own gates; exact known overlaps fail closed.
 function duplicates(a:Actor,s:Scope){
  const c=owner(a);
  if(db.prepare('SELECT 1 FROM customer_email_overlap_locks WHERE business_id=? AND lower(account)=lower(?) AND lower(recipient)=lower(?)').get(c.business_team_id,s.account,s.recipient))throw new BotError(409,'Competing customer email authority or uncertain action fenced');
  const rows=db.prepare('SELECT d.payload_json,d.state,d.authorized_by,d.claim_key FROM bot_message_drafts d JOIN compose_context_memberships c ON c.conversation_id=d.conversation_id WHERE c.business_id=?').all(c.business_team_id) as Array<{payload_json:string;state:string;authorized_by:number|null;claim_key:string|null}>;
  for(const d of rows){const p=JSON.parse(d.payload_json);if(p.channel==='email'&&p.account.toLowerCase()===s.account.toLowerCase()&&p.recipients.some((r:string)=>r.toLowerCase()===s.recipient.toLowerCase())&&(d.claim_key||d.authorized_by||['queued','sending','sent','uncertain'].includes(d.state)))throw new BotError(409,'Existing authorized or attempted email to this recipient requires reconciliation; no parallel vendor send');}
 }
 return {
  context(a:Actor){const context=nativeContext(a);return {execute:false,authority:false,context,source_candidates:[...context.direct_messages,...context.result_replies].filter(m=>!m.actor_conversation_id),instructions:'Discover exact own-chat direct_message/result_reply IDs here. Read full context; discovery is not authority. Shared voice dispatches are correction/hold context, not direct-message source IDs. No caller-private voice transcript is exposed.'};},
  async inspect(a:Actor,raw:unknown){const p=vendorEmailInput.parse(raw);snapshot(a,p);await files(a,p.scope);return snapshot(a,p);},read,
  async bind(a:Actor,raw:unknown){const p=vendorEmailBind.parse(raw);owner(a);
   const prior=db.prepare('SELECT id,request_hash FROM bot_vendor_email_authorities WHERE conversation_id=? AND request_key=?').get(a.conversationId,p.request_key) as {id:string;request_hash:string}|undefined;
   if(prior){if(prior.request_hash!==canonicalSha256(p))throw new BotError(409,'Conflicting binding request key');return read(a,prior.id);}
   await files(a,p.scope);
   return db.transaction(()=>{
    const replay=db.prepare('SELECT id,request_hash FROM bot_vendor_email_authorities WHERE conversation_id=? AND request_key=?').get(a.conversationId,p.request_key) as {id:string;request_hash:string}|undefined;
    if(replay){if(replay.request_hash!==canonicalSha256(p))throw new BotError(409,'Conflicting binding request key');return read(a,replay.id);}
    const c=owner(a),input={source_kind:p.source_kind,source_id:p.source_id,scope:p.scope},now=snapshot(a,input);
    if(now.inspection_hash!==p.inspection_hash)throw new BotError(409,'Context or exact payload changed; inspect again');review(now,p.review,p.scope);check(p.source_check,now.payload_hash);duplicates(a,p.scope);
    const tk=targetKey(c.business_team_id!,p.scope),old=db.prepare('SELECT * FROM bot_vendor_email_targets WHERE target_key=?').get(tk) as Target|undefined;
    if(old){if(old.claim_key||old.state!=='bound')throw new BotError(409,'Thread already attempted or revoked; no replacement or retry');if(p.supersedes_id!==old.authority_id)throw new BotError(409,'Explicit current unclaimed authority supersedes_id required');const prev=authority(a,old.authority_id);if(prev.recipient!==p.scope.recipient.toLowerCase())throw new BotError(409,'Correction cannot broaden recipients');}
    else if(p.supersedes_id)throw new BotError(409,'No matching unclaimed authority to supersede');
    const consumed=db.prepare('SELECT target_key FROM bot_vendor_email_sources WHERE source_kind=? AND source_id=?').get(p.source_kind,p.source_id) as {target_key:string}|undefined;
    if(consumed&&consumed.target_key!==tk)throw new BotError(409,'Human source already bound to another email thread');
    const gid=crypto.randomUUID();
    db.prepare('INSERT INTO bot_vendor_email_authorities(id,conversation_id,executor_user_id,business_id,source_kind,source_id,author_id,target_key,account,recipient,scope_json,payload_hash,source_hash,request_key,request_hash,review_json,supersedes_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(gid,c.id,a.user.id,c.business_team_id,p.source_kind,p.source_id,now.source.actor_id,tk,p.scope.account.toLowerCase(),p.scope.recipient.toLowerCase(),canonicalJson(p.scope),now.payload_hash,now.source_hash,p.request_key,canonicalSha256(p),canonicalJson(p),p.supersedes_id??null);
    if(old){event(a,authority(a,old.authority_id),'superseded',p.request_key,{successor:gid});db.prepare('UPDATE bot_vendor_email_targets SET authority_id=? WHERE target_key=?').run(gid,tk);}else db.prepare('INSERT INTO bot_vendor_email_targets(target_key,authority_id) VALUES(?,?)').run(tk,gid);
    db.prepare('INSERT OR IGNORE INTO bot_vendor_email_sources(source_kind,source_id,target_key) VALUES(?,?,?)').run(p.source_kind,p.source_id,tk);
    return read(a,gid);
   }).immediate();
  },
  async claim(a:Actor,raw:unknown){const p=vendorEmailClaim.parse(raw),g=authority(a,p.authority_id),s=vendorEmailScope.parse(JSON.parse(g.scope_json));
   // Any lost claim response is permanently reconciliation-only, even with the same key.
   if(target(g).claim_key)return {...read(a,g.id),reason:'Already attempted; never resend'};
   await files(a,s);
   return db.transaction(()=>{const fresh=authority(a,g.id),t=target(fresh);if(t.claim_key)return {...read(a,g.id),reason:'Already attempted; never resend'};
    if(t.authority_id!==g.id||t.state!=='bound')throw new BotError(409,'Authority superseded or revoked');
    const now=snapshot(a,{source_kind:g.source_kind,source_id:g.source_id,scope:s});
    if(now.inspection_hash!==p.inspection_hash||now.source_hash!==g.source_hash||now.payload_hash!==g.payload_hash)throw new BotError(409,'Human context or scope changed; inspect and review again');
    review(now,p.review,s);check(p.source_check,g.payload_hash);duplicates(a,s);
    event(a,g,'claimed',p.claim_key,p);db.prepare("UPDATE bot_vendor_email_targets SET claim_key=?,state='claimed' WHERE target_key=?").run(p.claim_key,g.target_key);
    return {execute:true,authority_id:g.id,scope:s,payload_hash:g.payload_hash,claim_key:p.claim_key,idempotency_key:`veneer-vendor-email:${g.target_key}`,approval_source:`native-vendor-email:${g.id}:${g.source_kind}:${g.source_id}`,instructions:'Use this first response once through your existing authorized Gmail connection. Verify exact source and attachment bytes immediately before dispatch. No automatic retries; lost/unknown results require read-only reconciliation. No financial/order operation is authorized.'};
   }).immediate();
  },
  receipt(a:Actor,raw:unknown){const p=vendorEmailReceipt.parse(raw);return db.transaction(()=>{
   const g=authority(a,p.authority_id),t=target(g),s=vendorEmailScope.parse(JSON.parse(g.scope_json));
   if(t.authority_id!==g.id||!t.claim_key||t.claim_key!==p.claim_key)throw new BotError(409,'Original exact claimed attempt required');
   const prev=db.prepare('SELECT payload_json FROM bot_vendor_email_events WHERE authority_id=? AND kind=? AND request_key=?').get(g.id,p.state,p.request_key) as {payload_json:string}|undefined;
   if(prev){if(prev.payload_json!==canonicalJson(p))throw new BotError(409,'Conflicting receipt replay');return read(a,g.id);}
   if(!['claimed','uncertain'].includes(t.state))throw new BotError(409,'Terminal receipt cannot be replaced or retried');
   if(p.state==='sent'){const proof=p.proof;if(!proof||proof.account!==s.account||proof.recipient!==s.recipient||proof.thread_id!==s.thread_id||proof.in_reply_to!==s.in_reply_to||proof.payload_hash!==g.payload_hash||proof.idempotency_key!==`veneer-vendor-email:${g.target_key}`||['unknown','pending','none'].includes(proof.provider_message_id.toLowerCase()))throw new BotError(409,'Verified exact provider receipt required, not an approval or promise');}
   else if(p.proof)throw new BotError(409,'Delivery proof is only for verified provider acceptance');
   if(p.proof&&db.prepare("SELECT 1 FROM bot_vendor_email_events WHERE kind='sent' AND authority_id<>? AND lower(json_extract(payload_json,'$.proof.account'))=? AND json_extract(payload_json,'$.proof.provider_message_id')=?").get(g.id,p.proof.account.toLowerCase(),p.proof.provider_message_id))throw new BotError(409,'Provider receipt already belongs to another native email attempt');
   event(a,g,p.state,p.request_key,p);db.prepare('UPDATE bot_vendor_email_targets SET state=? WHERE target_key=?').run(p.state,g.target_key);return read(a,g.id);
  }).immediate();},
  revoke(a:Actor,raw:unknown){const p=z.object({authority_id:id,request_key:id,reason:explanation}).strict().parse(raw);return db.transaction(()=>{const g=authority(a,p.authority_id),t=target(g);const prior=db.prepare("SELECT payload_json FROM bot_vendor_email_events WHERE authority_id=? AND kind='revoked' AND request_key=?").get(g.id,p.request_key) as {payload_json:string}|undefined;if(prior){if(prior.payload_json!==canonicalJson(p))throw new BotError(409,'Conflicting revocation');return read(a,g.id);}if(t.authority_id!==g.id)throw new BotError(409,'Authority already superseded');event(a,g,'revoked',p.request_key,p);if(!t.claim_key)db.prepare("UPDATE bot_vendor_email_targets SET state='revoked' WHERE target_key=?").run(g.target_key);return read(a,g.id);}).immediate();},
 };
}

/** Prevent parallel ordinary/delegated sends from evading a vendor action fence.
 * Deliberately conservative across the same business, account and recipient. */
export function guardVendorEmailDraft(db:Database.Database,conversationId:string,payload:{channel:string;account:string;recipients:string[]}){
 if(payload.channel!=='email')return;
 const rows=db.prepare('SELECT g.recipient FROM bot_vendor_email_authorities g JOIN conversations c ON c.business_team_id=g.business_id WHERE c.id=? AND g.account=?').all(conversationId,payload.account.toLowerCase()) as {recipient:string}[];
 if(rows.some(r=>payload.recipients.some(x=>x.toLowerCase()===r.recipient)))throw new BotError(409,'Vendor reply authority exists for this account/recipient; use its exact original executor and reconcile its one attempt');
}
