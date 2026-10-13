import { createScheduledTasksRouter } from '../src/routes/scheduledTasks.js';
import { createConversationManager } from '../src/runtime/conversationManager.js';
import type { ProviderAdapter } from '../src/providers/types.js';
import crypto from 'node:crypto';
import express from 'express';
import { EventEmitter } from 'node:events';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { acceptPurchaseEvent, readPurchaseEvent, canonicalPurchasePayload, recordPurchasePass } from '../src/botWorkflows/purchaseEvents.js';
import { createScheduledTaskScheduler } from '../src/scheduled/scheduler.js';
import { createBotEventsWebhook } from '../src/botWorkflows/routes.js';
import type { AppContext } from '../src/context.js';
const source=crypto.randomUUID(),task=crypto.randomUUID(),project=crypto.randomUUID();
let db:Database.Database; let bus:EventEmitter; let scheduler:ReturnType<typeof createScheduledTaskScheduler>;
let posts:{id:string;text:string}[]; let fail=false;
const event=(order=crypto.randomUUID())=>({schema_version:'lippert.purchase_candidate/v1',type:'order.purchase_candidate',id:crypto.randomUUID(),task_id:task,order_id:order,order_revision:'a'.repeat(64),occurred_at:'2026-09-01T00:00:00Z'});
beforeEach(()=>{
 db=new Database(':memory:');db.pragma('foreign_keys=ON');migrate(db,fileURLToPath(new URL('../src/db/migrations',import.meta.url)));
 db.prepare("INSERT INTO users(id,email,display_name,role) VALUES(1,'fixture@example.test','Fixture','owner')").run();
 db.prepare("INSERT INTO projects(id,slug,name) VALUES(?,'fixture','Fixture')").run(project);
 db.prepare("INSERT INTO business_teams(id,name,owner_id) VALUES('fixture-team','Fixture',1)").run();
 db.prepare("INSERT INTO bot_event_sources(id,team_id,created_by,name) VALUES(?,'fixture-team',1,'Fixture')").run(source);
 db.prepare(`INSERT INTO scheduled_tasks(id,user_id,assistant_id,project_id,name,prompt,schedule_json,timezone,provider,model,enabled,next_run_at) VALUES(?,1,1,?,'Fixture','Synthetic only','{"type":"daily","time":"09:00"}','UTC','claude','fixture',1,NULL)`).run(task,project);
 db.prepare('INSERT INTO purchase_event_bindings VALUES(?,?,?,1,?)').run(source,task,'fixture-team',project);
 bus=new EventEmitter();posts=[];fail=false;
 scheduler=createScheduledTaskScheduler({db,manager:{bus,postMessage:(conv,text)=>{posts.push({id:conv.id,text});if(fail)throw Error('uncertain fixture launch');}},log:{error:()=>{},warn:()=>{}}});
});
afterEach(()=>{scheduler.stop();db.close();});
function startDone(id:string){bus.emit('event',id,{type:'turn_started',turnId:crypto.randomUUID(),at:new Date().toISOString()});recordPurchasePass(db,id,1,{outcome:'clear',cursor:null});bus.emit('event',id,{type:'turn_done',outcome:'completed'});}
it('retains sorted-hash immutable receipts, delayed/reordered hints, replay and conflicts',()=>{
 const p=event();const a=acceptPurchaseEvent(db,source,p);expect(a.payload_hash).toBe(crypto.createHash('sha256').update(canonicalPurchasePayload(p)).digest('hex'));
 expect(acceptPurchaseEvent(db,source,Object.fromEntries(Object.entries(p).reverse()))).toEqual(a);
 expect(()=>acceptPurchaseEvent(db,source,{...p,order_revision:'b'.repeat(64)})).toThrow('EVENT_ID_CONFLICT');
 expect(()=>db.prepare('UPDATE purchase_event_receipts SET payload_hash=?').run('x')).toThrow('Immutable');
 expect(()=>acceptPurchaseEvent(db,source,{...p,extra:true})).toThrow();
 expect(()=>acceptPurchaseEvent(db,source,{...p,task_id:crypto.randomUUID()})).toThrow('BINDING');
 expect(()=>acceptPurchaseEvent(db,source,{...event(),occurred_at:'2099-01-01T00:00:00Z'})).toThrow('FUTURE');
 expect(()=>acceptPurchaseEvent(db,source,{...event(),order_revision:'A'.repeat(64)})).toThrow();
 expect(()=>acceptPurchaseEvent(db,source,{...event(),occurred_at:'2026-01-01T00:00:00+01:00'})).toThrow();
});
it('coalesces event/manual/cron, bounds eight-order successors, and requires actual start',()=>{
 const events=Array.from({length:10},()=>event());for(const p of events)acceptPurchaseEvent(db,source,p);
 scheduler.tick();expect(posts).toHaveLength(1);expect(posts[0]!.text).toContain(events[0]!.id);expect(posts[0]!.text).not.toContain(events[9]!.id);
 expect(readPurchaseEvent(db,source,events[0]!.id).delivery.worker_started).toBe(false);
 expect(scheduler.runNow(task)).toEqual({ok:false,error:'already_running'});
 db.prepare("UPDATE scheduled_tasks SET next_run_at='2000-01-01T00:00:00Z'").run();scheduler.tick();expect(posts).toHaveLength(1);
 db.prepare('UPDATE scheduled_tasks SET next_run_at=NULL').run();
 const late=event();acceptPurchaseEvent(db,source,late);
 startDone(posts[0]!.id);expect(readPurchaseEvent(db,source,events[0]!.id).delivery.worker_started).toBe(true);
 scheduler.tick();expect(posts).toHaveLength(2);expect(posts[1]!.text).toContain(late.id);expect(posts[1]!.text).toContain(events[9]!.id);
 expect(db.prepare("SELECT count(*) n FROM purchase_event_batches WHERE status='pending'").get()).toEqual({n:0});
});
it('fences uncertain dispatch across scheduler restart and later candidates without relaunch',()=>{
 const p=event();acceptPurchaseEvent(db,source,p);fail=true;scheduler.tick();expect(posts).toHaveLength(1);
 expect(readPurchaseEvent(db,source,p.id).delivery).toMatchObject({status:'blocked',blocked_reason:'UNKNOWN_LAUNCH',worker_started:false});
 acceptPurchaseEvent(db,source,event());scheduler.tick();expect(posts).toHaveLength(1);
 scheduler.stop();scheduler=createScheduledTaskScheduler({db,manager:{bus,postMessage:()=>{throw Error('must not dispatch');}}});scheduler.tick();expect(scheduler.runNow(task).ok).toBe(false);
});
it('rejects revoked source/task/owner/team/project binding at read, intake and dispatch',()=>{
 const p=event();acceptPurchaseEvent(db,source,p);
 for(const [sql,restore] of [["UPDATE bot_event_sources SET enabled=0","UPDATE bot_event_sources SET enabled=1"],["UPDATE users SET status='disabled'","UPDATE users SET status='active'"],["UPDATE scheduled_tasks SET enabled=0","UPDATE scheduled_tasks SET enabled=1"],["UPDATE scheduled_tasks SET project_id=NULL",`UPDATE scheduled_tasks SET project_id='${project}'`]]){
 db.exec(sql);expect(()=>readPurchaseEvent(db,source,p.id)).toThrow('BINDING');expect(()=>acceptPurchaseEvent(db,source,event())).toThrow('BINDING');scheduler.tick();expect(posts).toHaveLength(0);db.exec(restore);
 }
});
it('does not hot-loop a failed or unknown worker completion',()=>{
 acceptPurchaseEvent(db,source,event());scheduler.tick();acceptPurchaseEvent(db,source,event());
 bus.emit('event',posts[0]!.id,{type:'turn_done',outcome:'failed'});scheduler.tick();expect(posts).toHaveLength(1);
});
it('enforces exact raw POST HMAC, signed canonical GET, timestamp and body limits',async()=>{
 const key='synthetic-fixture-hmac';const app=express();app.use('/webhooks/bot-events',createBotEventsWebhook({db,secrets:{getApiKeyOverride:()=>key}} as unknown as AppContext));
 const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));const addr=server.address() as {port:number};const base=`http://127.0.0.1:${addr.port}`;
 const pathname='/webhooks/bot-events/'+source;const p=event(),body=JSON.stringify(p);const stamp=String(Math.floor(Date.now()/1000));
 const headers=(bytes:string,t=stamp)=>({'content-type':'application/json','x-veneer-timestamp':t,'x-veneer-signature':crypto.createHmac('sha256',key).update(t+bytes).digest('hex')});
 try{
 expect((await fetch(base+pathname,{method:'POST',headers:headers('.'+body),body})).status).toBe(200);
 expect((await fetch(base+pathname,{method:'POST',headers:headers('.'+body),body:body+' '})).status).toBe(401);
 expect((await fetch(base+pathname,{method:'POST',headers:headers('.'+body,'1000000000'),body})).status).toBe(401);
 const get=pathname+'/purchase-events/'+p.id;expect((await fetch(base+get,{headers:headers('.GET.'+get)})).status).toBe(200);
 expect((await fetch(base+get+'?other=1',{headers:headers('.GET.'+get)})).status).toBe(401);
 expect((await fetch(base+get,{headers:headers('.GET.'+get.replace(p.id,crypto.randomUUID()))})).status).toBe(401);
 const big=' '.repeat(17000);expect((await fetch(base+pathname,{method:'POST',headers:headers('.'+big),body:big})).status).toBe(413);
 }finally{await new Promise<void>(r=>server.close(()=>r()));}
});
it('retains interrupted pending turns but suppresses native automatic recovery',()=>{
 const p=event();acceptPurchaseEvent(db,source,p);scheduler.tick();
 const id=posts[0]!.id;
 db.prepare("INSERT INTO pending_turns(conversation_id,prompt,attempts,status) VALUES(?,'Synthetic interrupted prompt',1,'pending')").run(id);
 scheduler.stop();scheduler=createScheduledTaskScheduler({db,manager:{bus,postMessage:()=>{throw Error('must not relaunch');}}});
 expect(db.prepare('SELECT status FROM pending_turns WHERE conversation_id=?').get(id)).toEqual({status:'failed'});
 expect(readPurchaseEvent(db,source,p.id).delivery).toMatchObject({status:'blocked',blocked_reason:'UNKNOWN_RUNNER_RESTART'});
 scheduler.tick();expect(scheduler.runNow(task).ok).toBe(false);
});
it('keeps unresolved human questions active and blocks successors',()=>{
 acceptPurchaseEvent(db,source,event());scheduler.tick();acceptPurchaseEvent(db,source,event());
 bus.emit('event',posts[0]!.id,{type:'question_asked'});bus.emit('event',posts[0]!.id,{type:'turn_done',outcome:'completed'});
 scheduler.tick();expect(posts).toHaveLength(1);expect(scheduler.runNow(task).ok).toBe(false);
});
it('bounds pending backlog and preserves every accepted identity',()=>{
 for(let i=0;i<256;i++)acceptPurchaseEvent(db,source,event());
 expect(()=>acceptPurchaseEvent(db,source,event())).toThrow('PURCHASE_BACKLOG_FULL');
 expect(db.prepare('SELECT count(*) n FROM purchase_event_receipts').get()).toEqual({n:256});
 scheduler.tick();expect(db.prepare("SELECT count(*) n FROM purchase_event_batches WHERE status='pending'").get()).toEqual({n:1});
});
it('persists the real native manager turn-start and suppresses a fenced conversation restart',async()=>{
 scheduler.stop();
 let runs=0;let finish=()=>{};
 const adapter:ProviderAdapter={id:'claude',mintSessionId:()=>crypto.randomUUID(),readTranscript:async()=>[],runTurn(spec,onEvent){runs++;const done=new Promise<void>(resolve=>{finish=()=>{onEvent({type:'turn_done',turnId:spec.turnId,outcome:'completed'});resolve();};});return {done,kill:finish,respondToApproval:()=>true};}};
 const manager=createConversationManager({db,adapters:{claude:adapter},resolveWorkspace:()=>({workspaceDir:'/tmp',assistantSlug:'fixture',elevated:false,fullAccess:false}),log:{warn:()=>{},error:()=>{}}});
 scheduler=createScheduledTaskScheduler({db,manager});
 const flush=()=>new Promise(resolve=>setImmediate(resolve));
 try{
 const p=event();acceptPurchaseEvent(db,source,p);scheduler.tick();await flush();
 const delivery=readPurchaseEvent(db,source,p.id).delivery;expect(delivery.worker_started).toBe(true);expect(runs).toBe(1);
 expect(db.prepare('SELECT status FROM pending_turns WHERE conversation_id=?').get(delivery.conversation_id)).toEqual({status:'pending'});
 recordPurchasePass(db,delivery.conversation_id!,1,{outcome:'clear',cursor:null});finish();await flush();await flush();
 db.prepare("UPDATE purchase_event_batches SET status='blocked',blocked_reason='SYNTHETIC_UNKNOWN'").run();
 const conv=db.prepare('SELECT * FROM conversations WHERE id=?').get(delivery.conversation_id) as Parameters<typeof manager.postMessage>[0];
 manager.postMessage(conv,'Synthetic replay must not execute');await flush();expect(runs).toBe(1);
 }finally{manager.shutdown();await flush();}
});

