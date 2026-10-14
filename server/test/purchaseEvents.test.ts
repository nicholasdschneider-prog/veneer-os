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
it('an uncertain launch does not stop later candidates, a restart or run-now',()=>{
 const p=event();acceptPurchaseEvent(db,source,p);fail=true;scheduler.tick();expect(posts).toHaveLength(1);
 expect(readPurchaseEvent(db,source,p.id).delivery).toMatchObject({status:'blocked',blocked_reason:'UNKNOWN_LAUNCH',worker_started:false});
 fail=false;const later=event();acceptPurchaseEvent(db,source,later);scheduler.tick();expect(posts).toHaveLength(2);expect(posts[1]!.text).toContain(later.id);
 bus.emit('event',posts[1]!.id,{type:'turn_done',outcome:'failed'});
 scheduler.stop();scheduler=createScheduledTaskScheduler({db,manager:{bus,postMessage:(conv,text)=>{posts.push({id:conv.id,text});}}});
 expect(scheduler.runNow(task).ok).toBe(true);
});
it('rejects revoked source/task/owner/team/project binding at read, intake and dispatch',()=>{
 const p=event();acceptPurchaseEvent(db,source,p);
 for(const [sql,restore] of [["UPDATE bot_event_sources SET enabled=0","UPDATE bot_event_sources SET enabled=1"],["UPDATE users SET status='disabled'","UPDATE users SET status='active'"],["UPDATE scheduled_tasks SET enabled=0","UPDATE scheduled_tasks SET enabled=1"],["UPDATE scheduled_tasks SET project_id=NULL",`UPDATE scheduled_tasks SET project_id='${project}'`]]){
 db.exec(sql);expect(()=>readPurchaseEvent(db,source,p.id)).toThrow('BINDING');expect(()=>acceptPurchaseEvent(db,source,event())).toThrow('BINDING');scheduler.tick();expect(posts).toHaveLength(0);db.exec(restore);
 }
});
it('a failed worker completion does not stop the next candidate',()=>{
 acceptPurchaseEvent(db,source,event());scheduler.tick();const next=event();acceptPurchaseEvent(db,source,next);
 bus.emit('event',posts[0]!.id,{type:'turn_done',outcome:'failed'});scheduler.tick();expect(posts).toHaveLength(2);expect(posts[1]!.text).toContain(next.id);
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
it('leaves an interrupted purchase turn to ordinary recovery without fencing the task',()=>{
 const p=event();acceptPurchaseEvent(db,source,p);scheduler.tick();
 const id=posts[0]!.id;
 db.prepare("INSERT INTO pending_turns(conversation_id,prompt,attempts,status) VALUES(?,'Synthetic interrupted prompt',1,'pending')").run(id);
 scheduler.stop();scheduler=createScheduledTaskScheduler({db,manager:{bus,postMessage:(conv,text)=>{posts.push({id:conv.id,text});}}});
 expect(db.prepare('SELECT status FROM pending_turns WHERE conversation_id=?').get(id)).toEqual({status:'pending'});
 expect(readPurchaseEvent(db,source,p.id).delivery).toMatchObject({status:'linked',blocked_reason:null});
 bus.emit('event',id,{type:'turn_done',outcome:'failed'});expect(scheduler.runNow(task).ok).toBe(true);
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
it('persists the real native manager turn-start and suppresses a revoked conversation restart',async()=>{
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
 db.prepare('UPDATE bot_event_sources SET enabled=0').run();
 const conv=db.prepare('SELECT * FROM conversations WHERE id=?').get(delivery.conversation_id) as Parameters<typeof manager.postMessage>[0];
 manager.postMessage(conv,'Synthetic replay must not execute');await flush();expect(runs).toBe(1);
 }finally{manager.shutdown();await flush();}
});

it.each(['unknown','blocked'] as const)('records an exact-worker %s pass without stopping the next run',(outcome)=>{
 const p=event();acceptPurchaseEvent(db,source,p);scheduler.tick();const id=posts[0]!.id;acceptPurchaseEvent(db,source,event());
 bus.emit('event',id,{type:'turn_started',turnId:crypto.randomUUID(),at:new Date().toISOString()});
 expect(()=>recordPurchasePass(db,id,2,{outcome:'clear'})).toThrow('WORKER');
 expect(()=>recordPurchasePass(db,crypto.randomUUID(),1,{outcome:'clear'})).toThrow('WORKER');
 recordPurchasePass(db,id,1,{outcome,cursor:'synthetic-cursor'});
 bus.emit('event',id,{type:'turn_done',outcome:'completed'});scheduler.tick();expect(posts).toHaveLength(2);
 expect(readPurchaseEvent(db,source,p.id).delivery.blocked_reason).toBe(outcome==='unknown'?'SOURCE_UNKNOWN':'SOURCE_BLOCKED');
});
it('a run without a pass record does not stop the next run',()=>{
 const p=event();acceptPurchaseEvent(db,source,p);scheduler.tick();acceptPurchaseEvent(db,source,event());
 bus.emit('event',posts[0]!.id,{type:'turn_started',turnId:crypto.randomUUID(),at:new Date().toISOString()});
 bus.emit('event',posts[0]!.id,{type:'turn_done',outcome:'completed'});scheduler.tick();expect(posts).toHaveLength(2);
 expect(readPurchaseEvent(db,source,p.id).delivery.status).toBe('linked');
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

it('refuses to delete a retained purchase run with a clear 409',async()=>{
 acceptPurchaseEvent(db,source,event());scheduler.tick();const run=(db.prepare('SELECT id FROM scheduled_task_runs').get() as {id:string}).id;startDone(posts[0]!.id);
 const app=express();app.use(express.json());
 app.use((req,_res,next)=>{req.user=db.prepare('SELECT * FROM users WHERE id=1').get() as typeof req.user;next();});
 app.use('/api/scheduled-tasks',createScheduledTasksRouter({db,manager:{}} as unknown as AppContext));
 const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));
 try{
  const res=await fetch(`http://127.0.0.1:${(server.address() as {port:number}).port}/api/scheduled-tasks/${task}/runs/${run}`,{method:'DELETE'});
  expect(res.status).toBe(409);expect(((await res.json()) as {error:string}).error).toContain('PURCHASE_RUN_RETAINED');
 }finally{await new Promise<void>(r=>server.close(()=>r()));}
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

import { botFeatureCatalog, botFeatureInstructions } from '../src/featureGuide/catalog.js';
import { coreVeneerRules } from '../src/instructions/context.js';
it('publishes the retired interrupted-purchase recovery without an injected prompt',()=>{
 const f=botFeatureCatalog(Date.parse('2026-10-14')).features.find(f=>f.id==='purchase-interrupted-recovery')!;
 expect(f.agent).toContain('recover_interrupted_purchase is retired');expect(f.agent).toContain('next run is the cron');
 expect(f.prompt).toBeUndefined();for(const elevated of [false,true])expect(coreVeneerRules({workspaceDir:'/repo',assistantSlug:'bot',elevated})).not.toContain(f.agent);expect(botFeatureInstructions()).not.toContain(f.agent);
});
