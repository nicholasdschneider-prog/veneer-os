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
 it('freshness pins native bytes even when changed evidence would otherwise pass',()=>{const hash=inspect().evidence_hash;rows[0]!.message.content[0].text+=' changed';save();expect(()=>release(hash)).toThrow('FRESH_STARTUP');});
});
