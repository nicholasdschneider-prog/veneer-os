import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { BotError, createBotService, type Actor, type Decision } from './service.js';
import { canonicalSha256 } from './canonical.js';
import { canSendToConversation } from '../conversations/access.js';
import type { UserRow } from '../db/db.js';

const id = z.string().min(1).max(200);
export const obligationInspectionSchema = z.object({
  source_id: id, draft_id: id, expected_draft_version: z.number().int().positive(),
  executor_conversation_id: id,
}).strict();
export const obligationRecordSchema = obligationInspectionSchema.extend({
  inspection_hash: z.string().regex(/^[a-f0-9]{64}$/), request_key: id,
  intent_summary: z.string().trim().min(1).max(600), reviewed_full_context: z.literal(true),
}).strict();
type Input = z.infer<typeof obligationInspectionSchema>;
type Draft = { id:string; conversation_id:string; version:number; payload_json:string; created_at:string;
  state:string; authorized_by:number|null; decision_id:string|null; decision_version:number|null;
  delegation_id:string|null; claim_key:string|null; receipt:string|null };
type Source = {id:string;conversation_id:string;actor_id:number;text:string;proposals_json:string;created_at:string};
type Consumption = {source_kind:string;source_id:string;decision_id:string;version:number;source_hash:string;inspection_hash:string;action:string;event_key:string};
type Stored = {id:string;owner_id:string;source_id:string;draft_id:string;request_key:string;request_hash:string;snapshot_json:string;created_at:string};
const timestamp = (value:string) => Date.parse(/^\d{4}-\d\d-\d\d \d/.test(value) ? value.replace(' ','T')+'Z' : value);
const missing = ['EXACT_LATER_PAYLOAD_AUTHORITY_MISSING', 'AUTHENTICATED_SOURCE_CASE_LINKAGE_MISSING'] as const;

