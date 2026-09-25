import {createConversationManager} from '../src/runtime/conversationManager.js';
import type {ProviderAdapter} from '../src/providers/types.js';
import type {ConversationRow} from '../src/db/db.js';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Database from 'better-sqlite3';
import {it,expect,beforeEach,afterEach} from 'vitest';
import {EventEmitter} from 'node:events';
import {fileURLToPath} from 'node:url';
import {migrate} from '../src/db/migrate.js';
import {createBuildQueueCoordinator,type BuildQueueCoordinator} from '../src/buildQueue/coordinator.js';
import {recoverBuild} from '../src/buildQueue/recovery.js';
import type {MessageOrigin} from '../src/runtime/events.js';
let db:Database.Database,c:BuildQueueCoordinator,bus:EventEmitter,origin:MessageOrigin,live:boolean;
const turn='11111111-1111-4111-8111-111111111111';
function bind(id=turn){const result=db.prepare('INSERT INTO turn_origins(conversation_id,turn_id,prompt_text,event_at,origin_json) VALUES(?,?,?,?,?)').run('build',id,'fixture','2026-09-24T16:04:52.656Z',JSON.stringify(origin));bus.emit('event','build',{type:'turn_started',turnId:id,origin,role:'user',text:'fixture',at:'2026-09-24T16:04:52.656Z'});return Number(result.lastInsertRowid);}
beforeEach(()=>{db=new Database(':memory:');migrate(db,fileURLToPath(new URL('../src/db/migrations',import.meta.url)));db.prepare("INSERT INTO users(id,email,display_name,role) VALUES(1,'fixture@fixture.test','Fixture','owner')").run();const a=db.prepare("SELECT id FROM assistants WHERE slug='platform-dev'").get() as {id:number};db.prepare("INSERT INTO conversations(id,assistant_id,user_id,title,provider,native_session_id) VALUES('build',?,1,'Fixture','claude','fixture')").run(a.id);bus=new EventEmitter();live=false;c=createBuildQueueCoordinator({db,manager:{bus,isLive:()=>live,queueSnapshot:()=>({messages:[]}),postMessage:()=>{},dispatchBuild(conv,text,actor,o){origin=o;db.prepare('INSERT INTO queued_messages(conversation_id,prompt,origin_json,actor_user_id) VALUES(?,?,?,?)').run(conv.id,text,JSON.stringify(o),actor);}}});});
afterEach(()=>{c?.stop();db.close();});
it.each(['16:04:27','16:13:51'])('ignores unrelated terminal ordering %s before actual activation',()=>{
 c.enqueue('build','Fixture','Fixture');
 bus.emit('event','build',{type:'turn_started',turnId:'unrelated',role:'user',text:'hidden unrelated content',at:'2026-09-24T16:04:03Z'});
 bus.emit('event','build',{type:'turn_done',turnId:'unrelated',outcome:'completed'});bus.emit('status','build','failed');
 expect(db.prepare('SELECT status FROM build_queue').get()).toEqual({status:'running'});
 bind();bus.emit('event','build',{type:'turn_done',turnId:'unrelated',outcome:'failed'});expect(db.prepare('SELECT status FROM build_queue').get()).toEqual({status:'running'});
 bus.emit('event','build',{type:'turn_done',turnId:turn,outcome:'completed'});expect(db.prepare('SELECT status FROM build_queue').get()).toEqual({status:'done'});
});
it('retains dispatch across restart/new actual turn and rejects a delayed old completion or start',()=>{c.enqueue('build','Fixture','Fixture');const firstId=bind();const oldOrigin=origin;c.stop();live=true;c=createBuildQueueCoordinator({db,manager:{bus,isLive:()=>live,queueSnapshot:()=>({messages:[]}),postMessage:()=>{},dispatchBuild:()=>{throw Error('must not dispatch again');}}});c.start();const next='22222222-2222-4222-8222-222222222222';bind(next);bus.emit('event','build',{type:'turn_started',turnId:turn,origin:oldOrigin,role:'user',text:'fixture',at:'2026-09-24T16:04:52.656Z'});bus.emit('event','build',{type:'turn_done',turnId:turn,outcome:'completed'});expect(db.prepare('SELECT status FROM build_queue').get()).toEqual({status:'running'});bus.emit('event','build',{type:'turn_done',turnId:next,outcome:'completed'});expect(firstId).toBeGreaterThan(0);expect(db.prepare('SELECT status FROM build_queue').get()).toEqual({status:'done'});});
it('requires exact idle legacy recovery and preserves original job, audit and idempotency',()=>{
 db.prepare("INSERT INTO build_queue(id,user_id,conversation_id,title,brief,status,started_at,finished_at) VALUES(295,1,'build','Preserved','Original brief','done','2026-09-24 16:04:03','2026-09-24 16:04:27')").run();
 origin={kind:'build_queue',from:'Build queue',to:'platform-dev'};const id=bind();
 const p={job_id:295,origin_id:id,turn_id:turn,expected_finished_at:'2026-09-24 16:04:27',request_key:'exact-recovery',mode:'recover_done',reason:'User reviewed exact legacy metadata pairing'};
 expect(()=>recoverBuild(db,p,2,null,()=>false)).toThrow('owner');
 expect(()=>recoverBuild(db,p,1,null,()=>true)).toThrow('idle');
 expect(recoverBuild(db,{...p,mode:'review'},1,null,()=>false)).toMatchObject({done_recovery_ready:true});
 expect(db.prepare('SELECT status FROM build_queue').get()).toEqual({status:'done'});
 recoverBuild(db,p,1,null,()=>false);expect(recoverBuild(db,p,1,null,()=>false)).toMatchObject({existing:true});
 expect(()=>recoverBuild(db,{...p,reason:'Changed review reason'},1,null,()=>false)).toThrow('conflict');
 expect(db.prepare('SELECT id,brief,status FROM build_queue').get()).toEqual({id:295,brief:'Original brief',status:'queued'});
 expect(()=>db.prepare("UPDATE build_recoveries SET turn_id='changed'").run()).toThrow('Immutable');
});
it('denies legacy recovery with queued/pending work, stale finish timestamp or wrong origin',()=>{
 db.prepare("INSERT INTO build_queue(id,user_id,conversation_id,title,brief,status,finished_at) VALUES(298,1,'build','Fixture','Fixture','done','2026-09-24 16:13:51')").run();
 const result=db.prepare("INSERT INTO turn_origins(conversation_id,turn_id,prompt_text,event_at,origin_json) VALUES('build',?,'fixture','2026-09-24T16:13:51.526Z',?)").run(turn,JSON.stringify({kind:'wakeup',from:'Wake',to:'fixture'}));
 const p={job_id:298,origin_id:Number(result.lastInsertRowid),turn_id:turn,expected_finished_at:'2026-09-24 16:13:51',request_key:'blocked',mode:'recover_done',reason:'Reviewed exact metadata'};
 expect(()=>recoverBuild(db,p,1,null,()=>false)).toThrow('origin');
 db.prepare("UPDATE turn_origins SET origin_json=?").run(JSON.stringify({kind:'build_queue',from:'Build queue',to:'fixture'}));
 db.prepare("INSERT INTO queued_messages(conversation_id,prompt) VALUES('build','unrelated')").run();expect(()=>recoverBuild(db,p,1,null,()=>false)).toThrow('idle');
});
it('adopts only the explicitly selected current legacy build turn for this caller',()=>{
 db.prepare("INSERT INTO build_queue(id,user_id,conversation_id,title,brief,status) VALUES(300,1,'build','Fixture','Fixture','running')").run();
 origin={kind:'build_queue',from:'Build queue',to:'platform-dev'};const id=bind();
 db.prepare('INSERT INTO pending_turns(conversation_id,prompt,actor_user_id,origin_json) VALUES(?,?,?,?)').run('build','fixture',1,JSON.stringify(origin));
 const p={job_id:300,origin_id:id,turn_id:turn,expected_finished_at:null,request_key:'adopt-once',mode:'adopt_active',reason:'Adopt this exact live rollout activation'};
 expect(()=>recoverBuild(db,p,1,'foreign',()=>true)).toThrow('Adoption');
 recoverBuild(db,p,1,'build',()=>true);bus.emit('event','build',{type:'turn_done',turnId:'unrelated',outcome:'completed'});expect(db.prepare('SELECT status FROM build_queue').get()).toEqual({status:'running'});
 bus.emit('event','build',{type:'turn_done',turnId:turn,outcome:'completed'});expect(db.prepare('SELECT status FROM build_queue').get()).toEqual({status:'done'});
});

