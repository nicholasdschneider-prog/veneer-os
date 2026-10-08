import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { BotError, createBotService, type Actor, type Decision } from './service.js';
import { canonicalSha256 } from './canonical.js';
import type { UserRow } from '../db/db.js';

const id = z.string().trim().min(1).max(200);
const text = z.string().trim().min(1).max(12000);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const customDirectionInput = z.object({
  decision_id: id, expected_version: z.number().int().positive(), answer_event_id: id,
  executor_conversation_id: id,
}).strict();
const citation = z.object({kind:z.enum(['direct_message','result_reply','decision_discussion','voice_dispatch','decision_event']),id,text:z.string().min(1).max(120000)}).strict();
export const customDirectionScope = z.object({
  kind:z.literal('purchasing_unit_cost_correction'), source_account:id, source_message_id:id,
  source_document_sha256:hash, confirmation_number:id, order_number:id,
  supplier_id:id, autopo_id:id, autopo_line_id:id, inventory_item_id:id, sku:id,
  quantity:z.number().int().positive().safe(), currency:z.literal('USD'),
  previous_unit_cents:z.number().int().nonnegative().safe(), unit_cents:z.number().int().nonnegative().safe(),
  total_cents:z.number().int().nonnegative().safe(), unchanged_retail_cents:z.number().int().nonnegative().safe(),
}).strict().refine(s=>Number.isSafeInteger(s.quantity*s.unit_cents)&&s.total_cents===s.quantity*s.unit_cents,'Exact quantity × unit price total required');
export const customDirectionReview = customDirectionInput.extend({
  inspection_hash:hash, request_key:id, reviewed_full_context:z.literal(true), answer_text:text,
  interpretation:z.enum(['unconditional_direction','identity_only','status_only','conditional','quoted_or_reported','ambiguous']),
  explanation:z.string().trim().min(20).max(3000), scope:customDirectionScope,
  scope_review:z.array(z.object({field:id,assessment:z.enum(['supported','unsupported','ambiguous']),citations:z.array(citation).min(1).max(20),explanation:text}).strict()).max(50).default([]),
  operations:z.array(z.enum(['autopo','shopify'])).min(1).max(2).refine(v=>new Set(v).size===v.length,'Unique operations required').default(['autopo','shopify']),
  later_context:z.array(z.object({citation,classification:z.enum(['status_only','substantive_supersession','ambiguous']),explanation:text}).strict()).max(2500),
  observation:z.object({observed_at:z.string().datetime(),source_identity:text,existing_business_authority:text,ownership_and_duplicates:text,evidence:text}).strict(),
}).strict();
export const customDirectionRead = z.object({decision_id:id}).strict();
export const customDirectionFence = customDirectionRead.extend({request_key:id,state:z.enum(['inflight','unknown']),evidence:text}).strict();
type Message = {kind:string;id:string;text:string;actor_id:number;actor_conversation_id?:string|null;created_at:string};
type Event = {id:string;kind:string;version:number;actor_id:number;actor_conversation_id:string|null;payload_json:string;created_at:string};
type Stored = {id:string;decision_id:string;owner_id:string;request_key:string;request_hash:string;snapshot_json:string};
const stamp=(s:string)=>Date.parse(/^\d{4}-\d\d-\d\d /.test(s)?s.replace(' ','T')+'Z':s);
const limits = {execute:false,ready:false,authority:false,dispatchEntitlement:false} as const;
// This tracker supplies no authority, but ordinary existing source permissions need no new verifier enrollment.
export const customDirectionRenew = customDirectionReview.extend({expected_review_hash:hash}).strict();
const checks=z.object({material_unchanged:z.literal(true),source_identity_checked:z.literal(true),existing_authority_checked:z.literal(true),ownership_and_duplicates_checked:z.literal(true),tool_permissions_checked:z.literal(true),observed_at:z.string().datetime(),evidence:text}).strict();
export const customDirectionResult = customDirectionRead.extend({request_key:id,attempt_key:id,expected_review_hash:hash,
  state:z.enum(['running','blocked','unknown','verified_completed']),evidence:text,inspection_hash:hash.optional(),checks:checks.optional(),
  readbacks:z.array(z.object({system:z.enum(['autopo','shopify']),record_id:id,unit_cents:z.number().int().nonnegative().safe(),quantity:z.number().int().positive().safe().optional(),total_cents:z.number().int().nonnegative().safe().optional(),retail_cents:z.number().int().nonnegative().safe().optional(),protected_fields_unchanged:z.literal(true),observed_at:z.string().datetime(),receipt:text}).strict()).max(2).default([]),
}).strict();
type Progress={id:string;review_id:string;request_key:string;request_hash:string;state:string;attempt_key:string;payload_json:string};