it.each(['unknown','blocked'] as const)('requires the exact-worker pass and fences global %s without a successor',(outcome)=>{
 const p=event();acceptPurchaseEvent(db,source,p);scheduler.tick();const id=posts[0]!.id;acceptPurchaseEvent(db,source,event());
 bus.emit('event',id,{type:'turn_started',turnId:crypto.randomUUID(),at:new Date().toISOString()});
 expect(()=>recordPurchasePass(db,id,2,{outcome:'clear'})).toThrow('WORKER');
 expect(()=>recordPurchasePass(db,crypto.randomUUID(),1,{outcome:'clear'})).toThrow('WORKER');
 recordPurchasePass(db,id,1,{outcome,cursor:'synthetic-cursor'});
 expect(()=>recordPurchasePass(db,id,1,{outcome:'clear'})).toThrow();
 bus.emit('event',id,{type:'turn_done',outcome:'completed'});scheduler.tick();expect(posts).toHaveLength(1);
 expect(readPurchaseEvent(db,source,p.id).delivery.blocked_reason).toBe(outcome==='unknown'?'SOURCE_UNKNOWN':'SOURCE_BLOCKED');
});
it('missing pass acknowledgment fences a successful turn instead of interpreting its text',()=>{
 const p=event();acceptPurchaseEvent(db,source,p);scheduler.tick();acceptPurchaseEvent(db,source,event());
 bus.emit('event',posts[0]!.id,{type:'turn_started',turnId:crypto.randomUUID(),at:new Date().toISOString()});
 bus.emit('event',posts[0]!.id,{type:'turn_done',outcome:'completed'});scheduler.tick();expect(posts).toHaveLength(1);
 expect(readPurchaseEvent(db,source,p.id).delivery.blocked_reason).toBe('WORKER_PASS_UNACKNOWLEDGED');
});

