import type Database from 'better-sqlite3';
import {z} from 'zod';
import {canonicalSha256} from './canonical.js';
import {createBotService,BotError,type Actor,type Decision} from './service.js';
import type {UserRow} from '../db/db.js';
const id=z.string().min(1).max(200);
export const correctionPreflightInput=z.object({decision_id:id,expected_version:z.number().int().positive(),original_source_id:id,correction_source_kind:z.enum(['direct_message','result_reply']),correction_source_id:id}).strict();
const citation=z.object({kind:z.enum(['direct_message','result_reply','decision_discussion']),id,text:z.string().min(1).max(120000)}).strict();
export const correctionPreflightReview=correctionPreflightInput.extend({inspection_hash:z.string().regex(/^[a-f0-9]{64}$/),reviewed_full_context:z.literal(true),correction:citation,
 interpretation:z.enum(['compose_and_send_direction','wording_edit_only','status_only','quoted_or_reported','conditional','ambiguous']),explanation:z.string().trim().min(20).max(3000),
 later_context:z.array(z.object({citation,classification:z.enum(['status_only','substantive_supersession','ambiguous']),explanation:z.string().trim().min(10).max(2000)}).strict()).max(1500),
}).strict();
type Message={id:string;actor_id:number;actor_conversation_id?:string|null;text:string;created_at:string;thread_id?:string;source_text?:string;anchor?:string};
const stamp=(s:string)=>Date.parse(/^\d{4}-\d\d-\d\d /.test(s)?s.replace(' ','T')+'Z':s);
/** Read-only native context. No reader/credential/network capability is injected.
 * A review is returned, not persisted or accepted by any authority API. */