/** Prospective review ledger only. Never updates decisions, authorizations, drafts or source systems. */
export function customDirections(db:Database.Database) {
  const bots=createBotService(db);
  function owner(a:Actor,decisionId:string) {
    const d=db.prepare('SELECT * FROM bot_decisions WHERE id=?').get(decisionId) as Decision|undefined;
    if(!d || !a.conversationId || a.conversationId!==d.conversation_id) throw new BotError(403,'Original decision-owning bot required');
    const user=db.prepare("SELECT * FROM users WHERE id=? AND status='active'").get(a.user.id) as UserRow|undefined;
    if(!user)throw new BotError(403,'Original owner access revoked');
    const c=bots.chat({...a,user},d.conversation_id);
    if(c.archived || c.user_id!==a.user.id || !db.prepare("SELECT 1 FROM users WHERE id=? AND status='active'").get(a.user.id) || !db.prepare('SELECT 1 FROM bot_registrations WHERE conversation_id=? AND active=1').get(c.id)) throw new BotError(403,'Original owner access revoked');
    return {d,c,user};
  }
  function stored(a:Actor,decisionId:string) {
    const {user}=owner(a,decisionId);
    const row=db.prepare('SELECT * FROM bot_custom_direction_reviews WHERE decision_id=?').get(decisionId) as Stored|undefined;
    if(row) {
      const snapshot=JSON.parse(row.snapshot_json),proposal=JSON.parse(snapshot.binding.decision.proposal_json);
      // Readback never restores access to an old cross-chat evidence reference.
      for(const ref of [...(proposal.evidence??[]),...(proposal.images??[]),...(proposal.evidence_items??[])]) {
        const chat=ref.conversation_id??ref.source?.conversation_id;
        if(chat)bots.chat({...a,user},chat);
      }
    }
    return row;
  }
  function latest(row:Stored) {
    const amendment=db.prepare('SELECT snapshot_json FROM bot_custom_direction_amendments WHERE review_id=? ORDER BY rowid DESC LIMIT 1').get(row.id) as {snapshot_json:string}|undefined;
    return JSON.parse(amendment?.snapshot_json??row.snapshot_json);
  }
  function response(row:Stored|undefined) {
    const fences=row ? db.prepare('SELECT state,evidence,created_at FROM bot_custom_direction_fences WHERE review_id=? ORDER BY rowid').all(row.id) : [];
    const snapshot=row&&latest(row);
    const progress=row ? db.prepare('SELECT state,attempt_key,payload_json FROM bot_custom_direction_progress WHERE review_id=? ORDER BY rowid DESC LIMIT 1').get(row.id) as {state:string;attempt_key:string;payload_json:string}|undefined : undefined;
    return {...limits,tracking_only:true,missing_proof:fences.length ? ['EXISTING_INFLIGHT_OR_UNKNOWN_RECONCILE_ONLY'] : [],review:row ? {id:row.id,snapshot,review_hash:canonicalSha256(snapshot)} : null,fences,progress:progress?{...progress,payload:JSON.parse(progress.payload_json)}:null};
  }
  function collect(a:Actor,raw:unknown) {
    const p=customDirectionInput.parse(raw),{d,c,user}=owner(a,p.decision_id);
    a={...a,user};
    if(d.version!==p.expected_version || p.executor_conversation_id!==c.id) throw new BotError(409,'Exact current version and original executor required');
    if(d.stale_json || !['decided','blocked'].includes(d.state)) throw new BotError(409,'Current uncompleted custom direction required');
    const rows=<T>(sql:string,...args:unknown[])=>{const result=db.prepare(sql).all(...args) as T[];if(result.length>500)throw new BotError(409,'Complete context exceeds 500 rows per surface; no excerpt review');return result;};
    const events=rows<Event>('SELECT * FROM bot_decision_events WHERE decision_id=? ORDER BY rowid LIMIT 501',d.id);
    const answer=events.find(e=>e.id===p.answer_event_id && e.kind==='answered');
    const current=JSON.parse(d.answer_json||'{}'),payload=answer&&JSON.parse(answer.payload_json);
    if(!answer || answer.version!==d.version || answer.actor_conversation_id!==null || payload.action!=='custom' || payload.choice_id!=='custom' || current.action!=='custom' || current.actor_id!==answer.actor_id || canonicalSha256({...payload,actor_id:answer.actor_id})!==canonicalSha256(current) || events.filter(e=>e.kind==='answered').at(-1)?.id!==answer.id) throw new BotError(409,'Exact immutable human custom answer required');
    const proposalEvent=events.filter(e=>e.version===d.version&&['raised','revised'].includes(e.kind)).at(-1);
    const retained=proposalEvent&&JSON.parse(proposalEvent.payload_json);
    if(!proposalEvent||canonicalSha256(retained.proposal??retained)!==canonicalSha256(JSON.parse(d.proposal_json)))throw new BotError(409,'Original proposal binding changed');
    const human=db.prepare("SELECT * FROM users WHERE id=? AND status='active'").get(answer.actor_id) as UserRow|undefined;
    if(!human || !bots.view({user:human},d).can_answer) throw new BotError(403,'Human author access revoked');
    if(!db.prepare("SELECT 1 FROM conversation_wakeups WHERE id=? AND status='delivered'").get(answer.id)) throw new BotError(409,'Custom answer delivery incomplete');
    // Reuse native evidence ACLs without invoking read(), which has discussion side effects.
    bots.view(a,d); bots.thread(a,d.id);
    for(const e of events.filter(e=>['raised','revised'].includes(e.kind))) {
      const value=JSON.parse(e.payload_json),proposal=value.proposal??value;
      for(const ref of [...(proposal.evidence??[]),...(proposal.images??[]),...(proposal.evidence_items??[])]) {
        const chat=ref.conversation_id??ref.source?.conversation_id;if(chat)bots.chat(a,chat);
      }
    }
    const direct=rows<Message>("SELECT id,actor_id,text,created_at,'direct_message' kind FROM bot_human_messages WHERE conversation_id=? ORDER BY rowid LIMIT 501",c.id);
    const replies=rows<Message>("SELECT r.id,r.actor_id,r.actor_conversation_id,r.text,r.created_at,t.source_text,t.anchor,'result_reply' kind FROM bot_message_replies r JOIN bot_message_threads t ON t.id=r.thread_id WHERE t.conversation_id=? ORDER BY r.seq LIMIT 501",c.id);
    const discussion=rows<Message>("SELECT t.id,t.actor_id,t.actor_conversation_id,t.text,t.created_at,'decision_discussion' kind FROM bot_decision_threads t JOIN bot_decisions d ON d.id=t.decision_id WHERE d.conversation_id=? ORDER BY t.rowid LIMIT 501",c.id);
    // Only shared dispatch instructions, never caller-private voice_entries/audio.
    const voice=rows<Message>("SELECT user_id||':'||instruction_id id,user_id actor_id,text,created_at,'voice_dispatch' kind FROM voice_dispatches WHERE conversation_id=? ORDER BY rowid LIMIT 501",c.id);
    const humanEvents=rows<Event>('SELECT e.* FROM bot_decision_events e JOIN bot_decisions d ON d.id=e.decision_id WHERE d.conversation_id=? AND e.actor_conversation_id IS NULL ORDER BY e.rowid LIMIT 501',c.id).map(e=>({...e,kind:'decision_event',text:e.payload_json}));
    const messages=[...direct,...replies,...discussion,...voice,...humanEvents];
    if(messages.some(m=>!Number.isFinite(stamp(m.created_at))))throw new BotError(409,'Native chronology missing');
    const context={direct_messages:direct,result_replies:replies,decision_discussion:discussion,shared_voice_directions:voice,human_decision_events:humanEvents,decision_events:events};
    if(Buffer.byteLength(JSON.stringify(context))>240000)throw new BotError(409,'Complete context exceeds 240000 bytes; no excerpt review');
    const later=messages.filter(m=>!m.actor_conversation_id && m.id!==answer.id && stamp(m.created_at)+(/\.\d+/.test(m.created_at)?0:999)>=stamp(answer.created_at));
    const binding={schema_version:'native-custom-direction-review/v1',input:p,owner_id:c.id,user_id:c.user_id,owner_role:user.role,business_id:c.business_team_id,author:{id:human.id,role:human.role,status:human.status},decision:d,answer_event:answer,context_hash:canonicalSha256(context)};
    return {...limits,tracking_only:true,missing_proof:[],inspection_hash:canonicalSha256(binding),binding,answer_text:payload.answer,context,later_human_context:later,
      coverage:{complete_native_text:true,caller_private_voice:false,omitted:['external source facts','attachment/media bytes','authenticated source execution guards']},existing:response(stored(a,d.id))};
  }
  function reviewSnapshot(a:Actor,r:z.infer<typeof customDirectionReview>) {
      const now=collect(a,customDirectionInput.parse({decision_id:r.decision_id,expected_version:r.expected_version,answer_event_id:r.answer_event_id,executor_conversation_id:r.executor_conversation_id}));
      if(now.inspection_hash!==r.inspection_hash)throw new BotError(409,'Context, version or identity changed; inspect again');
      if(now.answer_text!==r.answer_text)throw new BotError(409,'Complete exact human answer citation required');
      const matches=(c:z.infer<typeof citation>,m:Message)=>c.kind===m.kind&&c.id===m.id&&c.text===m.text;
      const seen=new Set<string>();
      for(const item of r.later_context){const k=item.citation.kind+':'+item.citation.id;if(seen.has(k)||!now.later_human_context.some(m=>matches(item.citation,m)))throw new BotError(409,'Exact later-human citations required without duplicates');seen.add(k);}
      if(seen.size!==now.later_human_context.length)throw new BotError(409,'Classify every later human direction');
      const allMessages=[...now.context.direct_messages,...now.context.result_replies,...now.context.decision_discussion,...now.context.shared_voice_directions,...now.context.human_decision_events];
      const answerCitation:Message={kind:'decision_event',id:now.binding.answer_event.id,text:now.binding.answer_event.payload_json,actor_id:now.binding.answer_event.actor_id,created_at:now.binding.answer_event.created_at};
      const fields=Object.keys(r.scope),reviewed=new Set<string>();
      for(const part of r.scope_review){if(!fields.includes(part.field)||reviewed.has(part.field)||part.citations.some(c=>![answerCitation,...allMessages].some(m=>!m.actor_conversation_id&&matches(c,m))))throw new BotError(409,'Exact supported scope citations required');reviewed.add(part.field);}

      const observed=Date.parse(r.observation.observed_at);if(observed>Date.now()+1000||Date.now()-observed>300000)throw new BotError(409,'Fresh source observation required');
      const directionAssessment=r.later_context.some(x=>x.classification==='substantive_supersession')?'superseded':r.interpretation!=='unconditional_direction'||r.later_context.some(x=>x.classification==='ambiguous')?'unresolved':'direction_retained';
      const scopeAssessment=r.scope_review.some(x=>x.assessment==='ambiguous')?'unverified':'owner_source_observation';
      // Missing source linkage is not missing human consent. Keep the assessments separate.
      const assessment=directionAssessment==='direction_retained'&&scopeAssessment==='unverified'?'scope_unverified':directionAssessment;
      const snapshot={schema_version:'native-custom-direction-review/v2',binding:now.binding,review:r,assessment,direction_assessment:directionAssessment,scope_assessment:scopeAssessment,source_observation_authenticated:false,coverage:now.coverage,missing_proof:[]};
      return snapshot;
  }
  function fresh(value:string){const t=Date.parse(value);if(t>Date.now()+1000||Date.now()-t>300000)throw new BotError(409,'Fresh original-owner source checks required');}
  return {
    inspect(a:Actor,p:unknown){return db.transaction(()=>collect(a,p))();},
    read(a:Actor,raw:unknown){const p=customDirectionRead.parse(raw);return response(stored(a,p.decision_id));},
    record(a:Actor,raw:unknown){return db.transaction(()=>{
      const r=customDirectionReview.parse(raw),prior=stored(a,r.decision_id),requestHash=canonicalSha256(r);
      if(prior){if(prior.request_key!==r.request_key||prior.request_hash!==requestHash)throw new BotError(409,'Original answer already reviewed; no replacement; use audited renewal before any attempt');return response(prior);}
      const snapshot=reviewSnapshot(a,r);
      const reviewId=crypto.randomUUID();
      db.prepare('INSERT INTO bot_custom_direction_reviews(id,decision_id,owner_id,answer_event_id,request_key,request_hash,snapshot_json) VALUES(?,?,?,?,?,?,?)').run(reviewId,r.decision_id,a.conversationId,r.answer_event_id,r.request_key,requestHash,JSON.stringify(snapshot));
      return response(stored(a,r.decision_id));
    }).immediate();},
    renew(a:Actor,raw:unknown){return db.transaction(()=>{
      const r=customDirectionRenew.parse(raw),row=stored(a,r.decision_id);if(!row)throw new BotError(409,'Original review required');
      const requestHash=canonicalSha256(r),prior=db.prepare('SELECT request_hash FROM bot_custom_direction_amendments WHERE review_id=? AND request_key=?').get(row.id,r.request_key) as {request_hash:string}|undefined;
      if(prior){if(prior.request_hash!==requestHash)throw new BotError(409,'Conflicting renewal replay');return response(row);}
      if(db.prepare("SELECT 1 FROM bot_custom_direction_progress WHERE review_id=? AND state IN ('running','unknown','verified_completed')").get(row.id)||db.prepare('SELECT 1 FROM bot_custom_direction_fences WHERE review_id=?').get(row.id))throw new BotError(409,'Attempted or uncertain action cannot be renewed or rekeyed');
      const old=latest(row);if(canonicalSha256(old)!==r.expected_review_hash)throw new BotError(409,'Review changed; read original record');
      const p=old.review,operations=p.operations??['autopo','shopify'];
      if(canonicalSha256(p.scope)!==canonicalSha256(r.scope)||p.answer_event_id!==r.answer_event_id||p.executor_conversation_id!==r.executor_conversation_id||p.expected_version!==r.expected_version||r.operations.some(x=>!operations.includes(x)))throw new BotError(409,'Renewal may only narrow operations and refresh unchanged source observations');
      const snapshot=reviewSnapshot(a,r);
      db.prepare('INSERT INTO bot_custom_direction_amendments(id,review_id,request_key,request_hash,snapshot_json) VALUES(?,?,?,?,?)').run(crypto.randomUUID(),row.id,r.request_key,requestHash,JSON.stringify(snapshot));
      return response(row);
    }).immediate();},
    result(a:Actor,raw:unknown){return db.transaction(()=>{
      const p=customDirectionResult.parse(raw),row=stored(a,p.decision_id);if(!row)throw new BotError(409,'Original review required');
      const requestHash=canonicalSha256(p),prior=db.prepare('SELECT * FROM bot_custom_direction_progress WHERE review_id=? AND request_key=?').get(row.id,p.request_key) as Progress|undefined;
      if(prior){if(prior.request_hash!==requestHash)throw new BotError(409,'Conflicting result replay');return {...response(row),first_recording:false,reconcile_only:true};}
      const snapshot=latest(row);if(canonicalSha256(snapshot)!==p.expected_review_hash)throw new BotError(409,'Exact current review required');
      const running=db.prepare("SELECT * FROM bot_custom_direction_progress WHERE review_id=? AND state='running'").get(row.id) as Progress|undefined;
      const completed=db.prepare("SELECT 1 FROM bot_custom_direction_progress WHERE review_id=? AND state='verified_completed'").get(row.id);
      if(completed)throw new BotError(409,'Completed action cannot be restarted or replaced');
      if(p.state==='running') {
        if(running||db.prepare('SELECT 1 FROM bot_custom_direction_fences WHERE review_id=?').get(row.id))throw new BotError(409,'Existing attempt or UNKNOWN: reconcile original action, never replay');
        if(p.attempt_key!==p.request_key||!p.checks)throw new BotError(409,'One original attempt key and fresh existing source guards required');
        fresh(p.checks.observed_at);
        if(snapshot.direction_assessment!=='direction_retained'||snapshot.scope_assessment==='unverified')throw new BotError(409,'Unconditional unchanged action direction required');
        const current=collect(a,snapshot.binding.input);
        if(current.inspection_hash!==p.inspection_hash||current.inspection_hash!==snapshot.review.inspection_hash)throw new BotError(409,'Native context changed; renew semantic review before starting');
      } else {
        if((!running&&p.state!=='blocked')||(running&&running.attempt_key!==p.attempt_key))throw new BotError(409,'Exact original running attempt required');
        if(p.state==='verified_completed') {
          const scope=snapshot.review.scope,operations:string[]=snapshot.review.operations??['autopo','shopify'];
          if(p.readbacks.length!==operations.length||new Set(p.readbacks.map(r=>r.system)).size!==operations.length)throw new BotError(409,'Actual readbacks for every original operation required');
          for(const r of p.readbacks){fresh(r.observed_at);if(!operations.includes(r.system)||r.unit_cents!==scope.unit_cents||r.record_id!==(r.system==='autopo'?scope.autopo_line_id:scope.inventory_item_id)|| (r.system==='autopo'&&(r.quantity!==scope.quantity||r.total_cents!==scope.total_cents))||(r.system==='shopify'&&r.retail_cents!==scope.unchanged_retail_cents))throw new BotError(409,'Readback differs from original correction or protected fields');}
        }
      }
      db.prepare('INSERT INTO bot_custom_direction_progress(id,review_id,request_key,request_hash,state,attempt_key,payload_json) VALUES(?,?,?,?,?,?,?)').run(crypto.randomUUID(),row.id,p.request_key,requestHash,p.state,p.attempt_key,JSON.stringify(p));
      if(p.state==='unknown')db.prepare('INSERT INTO bot_custom_direction_fences(id,review_id,request_key,request_hash,state,evidence) VALUES(?,?,?,?,?,?)').run(crypto.randomUUID(),row.id,p.request_key,requestHash,'unknown',p.evidence);
      return {...response(row),first_recording:true,reconcile_only:p.state!=='running'};
    }).immediate();},
    fence(a:Actor,raw:unknown){return db.transaction(()=>{
      const p=customDirectionFence.parse(raw),row=stored(a,p.decision_id);if(!row)throw new BotError(409,'Original review required');
      const requestHash=canonicalSha256(p),prior=db.prepare('SELECT request_hash FROM bot_custom_direction_fences WHERE review_id=? AND request_key=?').get(row.id,p.request_key) as {request_hash:string}|undefined;
      if(prior){if(prior.request_hash!==requestHash)throw new BotError(409,'Conflicting fence replay');return response(row);}
      // Append-only evidence. Neither reconciliation nor another key removes a fence.
      db.prepare('INSERT INTO bot_custom_direction_fences(id,review_id,request_key,request_hash,state,evidence) VALUES(?,?,?,?,?,?)').run(crypto.randomUUID(),row.id,p.request_key,requestHash,p.state,p.evidence);
      return response(row);
    }).immediate();},
  };
}