it('serializes exact recovery against a real competing writer',async()=>{
 db.prepare("INSERT INTO build_queue(id,user_id,conversation_id,title,brief,status,finished_at) VALUES(295,1,'build','Fixture','Fixture','done','2026-09-24 16:04:27')").run();origin={kind:'build_queue',from:'Build queue',to:'platform-dev'};const id=bind();
 const p={job_id:295,origin_id:id,turn_id:turn,expected_finished_at:'2026-09-24 16:04:27',request_key:'recover-race',mode:'recover_done',reason:'Reviewed exact legacy metadata'};
 const dir=mkdtempSync(join(tmpdir(),'build-recovery-')),path=join(dir,'fixture.sqlite');await db.backup(path);const primary=new Database(path,{timeout:0}),other=new Database(path,{timeout:0});let raced=false;
 try{primary.function('race',()=>{raced=true;expect(()=>recoverBuild(other,p,1,null,()=>false)).toThrow(/locked/);return 1;});primary.exec('CREATE TRIGGER recovery_race BEFORE INSERT ON build_recoveries BEGIN SELECT race(); END');recoverBuild(primary,p,1,null,()=>false);expect(raced).toBe(true);expect(recoverBuild(other,p,1,null,()=>false)).toMatchObject({existing:true});expect(primary.prepare('SELECT count(*) n FROM build_recoveries').get()).toEqual({n:1});}finally{primary.close();other.close();rmSync(dir,{recursive:true,force:true});}
});