export function correctionPreflight(db:Database.Database){
 const bots=createBotService(db);
 function snapshot(a:Actor,raw:unknown){
  const p=correctionPreflightInput.parse(raw),d=db.prepare('SELECT * FROM bot_decisions WHERE id=?').get(p.decision_id) as Decision|undefined;
  if(!d||!a.conversationId||d.conversation_id!==a.conversationId)throw new BotError(403,'Original decision-owning bot required');
  const owner=bots.chat(a,a.conversationId);
  if(owner.archived||owner.user_id!==a.user.id||!db.prepare('SELECT 1 FROM bot_registrations WHERE conversation_id=? AND active=1').get(owner.id)||!db.prepare("SELECT 1 FROM users WHERE id=? AND status='active'").get(a.user.id))throw new BotError(403,'Original owner access revoked');
  if(d.version!==p.expected_version)throw new BotError(409,'Current decision version changed');
  function bounded<T>(rows:T[]){if(rows.length>500)throw new BotError(409,'Complete native context exceeds 500 rows per surface; no excerpt review');return rows;}
  const direct=bounded(db.prepare('SELECT id,actor_id,text,proposals_json,created_at FROM bot_human_messages WHERE conversation_id=? ORDER BY rowid LIMIT 501').all(owner.id)) as Array<Message&{proposals_json:string}>;
  const replies=bounded(db.prepare('SELECT r.id,r.actor_id,r.actor_conversation_id,r.text,r.created_at,t.id thread_id,t.source_text,t.anchor FROM bot_message_replies r JOIN bot_message_threads t ON t.id=r.thread_id WHERE t.conversation_id=? ORDER BY r.rowid LIMIT 501').all(owner.id)) as Message[];
  const discussion=bounded(db.prepare('SELECT id,actor_id,actor_conversation_id,text,created_at FROM bot_decision_threads WHERE decision_id=? ORDER BY rowid LIMIT 501').all(d.id)) as Message[];
  const events=bounded(db.prepare('SELECT id,version,kind,actor_id,actor_conversation_id,request_key,payload_json,created_at FROM bot_decision_events WHERE decision_id=? ORDER BY rowid LIMIT 501').all(d.id)) as Array<{id:string;version:number;kind:string;actor_id:number;actor_conversation_id:string|null;request_key:string;payload_json:string}>;
  const original=direct.find(x=>x.id===p.original_source_id);
  const consumption=db.prepare("SELECT * FROM bot_conversational_answers WHERE source_kind='direct_message' AND source_id=? AND decision_id=?").get(p.original_source_id,d.id) as {version:number;source_hash:string;action:string;event_key:string}|undefined;
  if(!original||!consumption)throw new BotError(409,'Exact original authenticated consumption lineage required');
  const originalHash=canonicalSha256({kind:'direct_message',source:{id:original.id,actor_id:original.actor_id,text:original.text,created_at:original.created_at},anchor:null});
  const captured=JSON.parse(original.proposals_json).find((x:{id:string})=>x.id===d.id);
  const answer=events.find(x=>x.kind==='answered'&&x.request_key===consumption.event_key);
  const proposalEvent=events.filter(x=>x.version===consumption.version&&['raised','revised'].includes(x.kind)).at(-1);
  const old=proposalEvent&&JSON.parse(proposalEvent.payload_json),originalProposal=old?.proposal??old;
  if(consumption.source_hash!==originalHash||captured?.version!==consumption.version||!answer||answer.version!==consumption.version||answer.actor_id!==original.actor_id||answer.actor_conversation_id!==null||JSON.parse(answer.payload_json).action!==consumption.action||!originalProposal||canonicalSha256(originalProposal)!==captured.proposal_hash)throw new BotError(409,'Original lineage provenance mismatch');
  const currentProposal=JSON.parse(d.proposal_json);
  // Current evidence ACL applies also to historical snapshots returned for review.
  for(const proposal of [originalProposal,currentProposal,...events.filter(e=>['raised','revised'].includes(e.kind)).map(e=>{const p=JSON.parse(e.payload_json);return p.proposal??p;})])for(const e of [...(proposal.evidence??[]),...(proposal.images??[])])bots.chat(a,e.conversation_id);
  const tagged=[...direct.map(m=>({...m,kind:'direct_message' as const})),...replies.map(m=>({...m,kind:'result_reply' as const})),...discussion.map(m=>({...m,kind:'decision_discussion' as const}))];
  const correction=tagged.find(m=>m.kind===p.correction_source_kind&&m.id===p.correction_source_id&&!m.actor_conversation_id);
  if(!correction||correction.id===original.id||!Number.isFinite(stamp(correction.created_at))||stamp(correction.created_at)<=stamp(original.created_at))throw new BotError(409,'Genuine later authenticated human correction required; bot/quoted imports are not sources');
  const author=db.prepare("SELECT * FROM users WHERE id=? AND status='active'").get(correction.actor_id) as UserRow|undefined;
  if(!author||!bots.view({user:author},d).can_answer)throw new BotError(403,'Current correction author access revoked');
  const context={direct_messages:direct,result_replies:replies,decision_discussion:discussion,decision_events:events};
  if(Buffer.byteLength(JSON.stringify({context,originalProposal,currentProposal}))>120000)throw new BotError(409,'Complete native context exceeds 120000 bytes; no excerpt review');
  const later=tagged.filter(m=>!m.actor_conversation_id&&!(m.kind===correction.kind&&m.id===correction.id)&&stamp(m.created_at)>=stamp(correction.created_at));
  const authorState={id:author.id,status:author.status,role:author.role};
  const binding={schemaVersion:'native-correction-preflight/v1',input:p,owner_id:owner.id,owner_user_id:owner.user_id,business_id:owner.business_team_id,author:authorState,
   correction_hash:canonicalSha256(correction),context_hash:canonicalSha256(context),lineage_hash:canonicalSha256({original,consumption,answer,originalProposal}),
   decision:{id:d.id,version:d.version,handling_revision:d.handling_revision,proposal_hash:canonicalSha256(currentProposal),state:d.state,answer:d.answer_json}};
  return {schemaVersion:'native-correction-preflight/v1',execute:false,ready:false,authority:false,inspection_hash:canonicalSha256(binding),binding,correction,context,
   lineage:{original_source:original,consumption,answer_event:answer,original_proposal:originalProposal},current_proposal:currentProposal,later_human_context:later,
   coverage:{complete:true,native_text_only:true,omitted:['external source facts','attachment/media contents','provider/credential evidence']},
   instructions:'Original owner: read every native message and original result anchor. Classify the correction and every later human message semantically, never by keywords. A status question is not consent and need not supersede; substantive changes or ambiguity require an unresolved assessment. This preflight supplies no draft, scope expansion, approval, authority or dispatch eligibility. BUILD450 gates remain unchanged.'};
 }
 const inspect=(a:Actor,raw:unknown)=>db.transaction(()=>snapshot(a,raw))();
 return {inspect,review(a:Actor,raw:unknown){
  const r=correctionPreflightReview.parse(raw),{inspection_hash,reviewed_full_context,correction,interpretation,explanation,later_context,...p}=r;
  const current=inspect(a,p);
  if(current.inspection_hash!==inspection_hash)throw new BotError(409,'Native context, revision, proposal or access changed; inspect again');
  const matches=(c:z.infer<typeof citation>,m:Message&{kind:string})=>c.id===m.id&&c.kind===m.kind&&c.text===m.text;
  if(!matches(correction,current.correction))throw new BotError(409,'Exact complete correction citation required');
  const seen=new Set<string>();
  for(const item of later_context){const key=item.citation.kind+':'+item.citation.id;if(seen.has(key)||!current.later_human_context.some(m=>matches(item.citation,m)))throw new BotError(409,'Exact complete later-human citations required, without duplicates');seen.add(key);}
  if(seen.size!==current.later_human_context.length)throw new BotError(409,'Review every later human message; no omitted context');
  const superseded=later_context.some(x=>x.classification==='substantive_supersession'),ambiguous=later_context.some(x=>x.classification==='ambiguous')||['conditional','ambiguous'].includes(interpretation);
  const assessment=superseded?'substantively_superseded':ambiguous?'unresolved':interpretation==='compose_and_send_direction'?'direction_retained_for_semantic_review':'not_compose_and_send_direction';
  return {schemaVersion:'native-correction-preflight-review/v1',execute:false,ready:false,authority:false,recorded:false,assessment,
   inspection_hash,review_hash:canonicalSha256({owner_id:a.conversationId,user_id:a.user.id,review:r}),reviewer:{conversation_id:a.conversationId,user_id:a.user.id},review:r,
   instructions:'Read-only semantic assessment, not an approval, authority, source fact or dispatch eligibility. Later status-only context supplies no consent. No preflight hash is accepted by BUILD450 derive or transport. Reinspect after new context or revocation; no persisted review was created.'};
 }};
}