it('HTTP pass acknowledgment requires authenticated exact worker context',async()=>{
 const p=event();acceptPurchaseEvent(db,source,p);scheduler.tick();const id=posts[0]!.id;bus.emit('event',id,{type:'turn_started',turnId:crypto.randomUUID(),at:new Date().toISOString()});
 let context:string|undefined;let actor=1;const app=express();app.use(express.json());
 app.use((req,_res,next)=>{req.user=db.prepare('SELECT * FROM users WHERE id=1').get() as typeof req.user;req.user!.id=actor;req.agentConversationId=context;next();});
 app.use('/api/scheduled-tasks',createScheduledTasksRouter({db,manager:{}} as unknown as AppContext));
 const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));const url=`http://127.0.0.1:${(server.address() as {port:number}).port}/api/scheduled-tasks/purchase-candidate-pass`;
 const post=()=>fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({outcome:'clear',cursor:null})});
 try{expect((await post()).status).toBe(403);context=crypto.randomUUID();expect((await post()).status).toBe(403);context=id;actor=2;expect((await post()).status).toBe(403);actor=1;expect((await post()).status).toBe(200);expect(await (await post()).json()).toMatchObject({recorded:true,purchase_authority:false});}
 finally{await new Promise<void>(r=>server.close(()=>r()));}
});

it('skips a grounded ordinary exception in a clear finite pass and dispatches an independent later hint',()=>{
 const ordinary=event(),eligible=event();
 const sourceReview=new Map([[ordinary.order_id,{processable:false,reason:'grounded_cost_exception'}],[eligible.order_id,{processable:true,reason:null}]]);
 const receipt=acceptPurchaseEvent(db,source,ordinary);expect(receipt.purchase_authority).toBe(false);scheduler.tick();
 const id=posts[0]!.id;expect(sourceReview.get(ordinary.order_id)?.reason).toBe('grounded_cost_exception');
 expect(posts[0]!.text).toContain('grounded per-order cost/address/decision exceptions');
 bus.emit('event',id,{type:'turn_started',turnId:crypto.randomUUID(),at:new Date().toISOString()});
 expect(()=>recordPurchasePass(db,id,1,{outcome:'clear',cursor:'x'.repeat(501)})).toThrow();
 const ack=recordPurchasePass(db,id,1,{outcome:'clear',cursor:null});expect(ack.purchase_authority).toBe(false);
 expect(recordPurchasePass(db,id,1,{outcome:'clear',cursor:null})).toEqual(ack);
 expect(()=>recordPurchasePass(db,id,1,{outcome:'clear',cursor:'changed'})).toThrow('PASS_CONFLICT');
 expect(acceptPurchaseEvent(db,source,eligible).purchase_authority).toBe(false);
 bus.emit('event',id,{type:'turn_done',outcome:'completed'});scheduler.tick();expect(posts).toHaveLength(2);
 expect(posts[1]!.text).toContain(eligible.id);expect(posts[1]!.text).not.toContain(ordinary.id);
 expect(sourceReview.get(eligible.order_id)?.processable).toBe(true);
 startDone(posts[1]!.id);
 for(let i=0;i<10;i++){expect(acceptPurchaseEvent(db,source,ordinary)).toEqual(receipt);scheduler.tick();}
 expect(posts).toHaveLength(2);expect(readPurchaseEvent(db,source,ordinary.id).receipt.purchase_authority).toBe(false);
 expect(db.prepare("SELECT count(*) n FROM purchase_event_batches WHERE status='pending'").get()).toEqual({n:0});
});
it('does not accept a pass before the actual worker-start association',()=>{
 acceptPurchaseEvent(db,source,event());scheduler.tick();expect(()=>recordPurchasePass(db,posts[0]!.id,1,{outcome:'clear',cursor:null})).toThrow('WORKER_UNAVAILABLE');
});