/** Intent ledger only. No authorization, draft writes, wake, claim or dispatch path. */
export function createInstructionObligations(db: Database.Database) {
  const bots = createBotService(db);
  function owner(actor:Actor, source:Source) {
    if(actor.conversationId!==source.conversation_id) throw new BotError(403,'Only the original source-owning bot may review this obligation');
    const c=bots.chat(actor,source.conversation_id);
    if(c.archived || !db.prepare('SELECT 1 FROM bot_registrations WHERE conversation_id=? AND active=1').get(c.id)) throw new BotError(403,'Source owner is inactive');
    return c;
  }
  function sourceRow(sourceId:string) {
    const source=db.prepare('SELECT * FROM bot_human_messages WHERE id=?').get(sourceId) as Source|undefined;
    if(!source) throw new BotError(404,'Authenticated direct human source not found; no historical import');
    return source;
  }
  function bounded<T>(rows:T[]) { if(rows.length>500) throw new BotError(409,'Context exceeds 500 records; full review unavailable, no excerpt-based recording'); return rows; }
  function inspect(actor:Actor, raw:Input) {
    const input=obligationInspectionSchema.parse(raw), source=sourceRow(input.source_id), c=owner(actor,source);
    const human=db.prepare("SELECT * FROM users WHERE id=? AND status='active'").get(source.actor_id) as UserRow|undefined;
    if(!human || !canSendToConversation(human,c,db)) throw new BotError(403,'Human source author access is revoked');
    const consumed=db.prepare("SELECT * FROM bot_conversational_answers WHERE source_kind='direct_message' AND source_id=?").get(source.id) as Consumption|undefined;
    if(!consumed) throw new BotError(409,'An immutable existing source consumption is required; this path cannot answer a proposal');
    const decision=db.prepare('SELECT * FROM bot_decisions WHERE id=?').get(consumed.decision_id) as Decision|undefined;
    if(!decision || decision.conversation_id!==c.id) throw new BotError(409,'Source consumption owner mismatch');
    const captured=JSON.parse(source.proposals_json).find((p:{id:string})=>p.id===decision.id);
    const sourceHash=canonicalSha256({kind:'direct_message',source:{id:source.id,actor_id:source.actor_id,text:source.text,created_at:source.created_at},anchor:null});
    if(!captured || captured.version!==consumed.version || consumed.source_hash!==sourceHash) throw new BotError(409,'Source consumption provenance mismatch');
    const answerEvent=db.prepare("SELECT id,version,actor_id,actor_conversation_id,payload_json,created_at FROM bot_decision_events WHERE decision_id=? AND kind='answered' AND request_key=?").get(decision.id,consumed.event_key) as {id:string;version:number;actor_id:number;actor_conversation_id:string|null;payload_json:string;created_at:string}|undefined;
    if(!answerEvent || answerEvent.version!==consumed.version || answerEvent.actor_id!==source.actor_id || answerEvent.actor_conversation_id!==null || JSON.parse(answerEvent.payload_json).action!==consumed.action) throw new BotError(409,'Original human answer evidence mismatch');
    const originalEvent=db.prepare("SELECT id,payload_json FROM bot_decision_events WHERE decision_id=? AND version=? AND kind IN ('raised','revised') ORDER BY rowid DESC LIMIT 1").get(decision.id,consumed.version) as {id:string;payload_json:string}|undefined;
    const eventPayload=originalEvent && JSON.parse(originalEvent.payload_json);
    const originalProposal=eventPayload?.proposal ?? eventPayload;
    if(!originalEvent || canonicalSha256(originalProposal)!==captured.proposal_hash) throw new BotError(409,'Original immutable proposal evidence missing');
    // Apply current source-evidence visibility; this API never grants cross-chat access.
    for(const e of [...(originalProposal.evidence??[]),...(originalProposal.images??[])]) bots.chat(actor,e.conversation_id);
    const executor=bots.chat(actor,input.executor_conversation_id);
    if(executor.archived || executor.business_team_id!==c.business_team_id || executor.user_id!==c.user_id ||
      !db.prepare('SELECT 1 FROM bot_registrations WHERE conversation_id=? AND active=1').get(executor.id)) throw new BotError(403,'Executor is inactive or outside source owner scope');
    const draft=db.prepare('SELECT * FROM bot_message_drafts WHERE id=?').get(input.draft_id) as Draft|undefined;
    if(!draft || draft.conversation_id!==executor.id) throw new BotError(404,'Exact executor draft not found');
    if(draft.version!==input.expected_draft_version) throw new BotError(409,'Draft version changed; inspect the current exact draft');
    const payload=JSON.parse(draft.payload_json);
    if(payload.channel!=='sms') throw new BotError(409,'Only separate SMS intent inspection is supported');
    const direct=bounded(db.prepare('SELECT id,actor_id,text,proposals_json,created_at FROM bot_human_messages WHERE conversation_id=? ORDER BY rowid LIMIT 501').all(c.id));
    const replies=bounded(db.prepare(`SELECT r.id,r.actor_id,r.actor_conversation_id,r.text,r.created_at,t.id thread_id,t.source_text,t.anchor FROM bot_message_replies r JOIN bot_message_threads t ON t.id=r.thread_id WHERE t.conversation_id=? AND julianday(r.created_at)>=julianday(?) ORDER BY r.rowid LIMIT 501`).all(c.id,source.created_at));
    const discussion=bounded(db.prepare('SELECT id,actor_id,actor_conversation_id,text,created_at FROM bot_decision_threads WHERE decision_id=? ORDER BY rowid LIMIT 501').all(decision.id));
    const events=bounded(db.prepare('SELECT id,version,kind,payload_json,created_at FROM bot_decision_events WHERE decision_id=? ORDER BY rowid LIMIT 501').all(decision.id));
    const context={direct_messages:direct,result_replies_since_source:replies,decision_discussion:discussion,decision_events:events};
    if(Buffer.byteLength(JSON.stringify(context))>120000) throw new BotError(409,'Full context exceeds 120000 bytes; no excerpt-based recording');
    const later=(row:unknown)=>{const r=row as {id:string;actor_conversation_id?:string|null;created_at:string};return r.id!==source.id && !r.actor_conversation_id && timestamp(r.created_at)>=timestamp(source.created_at);};
    const blockers:string[]=[...missing];
    if([...direct,...replies,...discussion].some(later)) blockers.push('NEWER_HUMAN_CONTEXT_REQUIRES_REVIEW');
    if(decision.version!==consumed.version || canonicalSha256(JSON.parse(decision.proposal_json))!==captured.proposal_hash) blockers.push('CONSUMED_PROPOSAL_CHANGED');
    if(consumed.action!=='approve' || ['withdrawn','rejected'].includes(decision.state)) blockers.push('ORIGINAL_DIRECTION_NOT_ACTIVE_APPROVAL');
    if(draft.claim_key || draft.receipt || draft.state==='sending' || draft.state==='sent') blockers.push('EXISTING_EFFECT_OR_UNKNOWN_RECONCILE_ONLY');
    if(draft.authorized_by || draft.decision_id || draft.delegation_id || draft.state!=='draft') blockers.push('NOT_AN_UNBOUND_ORDINARY_DRAFT');
    const binding={source_id:source.id,source_hash:sourceHash,source_owner:c.id,business_id:c.business_team_id,user_id:c.user_id,
      consumption:consumed,answer_event:answerEvent,captured_proposal:captured,original_proposal_hash:canonicalSha256(originalProposal),
      current_decision:{version:decision.version,proposal_hash:canonicalSha256(JSON.parse(decision.proposal_json)),state:decision.state,answer:decision.answer_json,handling_revision:decision.handling_revision},
      draft_id:draft.id,draft_version:draft.version,executor_id:executor.id,payload_hash:canonicalSha256(payload),
      draft_state:draft.state,authorization_present:draft.authorized_by!==null,claim_present:draft.claim_key!==null,receipt_present:draft.receipt!==null,
      context_hash:canonicalSha256(context)};
    const stored=db.prepare('SELECT * FROM bot_instruction_obligations WHERE source_id=? AND draft_id=?').get(source.id,draft.id) as Stored|undefined;
    const revoked=stored ? db.prepare('SELECT reason,created_at FROM bot_instruction_obligation_revocations WHERE obligation_id=?').get(stored.id) : undefined;
    const snapshot=stored ? JSON.parse(stored.snapshot_json) : null;
    if(snapshot && snapshot.inspection_hash!==canonicalSha256(binding)) blockers.push('RECORDED_OBSERVATION_CHANGED');
    if(revoked) blockers.push('OBLIGATION_REVOKED');
    return {execute:false as const,ready:false as const,source,context,original_proposal:originalProposal,existing_consumption:consumed,
      draft:{id:draft.id,version:draft.version,created_at:draft.created_at,executor_id:executor.id,payload},
      derivation:{recorded_now_not_historical:true,post_instruction_draft:timestamp(draft.created_at)>timestamp(source.created_at)},
      binding,inspection_hash:canonicalSha256(binding),missing_proof:blockers,
      obligation:stored ? {id:stored.id,created_at:stored.created_at,snapshot,revocation:revoked??null} : null,
      instructions:'Read the entire source, captured proposal, current conversation and all returned context. Classify a separate outstanding direction semantically, never by keywords. Any recorded summary is the owning bot’s intent review, NOT human approval of this later draft. No source-case alias is verified here. No send, claim, delegation, authorization or duplicate customer approval is provided. Reconcile uncertain recording with this read-only inspection.'};
  }
  return {
    inspect,
    record(actor:Actor, raw:z.infer<typeof obligationRecordSchema>) {
      const p=obligationRecordSchema.parse(raw);
      return db.transaction(()=>{
        owner(actor,sourceRow(p.source_id));
        const requestHash=canonicalSha256(p);
        const prior=db.prepare('SELECT * FROM bot_instruction_obligations WHERE owner_id=? AND (request_key=? OR (source_id=? AND draft_id=?))').get(actor.conversationId,p.request_key,p.source_id,p.draft_id) as Stored|undefined;
        const {inspection_hash,request_key,intent_summary,reviewed_full_context,...input}=p;
        const current=inspect(actor,input);
        if(prior) {
          if(prior.request_hash!==requestHash) throw new BotError(409,'Conflicting obligation replay; inspect the existing record, never replace it');
          return current;
        }
        if(current.inspection_hash!==inspection_hash) throw new BotError(409,'Source, context or draft changed; inspect and review again');
        if(current.missing_proof.includes('NOT_AN_UNBOUND_ORDINARY_DRAFT') || current.missing_proof.includes('EXISTING_EFFECT_OR_UNKNOWN_RECONCILE_ONLY')) throw new BotError(409,'Draft has authority or possible effects; reconcile it without a new obligation');
        const snapshot={...current,intent_summary,reviewed_full_context,reviewer_conversation_id:actor.conversationId,reviewer_user_id:actor.user.id};
        db.prepare('INSERT INTO bot_instruction_obligations(id,owner_id,source_id,draft_id,request_key,request_hash,snapshot_json) VALUES(?,?,?,?,?,?,?)').run(crypto.randomUUID(),actor.conversationId,p.source_id,p.draft_id,request_key,requestHash,JSON.stringify(snapshot));
        return inspect(actor,input);
      }).immediate();
    },
    revoke(actor:Actor, obligationId:string, reason:string, requestKey:string) {
      const r=z.object({obligation_id:id,reason:z.string().trim().min(1).max(600),request_key:id}).strict().parse({obligation_id:obligationId,reason,request_key:requestKey});
      return db.transaction(()=>{
        const stored=db.prepare('SELECT * FROM bot_instruction_obligations WHERE id=?').get(r.obligation_id) as Stored|undefined;
        if(!stored) throw new BotError(404,'Obligation not found');
        owner(actor,sourceRow(stored.source_id));
        const prior=db.prepare('SELECT * FROM bot_instruction_obligation_revocations WHERE obligation_id=?').get(stored.id) as {reason:string;request_key:string}|undefined;
        if(prior && (prior.reason!==r.reason || prior.request_key!==r.request_key)) throw new BotError(409,'Conflicting revocation replay');
        if(!prior) db.prepare('INSERT INTO bot_instruction_obligation_revocations(obligation_id,actor_id,actor_conversation_id,reason,request_key) VALUES(?,?,?,?,?)').run(stored.id,actor.user.id,actor.conversationId,r.reason,r.request_key);
        return {obligation_id:stored.id,revoked:true,execute:false};
      }).immediate();
    },
  };
}
