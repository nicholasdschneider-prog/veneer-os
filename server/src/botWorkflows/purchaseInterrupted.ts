import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { BotError } from '../bots/service.js';
import { canViewConversation } from '../conversations/access.js';
import type { ConversationRow, ScheduledTaskRow } from '../db/db.js';
import { claudeSessionFilePath } from '../providers/claude/transcript.js';
import { transcriptArchivePath } from '../runtime/transcriptArchive.js';
import { nextOccurrence, parseScheduleSpec } from '../scheduled/schedule.js';
import { purchaseBinding, purchaseTaskFenceSql } from './purchaseEvents.js';
import { purchaseDecisionHolds } from './purchaseHolds.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const evidence = z.string().trim().min(20).max(6000);
const order = z.object({order_id:z.string().uuid(),order_number:z.string().regex(/^\d{1,30}$/)}).strict();
export const interruptedReviewSchema = z.object({
 authorization_message_id:z.string().min(1).max(200), authorization_text:z.string().min(1).max(120000),
 reviewed_full_human_context:z.literal(true), recovery_only_no_replay:z.literal(true),
 later_context_assessment:evidence, observed_at:z.string().datetime(),
 source_reference:evidence, source_evidence:evidence, attempt_census_reference:evidence,
 attempt_census_complete:z.literal(true), unscoped_unknown_present:z.literal(false), source_purchase_fences_preserved:z.literal(true), potentially_attempted_orders:z.array(order).max(256),
 full_scan_exclusions_complete:z.literal(true), portal_owner_conversation_id:z.string().uuid(),
 portal_clearance_reference:evidence, portal_is_idle_and_released:z.literal(true),
}).strict();
export const interruptedInputSchema = z.object({run_id:z.string().uuid(),mode:z.enum(['inspect','review','resume']),
 expected_hash:hash.optional(),review_id:z.string().uuid().optional(),review:interruptedReviewSchema.optional()}).strict();
type Run = {id:string;scheduled_task_id:string;conversation_id:string;status:string;error:string;finished_at:string;
 batch_id:string;source_id:string;batch_status:string;blocked_reason:string};
const stamp=(value:string)=>Date.parse(/^\d{4}-\d\d-\d\d /.test(value)?value.replace(' ','T')+'Z':value);
const digest=(value:unknown)=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Original custodian's accountable source review, then owner/Platform Dev successor disposition.
 * Tool use is UNKNOWN, not startup failure. No source outcomes are invented by this ledger.
 */