// A disposition is not a worker acknowledgment, and never replays its original hints.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe } from 'vitest';
import { reconcilePurchaseStartup } from '../src/botWorkflows/purchaseStartup.js';
import { transcriptArchivePath } from '../src/runtime/transcriptArchive.js';
import { claudeSessionFilePath } from '../src/providers/claude/transcript.js';
describe('native failed-before-model reconciliation',()=>{
 let dir:string,oldHome:string|undefined,run:string,session:string,id:string,p:ReturnType<typeof event>;
 let rows:Record<string,any>[];
 const error="You've hit your session limit · resets 3pm (America/Indianapolis)";
 function save(){const bytes=rows.map(r=>JSON.stringify(r)).join('\n')+'\n';for(const f of [transcriptArchivePath(dir,'claude',session),claudeSessionFilePath('/tmp',session)]){fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,bytes);}}
 const inspect=()=>reconcilePurchaseStartup(db,dir,1,undefined,{run_id:run,mode:'inspect'});
 const release=(hash=inspect().evidence_hash)=>reconcilePurchaseStartup(db,dir,1,undefined,{run_id:run,mode:'reconcile',expected_hash:hash,coordination_reference:'Synthetic original-owner portal clearance'});
 beforeEach(()=>{
  dir=fs.mkdtempSync(path.join(os.tmpdir(),'purchase-startup-'));oldHome=process.env.VP_SERVICE_HOME;process.env.VP_SERVICE_HOME=dir;
  p=event();acceptPurchaseEvent(db,source,p);scheduler.tick();id=posts[0]!.id;
  const c=db.prepare('SELECT native_session_id FROM conversations WHERE id=?').get(id) as {native_session_id:string};session=c.native_session_id;
  const r=db.prepare('SELECT id FROM scheduled_task_runs WHERE conversation_id=?').get(id) as {id:string};run=r.id;
  bus.emit('event',id,{type:'turn_started',turnId:crypto.randomUUID(),at:new Date().toISOString()});
  bus.emit('event',id,{type:'error',message:error});bus.emit('event',id,{type:'turn_done',outcome:'failed'});
  const now=new Date().toISOString();rows=[{type:'user',sessionId:session,timestamp:now,cwd:'/tmp',message:{role:'user',content:[{type:'text',text:posts[0]!.text}]}},
   {type:'assistant',sessionId:session,timestamp:now,isApiErrorMessage:true,apiErrorStatus:429,error:'rate_limit',message:{role:'assistant',model:'<synthetic>',content:[{type:'text',text:error}]}}];save();
 });
 afterEach(()=>{if(oldHome===undefined)delete process.env.VP_SERVICE_HOME;else process.env.VP_SERVICE_HOME=oldHome;fs.rmSync(dir,{recursive:true,force:true});});
 it('requires fresh review, keeps originals immutable, and releases only unrelated candidates',()=>{
  const duplicate={...event(p.order_id)};acceptPurchaseEvent(db,source,duplicate);const other=event();acceptPurchaseEvent(db,source,other);
  const before=db.prepare('SELECT * FROM scheduled_task_runs WHERE id=?').get(run);const batch=db.prepare('SELECT * FROM purchase_event_batches WHERE run_id=?').get(run);
  const reviewed=inspect();expect(reviewed.reconciled).toBe(false);scheduler.tick();expect(posts).toHaveLength(1);
  expect(()=>release('a'.repeat(64))).toThrow('FRESH_STARTUP');release(reviewed.evidence_hash);expect(release(reviewed.evidence_hash).reconciled).toBe(true);
  expect(db.prepare('SELECT * FROM scheduled_task_runs WHERE id=?').get(run)).toEqual(before);expect(db.prepare('SELECT * FROM purchase_event_batches WHERE run_id=?').get(run)).toEqual(batch);
  expect(db.prepare('SELECT 1 FROM purchase_worker_passes WHERE run_id=?').get(run)).toBeUndefined();
  expect(()=>db.prepare('DELETE FROM purchase_startup_dispositions').run()).toThrow('Immutable');
  scheduler.tick();expect(posts).toHaveLength(2);expect(posts[1]!.text).toContain(other.id);expect(posts[1]!.text).not.toContain(duplicate.id);expect(posts[1]!.text).toContain(p.order_id);
  expect(readPurchaseEvent(db,source,p.id).delivery.status).toBe('blocked');expect(readPurchaseEvent(db,source,duplicate.id).delivery).toMatchObject({status:'blocked',blocked_reason:'STARTUP_FAILURE_ORDER_FENCED'});
  expect(()=>acceptPurchaseEvent(db,source,event(p.order_id))).toThrow('STARTUP_FAILURE_ORDER_FENCED');expect(acceptPurchaseEvent(db,source,p).event_id).toBe(p.id);
 });
 it('retains unconsumed continuation messages under the original blocked-chat guard',()=>{
  db.prepare("INSERT INTO queued_messages(conversation_id,prompt,actor_user_id) VALUES(?,'Synthetic unconsumed continuation',1)").run(id);
  expect(release().retained_queued_messages).toBe(1);expect(db.prepare('SELECT count(*) n FROM queued_messages WHERE conversation_id=?').get(id)).toEqual({n:1});
  expect(db.prepare('SELECT status FROM purchase_event_batches WHERE run_id=?').get(run)).toEqual({status:'blocked'});
 });
 it('allows only authorized owner inspection through the authenticated API route',async()=>{
  let actor=1;let caller:string|undefined;const app=express();app.use(express.json());
  app.use((req,_res,next)=>{req.user=db.prepare('SELECT * FROM users WHERE id=1').get() as typeof req.user;req.user!.id=actor;req.agentConversationId=caller;next();});
  app.use('/api/scheduled-tasks',createScheduledTasksRouter({db,config:{dataDir:dir},manager:{}} as unknown as AppContext));
  const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));const url=`http://127.0.0.1:${(server.address() as {port:number}).port}/api/scheduled-tasks/purchase-startup-reconciliation`;
  const post=(body:unknown)=>fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  try{
   actor=2;expect((await post({run_id:run,mode:'inspect'})).status).toBe(403);actor=1;caller=id;expect((await post({run_id:run,mode:'inspect'})).status).toBe(403);caller=undefined;
   const proof=await (await post({run_id:run,mode:'inspect'})).json() as {evidence_hash:string};
   expect(db.prepare('SELECT 1 FROM purchase_startup_dispositions').get()).toBeUndefined();
   expect((await post({run_id:run,mode:'reconcile',expected_hash:proof.evidence_hash,coordination_reference:'Synthetic clearance'})).status).toBe(200);
  }finally{await new Promise<void>(r=>server.close(()=>r()));}
 });
 it('does not hot-loop a backlog containing only excluded originals',()=>{acceptPurchaseEvent(db,source,event(p.order_id));release();for(let i=0;i<5;i++)scheduler.tick();expect(posts).toHaveLength(1);});
 it.each(['tool','model','truncated','unknown','session','sidechain','native_drift','later_user'])('rejects incomplete or dispatched evidence: %s',(kind)=>{
  const hash=inspect().evidence_hash;
  if(kind==='tool')rows[1]!.message.content.push({type:'tool_use',name:'Bash',input:{}});
  if(kind==='model')rows[1]!.message.model='claude';
  if(kind==='truncated')rows.pop();
  if(kind==='unknown')rows.push({type:'unrecognized',sessionId:session});
  if(kind==='session')rows[1]!.sessionId=crypto.randomUUID();
  if(kind==='sidechain')rows[1]!.isSidechain=true;
  if(kind==='later_user')rows.push(rows[0]!);
  save();if(kind==='native_drift')fs.appendFileSync(claudeSessionFilePath('/tmp',session),'{}\n');
  expect(()=>release(hash)).toThrow();expect(db.prepare('SELECT 1 FROM purchase_startup_dispositions').get()).toBeUndefined();
 });
 it.each(['UNKNOWN_LAUNCH','UNKNOWN_RUNNER_RESTART','SOURCE_UNKNOWN','SOURCE_BLOCKED','WORKER_PASS_UNACKNOWLEDGED'])('never clears permanent %s fences',(reason)=>{
  db.prepare('UPDATE purchase_event_batches SET blocked_reason=? WHERE run_id=?').run(reason,run);expect(()=>release()).toThrow('STARTUP_FAILURE_NOT_PROVEN');
 });
 it('requires current owner/task/project access and stops after drift',()=>{
  const hash=inspect().evidence_hash;
  expect(()=>reconcilePurchaseStartup(db,dir,2,undefined,{run_id:run,mode:'inspect'})).toThrow('ACCESS');
  expect(()=>reconcilePurchaseStartup(db,dir,1,id,{run_id:run,mode:'inspect'})).toThrow('PLATFORM_DEV');
  db.prepare('UPDATE scheduled_tasks SET project_id=NULL WHERE id=?').run(task);expect(()=>release(hash)).toThrow('ACCESS');
 });
 it('accepts the synthetic out-of-credits refusal but only with provider 429 metadata',()=>{
  const credits="You're out of usage credits. Switch to another model to continue.";
  db.prepare('UPDATE scheduled_task_runs SET error=? WHERE id=?').run(credits,run);rows[1]!.message.content[0].text=credits;save();
  expect(release().reconciled).toBe(true);
 });
 it.each(['model','status','api_error','run_error'])('rejects an out-of-credits text without matching evidence: %s',(kind)=>{
  const credits="You're out of usage credits. Switch to another model to continue.";
  db.prepare('UPDATE scheduled_task_runs SET error=? WHERE id=?').run(kind==='run_error'?error:credits,run);rows[1]!.message.content[0].text=credits;
  if(kind==='model')rows[1]!.message.model='claude-opus-5-5';
  if(kind==='status')rows[1]!.apiErrorStatus=500;
  if(kind==='api_error')rows[1]!.isApiErrorMessage=false;
  save();expect(()=>release()).toThrow('STARTUP_FAILURE_NOT_PROVEN');expect(db.prepare('SELECT 1 FROM purchase_startup_dispositions').get()).toBeUndefined();
 });
 it('refuses to delete a retained purchase run with a clear 409',async()=>{
  const app=express();app.use(express.json());
  app.use((req,_res,next)=>{req.user=db.prepare('SELECT * FROM users WHERE id=1').get() as typeof req.user;next();});
  app.use('/api/scheduled-tasks',createScheduledTasksRouter({db,config:{dataDir:dir},manager:{}} as unknown as AppContext));
  const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));
  try{
   const res=await fetch(`http://127.0.0.1:${(server.address() as {port:number}).port}/api/scheduled-tasks/${task}/runs/${run}`,{method:'DELETE'});
   expect(res.status).toBe(409);expect(((await res.json()) as {error:string}).error).toContain('PURCHASE_RUN_RETAINED');
   expect(db.prepare('SELECT 1 FROM scheduled_task_runs WHERE id=?').get(run)).toBeTruthy();
  }finally{await new Promise<void>(r=>server.close(()=>r()));}
 });
 it('freshness pins native bytes even when changed evidence would otherwise pass',()=>{const hash=inspect().evidence_hash;rows[0]!.message.content[0].text+=' changed';save();expect(()=>release(hash)).toThrow('FRESH_STARTUP');});
});