it('binds the real manager queued build only after an unrelated in-flight turn finishes',async()=>{
 c.stop();const runs:Array<()=>void>=[];
 const adapter:ProviderAdapter={id:'claude',mintSessionId:()=>'',readTranscript:async()=>[],runTurn(spec,onEvent){let finish!:()=>void;const done=new Promise<void>(resolve=>{finish=()=>{onEvent({type:'turn_done',turnId:spec.turnId});resolve();};});runs.push(finish);return {done,kill:finish,respondToApproval:()=>true};}};
 const manager=createConversationManager({db,adapters:{claude:adapter},resolveWorkspace:()=>({workspaceDir:'/tmp',assistantSlug:'fixture',elevated:false,fullAccess:false}),log:{warn:()=>{},error:()=>{}}});
 const flush=()=>new Promise(resolve=>setImmediate(resolve));
 try{
  const conv=db.prepare("SELECT * FROM conversations WHERE id='build'").get() as ConversationRow;
  manager.postMessage(conv,'Unrelated synthetic work');await flush();
  // Reproduce a stale idle observation at coordinator dispatch; manager correctly queues it.
  c=createBuildQueueCoordinator({db,manager:{bus:manager.bus,postMessage:manager.postMessage,dispatchBuild:manager.dispatchBuild,isLive:()=>false,queueSnapshot:manager.queueSnapshot}});
  c.enqueue('build','Fixture build','Only this activation may finish the job');
  expect(db.prepare('SELECT current_turn_id FROM build_dispatches').get()).toEqual({current_turn_id:null});
  runs[0]!();await flush();await flush();expect(db.prepare('SELECT status FROM build_queue').get()).toEqual({status:'running'});
  expect((db.prepare('SELECT current_turn_id FROM build_dispatches').get() as {current_turn_id:string}).current_turn_id).toBeTruthy();
  runs[1]!();await flush();expect(db.prepare('SELECT status FROM build_queue').get()).toEqual({status:'done'});
  expect(db.prepare("SELECT count(*) n FROM hub_inbound_messages WHERE idempotency_key LIKE 'build:%'").get()).toEqual({n:1});
 }finally{manager.shutdown();await flush();}
});

it('reserves the WAL writer before reading inbound receipts and delivers only once', async () => {
 c.stop();
 const dir=mkdtempSync(join(tmpdir(),'inbound-contention-')),file=join(dir,'fixture.sqlite');
 await db.backup(file);
 const other=new Database(file,{timeout:0});
 other.pragma('journal_mode = WAL');
 let attempted=false, competingCode:string|undefined;
 const primary=new Database(file,{verbose(sql){
  // A second service tries to commit after the receipt read, before the insert.
  if(!attempted && sql.startsWith('INSERT INTO queued_messages')){
   attempted=true;
   try {other.prepare("INSERT INTO settings(key,value_json) VALUES('competing-writer','true')").run();}
   catch(error){competingCode=(error as {code:string}).code;}
  }
 }});
 const adapter:ProviderAdapter={id:'claude',mintSessionId:()=>'',readTranscript:async()=>[],runTurn(){let finish!:()=>void;const done=new Promise<void>(resolve=>{finish=resolve;});return {done,kill:finish,respondToApproval:()=>true};}};
 const manager=createConversationManager({db:primary,adapters:{claude:adapter},resolveWorkspace:()=>({workspaceDir:'/tmp',assistantSlug:'fixture',elevated:false,fullAccess:false}),log:{warn:()=>{},error:()=>{}}});
 try {
  const conv=primary.prepare("SELECT * FROM conversations WHERE id='build'").get() as ConversationRow;
  const first=manager.deliverWakeup(conv,'Contention fixture','contention-fixture');
  const duplicate=manager.deliverWakeup(conv,'Contention fixture','contention-fixture');
  expect(attempted).toBe(true);
  expect(competingCode).toBe('SQLITE_BUSY');
  expect(duplicate).toMatchObject({messageId:first.messageId,disposition:'duplicate'});
  expect(primary.prepare('SELECT count(*) n FROM hub_inbound_messages').get()).toEqual({n:1});
  // Once persistence commits, the other service can write normally.
  other.prepare("INSERT INTO settings(key,value_json) VALUES('after-delivery','true')").run();
 } finally {
  manager.shutdown();await new Promise(resolve=>setImmediate(resolve));
  primary.close();other.close();rmSync(dir,{recursive:true,force:true});
 }
});