export function recoverInterruptedPurchase(db:Database.Database,dataDir:string,actorId:number,
 actorConversationId:string|undefined,input:unknown,now=new Date()) {
 const p=interruptedInputSchema.parse(input);
 return db.transaction(()=>{
  const r=db.prepare(`SELECT r.*,b.id batch_id,b.source_id,b.status batch_status,b.blocked_reason
   FROM scheduled_task_runs r JOIN purchase_event_batches b ON b.run_id=r.id WHERE r.id=?`).get(p.run_id) as Run|undefined;
  if(!r)throw new BotError(404,'PURCHASE_RUN_NOT_FOUND');
  const binding=purchaseBinding(db,r.source_id);
  const user=db.prepare('SELECT role,status FROM users WHERE id=?').get(actorId) as {role:string;status:string}|undefined;
  const original=db.prepare('SELECT * FROM conversations WHERE id=?').get(r.conversation_id) as ConversationRow;
  const task=db.prepare('SELECT * FROM scheduled_tasks WHERE id=?').get(r.scheduled_task_id) as ScheduledTaskRow;
  const custodian=db.prepare(`SELECT c.* FROM purchase_task_decision_owners o JOIN conversations c ON c.id=o.conversation_id
   JOIN bot_registrations reg ON reg.conversation_id=c.id AND reg.active=1
   WHERE o.task_id=? AND o.source_id=? AND c.user_id=? AND c.assistant_id=? AND c.project_id IS ?`).get(task.id,r.source_id,actorId,task.assistant_id,task.project_id) as ConversationRow|undefined;
  if(!binding || binding.owner_id!==actorId || user?.role!=='owner' || user.status!=='active' || !custodian
   || !canViewConversation({id:actorId,botSession:!!actorConversationId},original,db)
   || !canViewConversation({id:actorId,botSession:!!actorConversationId},custodian,db))throw new BotError(403,'PURCHASE_RECOVERY_ACCESS');
  const caller=actorConversationId ? db.prepare(`SELECT c.*,a.slug FROM conversations c JOIN assistants a ON a.id=c.assistant_id WHERE c.id=?`).get(actorConversationId) as (ConversationRow & {slug:string})|undefined : undefined;
  if(actorConversationId && (!caller || caller.user_id!==actorId || !canViewConversation({id:actorId,botSession:true},caller,db)
   || (p.mode==='review' ? caller.id!==custodian.id : ![custodian.id].includes(caller.id) && caller.slug!=='platform-dev')
   || (p.mode==='resume' && caller.slug!=='platform-dev')))throw new BotError(403,'ORIGINAL_CUSTODIAN_OR_PLATFORM_DEV_REQUIRED');
  if(r.status!=='failed' || !r.finished_at || r.batch_status!=='blocked' || r.blocked_reason!=='UNKNOWN_RUNNER_RESTART'
   || r.error!=='Purchase runner interrupted; no automatic retry')throw new BotError(409,'EXACT_INTERRUPTED_RUN_REQUIRED');
  const start=db.prepare('SELECT * FROM purchase_worker_starts WHERE run_id=? AND conversation_id=?').get(r.id,r.conversation_id) as {turn_id:string}|undefined;
  const pass=db.prepare('SELECT * FROM purchase_worker_passes WHERE run_id=?').get(r.id);
  const pending=db.prepare('SELECT * FROM pending_turns WHERE conversation_id=?').get(r.conversation_id) as {status:string}|undefined;
  if(!start || pass || pending?.status==='pending' || db.prepare("SELECT 1 FROM scheduled_task_runs WHERE scheduled_task_id=? AND status IN ('queued','running','needs_you')").get(task.id))throw new BotError(409,'INTERRUPTED_NATIVE_STATE_NOT_QUIESCENT');
  const queued=db.prepare('SELECT * FROM queued_messages WHERE conversation_id=? ORDER BY id').all(r.conversation_id);
  // Retain and compare the entire owned native session. Tool names/counts are census
  // aids only: idle status or an apparently read-only tool cannot prove no effect.
  if(original.provider!=='claude' || !z.string().uuid().safeParse(original.native_session_id).success)throw new BotError(409,'COMPLETE_NATIVE_ARCHIVE_REQUIRED');
  let bytes:Buffer;let nativeRows:Record<string,any>[];
  try {
   const file=transcriptArchivePath(dataDir,'claude',original.native_session_id!);
   const stat=fs.lstatSync(file);if(!stat.isFile() || stat.size>16*1024*1024 || !stat.size)throw Error();
   bytes=fs.readFileSync(file);nativeRows=bytes.toString('utf8').trim().split('\n').map(line=>JSON.parse(line));
   if(nativeRows.some(row=>row.sessionId!==original.native_session_id || row.isSidechain))throw Error();
   const initial=nativeRows.find(row=>row.type==='user' && typeof row.cwd==='string');
   if(!initial || !path.isAbsolute(initial.cwd))throw Error();
   const native=claudeSessionFilePath(initial.cwd,original.native_session_id!);
   if(!fs.lstatSync(native).isFile() || !fs.readFileSync(native).equals(bytes))throw Error();
   const prompt=JSON.stringify(initial.message);
   if(!prompt.includes(task.id))throw Error();
  }catch {throw new BotError(409,'COMPLETE_CURRENT_NATIVE_ARCHIVE_REQUIRED');}
  const hints=db.prepare(`SELECT r.* FROM purchase_event_receipts r JOIN purchase_event_links l USING(source_id,event_id) WHERE l.batch_id=? ORDER BY r.event_id`).all(r.batch_id) as {payload_json:string}[];
  const human=db.prepare('SELECT * FROM bot_human_messages WHERE conversation_id=? ORDER BY rowid LIMIT 501').all(custodian.id) as {id:string;actor_id:number;text:string;created_at:string}[];
  const replies=db.prepare(`SELECT r.*,t.source_text,t.anchor FROM bot_message_replies r JOIN bot_message_threads t ON t.id=r.thread_id WHERE t.conversation_id=? ORDER BY r.seq LIMIT 501`).all(custodian.id);
  const discussion=db.prepare(`SELECT t.* FROM bot_decision_threads t JOIN bot_decisions d ON d.id=t.decision_id WHERE d.conversation_id=? ORDER BY t.rowid LIMIT 501`).all(custodian.id);
  const voice=db.prepare('SELECT user_id,instruction_id,text,created_at FROM voice_dispatches WHERE conversation_id=? ORDER BY rowid LIMIT 501').all(custodian.id);
  const humanEvents=db.prepare(`SELECT e.* FROM bot_decision_events e JOIN bot_decisions d ON d.id=e.decision_id WHERE d.conversation_id=? AND e.actor_conversation_id IS NULL ORDER BY e.rowid LIMIT 501`).all(custodian.id);
  if([human,replies,discussion,voice,humanEvents].some(rows=>rows.length>500))throw new BotError(409,'COMPLETE_HUMAN_CONTEXT_REQUIRED');
  const context={direct_messages:human,result_replies:replies,decision_discussion:discussion,shared_voice_directions:voice,human_decision_events:humanEvents};
  const holds=purchaseDecisionHolds(db,task.id);
  const snapshot={r,task,binding,custodian,start,pass,pending,queued,hints,context,holds,native_sha256:crypto.createHash('sha256').update(bytes!).digest('hex')};
  const evidenceHash=digest(snapshot);
  const old=db.prepare('SELECT * FROM purchase_interrupted_dispositions WHERE run_id=?').get(r.id) as {review_id:string;evidence_hash:string;next_run_at:string}|undefined;
  const reviewRow=p.review_id ? db.prepare('SELECT * FROM purchase_interrupted_reviews WHERE id=? AND run_id=?').get(p.review_id,r.id) as {id:string;evidence_hash:string;snapshot_json:string;recorded_at:string}|undefined : undefined;
  const response={run_id:r.id,batch_id:r.batch_id,conversation_id:r.conversation_id,turn_id:start.turn_id,custodian_id:custodian.id,
   evidence_hash:evidenceHash,human_context:context,decision_holds:holds,original_status:r.status,original_blocked_reason:r.blocked_reason,
   retained_queued_messages:queued.length,native_sha256:snapshot.native_sha256,
   tool_names:[...new Set(nativeRows!.flatMap(row=>(row.message?.content ?? []).filter((b:any)=>b.type==='tool_use').map((b:any)=>b.name)))],
   recovery_disposition:old ?? null,next_run_at:task.next_run_at,original_work_remains_unknown:true,purchase_authority:false,execute:false};
  if(p.mode==='inspect')return response;
  if(p.mode==='resume' && old){
   if(old.review_id!==p.review_id || old.evidence_hash!==p.expected_hash)throw new BotError(409,'RECOVERY_DISPOSITION_CONFLICT');
   return {...response,resumed:true,idempotent:true};
  }
  if(old)throw new BotError(409,'RECOVERY_ALREADY_RECORDED');
  if(p.expected_hash!==evidenceHash)throw new BotError(409,'FRESH_INTERRUPTED_REVIEW_REQUIRED');
  if(p.mode==='review'){
   const review=interruptedReviewSchema.parse(p.review);
   const source=human.find(h=>h.id===review.authorization_message_id);
   if(!source || !Number.isFinite(stamp(source.created_at)) || source.actor_id!==actorId || source.text!==review.authorization_text || stamp(source.created_at)<=stamp(r.finished_at))throw new BotError(409,'AUTHENTIC_POST_INTERRUPTION_HUMAN_DIRECTION_REQUIRED');
   if(review.portal_owner_conversation_id!==custodian.id)throw new BotError(409,'ORIGINAL_PORTAL_CUSTODIAN_REQUIRED');
   assertFresh(review.observed_at,now);
   const id=crypto.randomUUID();
   db.prepare('INSERT INTO purchase_interrupted_reviews VALUES(?,?,?,?,?,?,?)').run(id,r.id,custodian.id,source.id,evidenceHash,JSON.stringify({snapshot,review}),now.toISOString());
   return {...response,review_id:id,review_recorded:true};
  }
  if(!reviewRow || reviewRow.evidence_hash!==evidenceHash)throw new BotError(409,'ORIGINAL_SOURCE_REVIEW_REQUIRED');
  const reviewed=JSON.parse(reviewRow.snapshot_json).review as z.infer<typeof interruptedReviewSchema>;
  assertFresh(reviewed.observed_at,now);
  if(holds.dispatch_blocked)throw new BotError(409,'PURCHASE_DECISION_SCOPE_BLOCKED');
  const otherFences=db.prepare(purchaseTaskFenceSql.replace('b.task_id=?','b.task_id=? AND b.run_id IS NOT ?')).get(task.id,r.id);
  if(otherFences)throw new BotError(409,'OTHER_PURCHASE_RUN_FENCED');
  const next=nextOccurrence(parseScheduleSpec(task.schedule_json),task.timezone,now);
  if(!next)throw new BotError(409,'FUTURE_SCHEDULE_REQUIRED');
  const exclusions=new Map(reviewed.potentially_attempted_orders.map(o=>[o.order_id,o]));
  for(const h of hints){const id=JSON.parse(h.payload_json).order_id; if(!exclusions.has(id))exclusions.set(id,{order_id:id,order_number:''});}
  db.prepare('INSERT INTO purchase_interrupted_dispositions VALUES(?,?,?,?,?,?,?,?,?)').run(r.id,r.batch_id,reviewRow.id,actorId,actorConversationId??null,evidenceHash,JSON.stringify([...exclusions.values()]),next.toISOString(),now.toISOString());
  db.prepare("UPDATE scheduled_tasks SET next_run_at=?,updated_at=datetime('now') WHERE id=?").run(next.toISOString(),task.id);
  return {...response,resumed:true,idempotent:false,next_run_at:next.toISOString(),excluded_orders:[...exclusions.values()],
   proof_required:'Read a distinct successor run and persisted worker turn before reporting purchasing recovered'};
 }).immediate();
}
function assertFresh(observed:string,now:Date){const age=now.getTime()-Date.parse(observed);if(age<0 || age>15*60_000)throw new BotError(409,'FRESH_SOURCE_AND_PORTAL_CENSUS_REQUIRED');}