function heldQuestion(orderNumber='100122466',orderId=crypto.randomUUID()) {
 const conversation=crypto.randomUUID(),decision=crypto.randomUUID();
 db.prepare("INSERT INTO conversations(id,assistant_id,user_id,project_id,title,provider,model,native_session_id) VALUES(?,1,1,?,'Original owner','claude','fixture',?)").run(conversation,project,crypto.randomUUID());
 db.prepare("INSERT INTO bot_registrations(conversation_id,name,registered_by) VALUES(?,'Fixture',1)").run(conversation);
 db.prepare('INSERT INTO purchase_order_scopes VALUES(?,?,?,?,?)').run(source,orderId,orderNumber,'Synthetic exact source mapping','a'.repeat(64));
 db.prepare(`INSERT INTO bot_decisions(id,conversation_id,source_key,proposal_key,proposal_json,assignee_id) VALUES(?,?,'fixture','fixture',?,1)`).run(decision,conversation,JSON.stringify({blocks_scope:'task',as_of:{orders:[{order_number:orderNumber}]}}));
 return {decision,orderId};
}
it('keeps held orders in the original pending batch, excludes full scans, and processes unrelated hints',()=>{
 const {decision,orderId}=heldQuestion();const held=event(orderId),other=event();acceptPurchaseEvent(db,source,held);acceptPurchaseEvent(db,source,other);
 const original=readPurchaseEvent(db,source,held.id).delivery.batch_id;
 scheduler.tick();expect(posts).toHaveLength(1);expect(posts[0]!.text).not.toContain(held.id);expect(posts[0]!.text).toContain(other.id);
 expect(posts[0]!.text).toContain('100122466');expect(posts[0]!.text).toContain('full source queue and daily backup');
 expect(readPurchaseEvent(db,source,held.id).delivery).toMatchObject({batch_id:original,run_id:null,status:'blocked',blocked_reason:'NATIVE_DECISION_HOLD',worker_started:false});
 expect(readPurchaseEvent(db,source,other.id).delivery.batch_id).not.toBe(original);
 startDone(posts[0]!.id);for(let i=0;i<5;i++)scheduler.tick();expect(posts).toHaveLength(1);
 db.prepare("UPDATE bot_decisions SET state='decided' WHERE id=?").run(decision);
 scheduler.tick();expect(posts).toHaveLength(2);expect(posts[1]!.text).toContain(held.id);
});
it('refreshes holds for scheduled full scans and rejects unmapped or workload scope without inferring disjointness',()=>{
 const {decision}=heldQuestion();db.prepare("UPDATE scheduled_tasks SET next_run_at='2000-01-01T00:00:00Z'").run();
 scheduler.tick();expect(posts).toHaveLength(1);expect(posts[0]!.text).toContain('100122466');startDone(posts[0]!.id);
 db.prepare("UPDATE bot_decisions SET proposal_json=? WHERE id=?").run(JSON.stringify({blocks_scope:'task',as_of:{orders:[{order_number:'999'}]}}),decision);
 acceptPurchaseEvent(db,source,event());scheduler.tick();expect(posts).toHaveLength(1);
 expect(readPurchaseEvent(db,source,(db.prepare('SELECT event_id FROM purchase_event_receipts').get() as {event_id:string}).event_id).decision_holds.dispatch_blocked).toBe(true);
 db.prepare("UPDATE bot_decisions SET proposal_json=? WHERE id=?").run(JSON.stringify({blocks_scope:'workload',as_of:{orders:[{order_number:'100122466'}]}}),decision);
 scheduler.tick();expect(posts).toHaveLength(1);
});
it('does not count held hints against the eight-order bound or launch held-only pending batches',()=>{
 const {orderId}=heldQuestion();acceptPurchaseEvent(db,source,event(orderId));for(let i=0;i<4;i++)scheduler.tick();expect(posts).toHaveLength(0);
 const eligible=Array.from({length:9},()=>event());for(const p of eligible)acceptPurchaseEvent(db,source,p);scheduler.tick();
 for(const p of eligible.slice(0,8))expect(posts[0]!.text).toContain(p.id);expect(posts[0]!.text).not.toContain(eligible[8]!.id);
 startDone(posts[0]!.id);scheduler.tick();expect(posts[1]!.text).toContain(eligible[8]!.id);
});
it('uses the exact original source custodian rather than other bots sharing the assistant and project',()=>{
 const {decision,orderId}=heldQuestion();const owner=(db.prepare('SELECT conversation_id FROM bot_decisions WHERE id=?').get(decision) as {conversation_id:string}).conversation_id;
 db.prepare('INSERT INTO purchase_task_decision_owners VALUES(?,?,?,?)').run(task,source,owner,'Synthetic genuine source custodian');
 const unrelated=heldQuestion('100122999');db.prepare("UPDATE bot_decisions SET proposal_json='{}' WHERE id=?").run(unrelated.decision);
 const held=event(orderId),eligible=event();acceptPurchaseEvent(db,source,held);acceptPurchaseEvent(db,source,eligible);scheduler.tick();expect(posts).toHaveLength(1);
 startDone(posts[0]!.id);db.prepare('UPDATE bot_registrations SET active=0 WHERE conversation_id=?').run(owner);
 acceptPurchaseEvent(db,source,event());scheduler.tick();expect(posts).toHaveLength(1);
 expect(readPurchaseEvent(db,source,held.id).decision_holds.dispatch_blocked).toBe(true);
});

