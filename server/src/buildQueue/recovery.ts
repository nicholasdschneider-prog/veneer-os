import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import {z} from 'zod';
import type {BuildQueueRow} from '../db/db.js';
export const BuildRecoveryInput=z.object({job_id:z.number().int().positive(),origin_id:z.number().int().positive(),turn_id:z.string().uuid(),expected_finished_at:z.string().nullable(),request_key:z.string().min(1).max(200),mode:z.enum(['review','recover_done','adopt_active']),reason:z.string().min(10).max(2000)}).strict();
export type BuildRecoveryArgs=z.infer<typeof BuildRecoveryInput>;
export function recoverBuild(db:Database.Database,input:unknown,actorId:number,actorConversation:string|null,isLive:(id:string)=>boolean){
 const p=BuildRecoveryInput.parse(input);
 return db.transaction(()=>{
  const job=db.prepare('SELECT * FROM build_queue WHERE id=?').get(p.job_id) as (BuildQueueRow&{dispatch_id:string|null})|undefined;
  if(!job||job.user_id!==actorId||!db.prepare('SELECT 1 FROM conversations WHERE id=? AND user_id=? AND archived=0').get(job.conversation_id,actorId)||!db.prepare("SELECT 1 FROM users WHERE id=? AND status='active'").get(actorId))throw new Error('Original active owner required');
  const old=db.prepare('SELECT * FROM build_recoveries WHERE request_key=?').get(p.request_key) as {job_id:number;actor_id:number;origin_id:number;turn_id:string;previous_json:string}|undefined;
  if(old){const saved=JSON.parse(old.previous_json);if(old.job_id!==p.job_id||old.actor_id!==actorId||old.origin_id!==p.origin_id||old.turn_id!==p.turn_id||saved.request.mode!==p.mode||saved.request.reason!==p.reason||saved.request.expected_finished_at!==p.expected_finished_at)throw new Error('Recovery key conflict');return {ok:true,existing:true,job:{id:job.id,status:job.status,conversation_id:job.conversation_id,scope_key:job.scope_key}};}
  const origin=db.prepare('SELECT id,conversation_id,turn_id,event_at,message_id,origin_json FROM turn_origins WHERE id=? AND turn_id=? AND conversation_id=?').get(p.origin_id,p.turn_id,job.conversation_id) as {id:number;conversation_id:string;turn_id:string;event_at:string;message_id:number|null;origin_json:string}|undefined;
  if(!origin||JSON.parse(origin.origin_json).kind!=='build_queue')throw new Error('Exact native build origin required');
  if(job.dispatch_id)throw new Error('This job already has a dispatch identity; use normal retry/skip');
  if(job.finished_at!==p.expected_finished_at)throw new Error('Job changed since review');
  if(db.prepare("SELECT 1 FROM build_queue WHERE id<>? AND (conversation_id=? OR scope_key=?) AND status IN ('running','queued','failed','stopped')").get(job.id,job.conversation_id,job.scope_key))throw new Error('Another build owns or waits in this scope');
  const pending=db.prepare('SELECT origin_json,prompt,actor_user_id FROM pending_turns WHERE conversation_id=?').get(job.conversation_id) as {origin_json:string|null;prompt:string;actor_user_id:number}|undefined;
  const queued=!!db.prepare('SELECT 1 FROM queued_messages WHERE conversation_id=?').get(job.conversation_id);
  const doneEligible=job.status==='done'&&Date.parse(origin.event_at)>Date.parse((job.finished_at??'').includes('T')?(job.finished_at??''):(job.finished_at??'').replace(' ','T')+'Z')&&!pending&&!queued&&!isLive(job.conversation_id);
  const latest=db.prepare('SELECT id FROM turn_origins WHERE conversation_id=? ORDER BY id DESC LIMIT 1').get(job.conversation_id) as {id:number}|undefined;
  // Explicit adoption is only this caller's current legacy activation. No automatic startup inference.
  const activeEligible=job.status==='running'&&actorConversation===job.conversation_id&&isLive(job.conversation_id)&&!queued&&pending?.actor_user_id===actorId&&pending.origin_json===origin.origin_json&&latest?.id===origin.id;
  if(p.mode==='review')return {ok:true,job_id:job.id,status:job.status,origin_id:origin.id,turn_id:origin.turn_id,event_at:origin.event_at,finished_at:job.finished_at,done_recovery_ready:doneEligible,active_adoption_ready:activeEligible,legacy_pairing:'Operator-reviewed exact job/origin pair; historical coordinator callback identity was not recorded'};
  if(p.mode==='recover_done'&&!doneEligible)throw new Error('Recovery requires prematurely done metadata and idle owner with no pending or queued work');
  if(p.mode==='adopt_active'&&!activeEligible)throw new Error('Adoption requires the exact caller’s current legacy build turn and no queued work');
  db.prepare('INSERT INTO build_recoveries(request_key,job_id,actor_id,origin_id,turn_id,previous_json) VALUES(?,?,?,?,?,?)').run(p.request_key,job.id,actorId,origin.id,origin.turn_id,JSON.stringify({job,origin,request:p}));
  if(p.mode==='recover_done')db.prepare("UPDATE build_queue SET status='queued',started_at=NULL,finished_at=NULL,error=NULL,attempts=0 WHERE id=? AND status='done'").run(job.id);
  else {
   const id=crypto.randomUUID();db.prepare('INSERT INTO build_dispatches(id,job_id,conversation_id,current_turn_id,current_origin_id) VALUES(?,?,?,?,?)').run(id,job.id,job.conversation_id,p.turn_id,p.origin_id);db.prepare('UPDATE build_queue SET dispatch_id=? WHERE id=?').run(id,job.id);
   db.prepare("UPDATE pending_turns SET origin_json=json_set(origin_json,'$.buildDispatchId',?) WHERE conversation_id=?").run(id,job.conversation_id);
  }
  db.prepare("INSERT INTO build_dispatch_audit(job_id,dispatch_id,kind,turn_id,payload_json) SELECT id,dispatch_id,?,?,? FROM build_queue WHERE id=?").run(p.mode,p.turn_id,JSON.stringify({request_key:p.request_key,actor_id:actorId,origin_id:p.origin_id,reason:p.reason}),job.id);
  return {ok:true,existing:false,job:db.prepare('SELECT id,status,conversation_id,scope_key FROM build_queue WHERE id=?').get(job.id)};
 }).immediate();
}