import { recoverInterruptedPurchase } from '../src/botWorkflows/purchaseInterrupted.js';
import { botFeatureCatalog, botFeatureInstructions } from '../src/featureGuide/catalog.js';
import { coreVeneerRules } from '../src/instructions/context.js';
describe('exact interrupted purchasing successor recovery',()=>{
 let dir:string,oldHome:string|undefined,run:string,id:string,session:string,custodian:string,now:Date;
 let original:ReturnType<typeof event>,attempted:ReturnType<typeof event>,reviewInput:Record<string,unknown>;
 const authorize='Fix the existing interrupted purchasing task. Preserve UNKNOWN work and process unrelated eligible candidates.';
 const inspect=(caller:string|undefined=undefined)=>recoverInterruptedPurchase(db,dir,1,caller,{run_id:run,mode:'inspect'},now);
 const review=()=>recoverInterruptedPurchase(db,dir,1,custodian,{run_id:run,mode:'review',expected_hash:inspect().evidence_hash,review:reviewInput},now);
 const resume=(reviewId:string,hash=inspect().evidence_hash)=>recoverInterruptedPurchase(db,dir,1,undefined,{run_id:run,mode:'resume',expected_hash:hash,review_id:reviewId},now);
 beforeEach(()=>{
  dir=fs.mkdtempSync(path.join(os.tmpdir(),'purchase-interrupted-'));oldHome=process.env.VP_SERVICE_HOME;process.env.VP_SERVICE_HOME=dir;
  custodian=crypto.randomUUID();
  db.prepare("INSERT INTO conversations(id,assistant_id,user_id,project_id,title,provider,model,native_session_id) VALUES(?,1,1,?,'Original purchasing custodian','claude','fixture',?)").run(custodian,project,crypto.randomUUID());
  db.prepare("INSERT INTO bot_registrations(conversation_id,name,registered_by) VALUES(?,'Fixture',1)").run(custodian);
  db.prepare('INSERT INTO purchase_task_decision_owners VALUES(?,?,?,?)').run(task,source,custodian,'Synthetic original custodian binding');
  db.prepare(`UPDATE scheduled_tasks SET schedule_json='{"type":"cron","expression":"*/15 7-21 * * *"}',timezone='America/New_York' WHERE id=?`).run(task);
  original=event();acceptPurchaseEvent(db,source,original);scheduler.tick();id=posts[0]!.id;
  run=(db.prepare('SELECT id FROM scheduled_task_runs WHERE conversation_id=?').get(id) as {id:string}).id;
  session=(db.prepare('SELECT native_session_id FROM conversations WHERE id=?').get(id) as {native_session_id:string}).native_session_id;
  bus.emit('event',id,{type:'turn_started',turnId:crypto.randomUUID(),at:new Date().toISOString()});
  db.prepare("INSERT INTO pending_turns(conversation_id,prompt,status) VALUES(?,'Original interrupted native prompt','pending')").run(id);
  db.prepare("INSERT INTO queued_messages(conversation_id,prompt,actor_user_id) VALUES(?,'Retain unconsumed original continuation',1)").run(id);
  scheduler.stop();scheduler=createScheduledTaskScheduler({db,manager:{bus,postMessage:(conv,text)=>posts.push({id:conv.id,text})}});
  db.prepare("UPDATE scheduled_tasks SET next_run_at='2026-10-12T13:30:00.000Z' WHERE id=?").run(task);
  const rows=[{type:'user',sessionId:session,timestamp:new Date().toISOString(),cwd:'/tmp',message:{content:[{type:'text',text:posts[0]!.text}]}},
   {type:'assistant',sessionId:session,message:{content:[{type:'tool_use',name:'Bash',id:'native-tool',input:{command:'synthetic read'}}]}},
   {type:'user',sessionId:session,message:{content:[{type:'tool_result',tool_use_id:'native-tool',content:'Synthetic result'}]}}];
  for(const file of [transcriptArchivePath(dir,'claude',session),claudeSessionFilePath('/tmp',session)]){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,rows.map(row=>JSON.stringify(row)).join('\n')+'\n');}
  now=new Date(Date.now()+2000);
  db.prepare('INSERT INTO bot_human_messages VALUES(?,?,?,?,?,?)').run('human-repair',custodian,1,authorize,'[]',new Date(now.getTime()-1000).toISOString());
  attempted=event();
  reviewInput={authorization_message_id:'human-repair',authorization_text:authorize,reviewed_full_human_context:true,recovery_only_no_replay:true,
   later_context_assessment:'Reviewed all native owner messages; no superseding purchase or replay instruction.',observed_at:now.toISOString(),
   source_reference:'Synthetic original source snapshot reference',source_evidence:'Original source guards and attempt records freshly read; old effects remain UNKNOWN.',
   attempt_census_reference:'Synthetic original source attempt census reference',attempt_census_complete:true,unscoped_unknown_present:false,source_purchase_fences_preserved:true,potentially_attempted_orders:[{order_id:attempted.order_id,order_number:'100122597'}],
   full_scan_exclusions_complete:true,portal_owner_conversation_id:custodian,portal_clearance_reference:'Synthetic shared portal release coordinated with the original purchasing custodian',portal_is_idle_and_released:true};
 });
 afterEach(()=>{if(oldHome===undefined)delete process.env.VP_SERVICE_HOME;else process.env.VP_SERVICE_HOME=oldHome;fs.rmSync(dir,{recursive:true,force:true});});
 it('preserves UNKNOWN originals and restores only unrelated successor cadence with real turn proof',()=>{
  const other=event();acceptPurchaseEvent(db,source,other);acceptPurchaseEvent(db,source,attempted);const duplicate=event(original.order_id);acceptPurchaseEvent(db,source,duplicate);
  const originalTables=()=>['scheduled_task_runs','purchase_event_batches','purchase_worker_starts','purchase_worker_passes','pending_turns','queued_messages'].map(table=>db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
  const before=originalTables();const inspected=inspect();expect(inspected.tool_names).toEqual(['Bash']);expect(inspected.original_work_remains_unknown).toBe(true);
  expect(scheduler.runNow(task)).toMatchObject({ok:false,error:'purchase_run_fenced',blockedRunId:run,blockedReason:'UNKNOWN_RUNNER_RESTART'});
  const reviewed=review() as {review_id:string};const result=resume(reviewed.review_id);
  expect(result).toMatchObject({resumed:true,execute:false,purchase_authority:false,retained_queued_messages:1});expect(Date.parse(result.next_run_at!)).toBeGreaterThan(now.getTime());
  expect(originalTables()).toEqual(before);expect(resume(reviewed.review_id,result.evidence_hash)).toMatchObject({idempotent:true});
  expect(()=>db.prepare('DELETE FROM purchase_interrupted_dispositions').run()).toThrow('Immutable');expect(()=>db.prepare('UPDATE purchase_interrupted_reviews SET evidence_hash=?').run('bad')).toThrow('Immutable');
  scheduler.tick();expect(posts).toHaveLength(2);expect(posts[1]!.id).not.toBe(id);expect(posts[1]!.text).toContain(other.id);
  expect(posts[1]!.text).not.toContain(attempted.id);expect(posts[1]!.text).not.toContain(duplicate.id);expect(posts[1]!.text).toContain(original.order_id);expect(posts[1]!.text).toContain(attempted.order_id);expect(posts[1]!.text).toContain('100122597');expect(posts[1]!.text).toContain('full source queue/daily backup');
  bus.emit('event',posts[1]!.id,{type:'turn_started',turnId:crypto.randomUUID(),at:new Date().toISOString()});expect(readPurchaseEvent(db,source,other.id).delivery.worker_started).toBe(true);
  expect(readPurchaseEvent(db,source,original.id)).toMatchObject({interrupted_disposition:{review_id:reviewed.review_id},delivery:{status:'blocked',blocked_reason:'UNKNOWN_RUNNER_RESTART'}});
  expect(()=>acceptPurchaseEvent(db,source,event(original.order_id))).toThrow('FENCED');expect(()=>acceptPurchaseEvent(db,source,event(attempted.order_id))).toThrow('FENCED');
 });
 it('requires original custodian review and authentic exact post-interruption human text',()=>{
  expect(()=>recoverInterruptedPurchase(db,dir,1,id,{run_id:run,mode:'review',expected_hash:inspect().evidence_hash,review:reviewInput},now)).toThrow('CUSTODIAN');
  expect(()=>resume(crypto.randomUUID())).toThrow('ORIGINAL_SOURCE_REVIEW');reviewInput.authorization_text=authorize+' altered';expect(()=>review()).toThrow('AUTHENTIC');
  expect(db.prepare('SELECT 1 FROM purchase_interrupted_dispositions').get()).toBeUndefined();
 });
 it.each(['human','archive','task','binding','pending','start','pass','scope'])('fails closed on changed %s evidence or guards',kind=>{
  const reviewed=review() as {review_id:string};const hash=inspect().evidence_hash;
  if(kind==='human')db.prepare('INSERT INTO bot_human_messages VALUES(?,?,?,?,?,?)').run('later',custodian,1,'Pause unrelated work pending my review.','[]',now.toISOString());
  if(kind==='archive')fs.appendFileSync(claudeSessionFilePath('/tmp',session),'{}\n');
  if(kind==='task')db.prepare("UPDATE scheduled_tasks SET prompt='Changed task instruction' WHERE id=?").run(task);
  if(kind==='binding')db.prepare('UPDATE scheduled_tasks SET enabled=0 WHERE id=?').run(task);
  if(kind==='pending')db.prepare("UPDATE pending_turns SET status='pending' WHERE conversation_id=?").run(id);
  if(kind==='start'){db.exec('DROP TRIGGER purchase_start_no_delete');db.prepare('DELETE FROM purchase_worker_starts WHERE run_id=?').run(run);}
  if(kind==='pass')db.prepare('INSERT INTO purchase_worker_passes VALUES(?,?,?,?,?)').run(run,id,'unknown',null,now.toISOString());
  if(kind==='scope')db.prepare("INSERT INTO bot_decisions(id,conversation_id,source_key,proposal_key,proposal_json,assignee_id) VALUES(?,?,'fixture','fixture','{}',1)").run(crypto.randomUUID(),custodian);
  expect(()=>resume(reviewed.review_id,hash)).toThrow();expect(db.prepare('SELECT 1 FROM purchase_interrupted_dispositions').get()).toBeUndefined();
 });
 it('blocks unscoped UNKNOWN, unreleased portal and additional unresolved purchase fences',()=>{
  reviewInput.unscoped_unknown_present=true;expect(()=>review()).toThrow();reviewInput.unscoped_unknown_present=false;
  reviewInput.portal_is_idle_and_released=false;expect(()=>review()).toThrow();reviewInput.portal_is_idle_and_released=true;
  const reviewed=review() as {review_id:string};const otherRun=crypto.randomUUID();
  db.prepare("INSERT INTO scheduled_task_runs(id,scheduled_task_id,scheduled_for,trigger,status) VALUES(?,?,'2000-01-01','manual','failed')").run(otherRun,task);
  db.prepare("INSERT INTO purchase_event_batches(id,source_id,task_id,status,run_id,blocked_reason,created_at) VALUES(?,?,?,'blocked',?,'UNKNOWN_LAUNCH','2000-01-01')").run(crypto.randomUUID(),source,task,otherRun);
  expect(()=>resume(reviewed.review_id)).toThrow('OTHER_PURCHASE_RUN_FENCED');expect(db.prepare('SELECT 1 FROM purchase_interrupted_dispositions').get()).toBeUndefined();
 });
 it('pins shared voice and decision corrections alongside direct human messages',()=>{
  const reviewed=review() as {review_id:string};const hash=inspect().evidence_hash;
  db.prepare('INSERT INTO voice_dispatches(user_id,instruction_id,conversation_id,text) VALUES(1,?,?,?)').run('voice-correction',custodian,'Pause the existing task until source scope is checked again.');
  expect(()=>resume(reviewed.review_id,hash)).toThrow('FRESH_INTERRUPTED_REVIEW');
 });
 it('expires stale source/portal census and rejects missing full-scope assertions',()=>{
  reviewInput.attempt_census_complete=false;expect(()=>review()).toThrow();reviewInput.attempt_census_complete=true;
  const reviewed=review() as {review_id:string};now=new Date(now.getTime()+16*60_000);expect(()=>resume(reviewed.review_id)).toThrow('FRESH_SOURCE');
 });
 it('retains prior startup exclusions in hints, full scans and intake',()=>{
  const prior=event();acceptPurchaseEvent(db,source,prior);const oldRun=crypto.randomUUID(),oldBatch=crypto.randomUUID();
  db.prepare("INSERT INTO scheduled_task_runs(id,scheduled_task_id,scheduled_for,trigger,status) VALUES(?,?,'2000-01-01','manual','failed')").run(oldRun,task);
  db.prepare("INSERT INTO purchase_event_batches(id,source_id,task_id,status,run_id,blocked_reason,created_at) VALUES(?,?,?,'blocked',?,'WORKER_FAILED','2000-01-01')").run(oldBatch,source,task,oldRun);
  db.prepare('UPDATE purchase_event_links SET batch_id=? WHERE event_id=?').run(oldBatch,prior.id);
  db.prepare('INSERT INTO purchase_startup_dispositions VALUES(?,?,?,?,?,?,?,?)').run(oldRun,oldBatch,id,'a'.repeat(64),1,null,'Prior exact startup reconciliation',now.toISOString());
  const other=event();acceptPurchaseEvent(db,source,other);const reviewed=review() as {review_id:string};resume(reviewed.review_id);scheduler.tick();
  expect(posts[1]!.text).toContain(prior.order_id);expect(posts[1]!.text).not.toContain(prior.id);expect(()=>acceptPurchaseEvent(db,source,event(prior.order_id))).toThrow('FENCED');
 });
 it('keeps disposition order exclusions permanent independently of batch labels',()=>{
  const reviewed=review() as {review_id:string};resume(reviewed.review_id);
  // A label is mutable scheduling metadata, never evidence permitting another order attempt.
  db.prepare("UPDATE purchase_event_batches SET status='linked' WHERE run_id=?").run(run);
  expect(()=>acceptPurchaseEvent(db,source,event(original.order_id))).toThrow('FENCED');
  expect(()=>acceptPurchaseEvent(db,source,event(attempted.order_id))).toThrow('FENCED');
  const other=event();acceptPurchaseEvent(db,source,other);scheduler.tick();expect(posts[1]!.text).toContain(original.order_id);expect(posts[1]!.text).toContain(attempted.order_id);
 });
 it('does not dispatch attempted-only hints or clear a different interrupted run fence',()=>{
  acceptPurchaseEvent(db,source,attempted);const reviewed=review() as {review_id:string};resume(reviewed.review_id);for(let i=0;i<4;i++)scheduler.tick();expect(posts).toHaveLength(1);
  expect(scheduler.runNow(task)).toMatchObject({ok:false,error:'no_eligible_purchase_candidates'});
 });
 it('checks actual runner liveness and fails closed when native runtime is unavailable',async()=>{
  let live=true,unavailable=false;const app=express();app.use(express.json());app.use((req,_res,next)=>{req.user=db.prepare('SELECT * FROM users WHERE id=1').get() as typeof req.user;next();});
  app.use('/api/scheduled-tasks',createScheduledTasksRouter({db,config:{dataDir:dir},manager:{isLive:async()=>{if(unavailable)throw Error('native runner unavailable');return live;}}} as unknown as AppContext));
  const server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));const url=`http://127.0.0.1:${(server.address() as {port:number}).port}/api/scheduled-tasks/purchase-interrupted-recovery`;
  const post=()=>fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({run_id:run,mode:'inspect'})});
  try{expect((await post()).status).toBe(409);live=false;expect((await post()).status).toBe(200);unavailable=true;expect((await post()).status).toBe(503);}
  finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
 });
 it('publishes employee and resumed-agent setup limits without claiming staged activation',()=>{
  const f=botFeatureCatalog(Date.parse('2026-10-13')).features.find(f=>f.id==='purchase-interrupted-recovery')!;
  expect(f.steps.join(' ')).toContain('shared portal');expect(f.agent).toContain('recover_interrupted_purchase');expect(f.agent).toContain('persisted worker-start turn');expect(f.limits).toContain('Staged');
  expect(f.prompt).toBeUndefined();for(const elevated of [false,true])expect(coreVeneerRules({workspaceDir:'/repo',assistantSlug:'bot',elevated})).not.toContain(f.agent);expect(botFeatureInstructions()).not.toContain(f.agent);
 });
});
