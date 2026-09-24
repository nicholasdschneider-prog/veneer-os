import Database from 'better-sqlite3';
import {beforeEach,afterEach,describe,it,expect} from 'vitest';
import {fileURLToPath} from 'node:url';
import express from 'express';
import {migrate} from '../src/db/migrate.js';
import {createBotService,proposalSchema,type Actor} from '../src/bots/service.js';
import {createDecisionHandoffs} from '../src/bots/decisionHandoffs.js';
import {createDecisionHandoffRouter} from '../src/bots/decisionHandoffRoutes.js';
import {employeeApiBoundary,employeeRouteAllowed} from '../src/bots/employeeAccess.js';
import {botWakeAllowed} from '../src/bots/delivery.js';
import type {UserRow,ConversationRow,ConversationWakeupRow} from '../src/db/db.js';
import type {AppContext} from '../src/context.js';
describe('decision thread investigations',()=>{
 let db:Database.Database,s:ReturnType<typeof createBotService>,h:ReturnType<typeof createDecisionHandoffs>,human:Actor,bot:Actor,target:Actor,id:string;
 const proposal=()=>proposalSchema.parse({question:'Check a fixture',recommendation:'Read the evidence',consequence:'No external action',blocked_action:'Do not execute',assignee_id:1,evidence:[]});
 beforeEach(()=>{
  db=new Database(':memory:');db.pragma('foreign_keys=ON');migrate(db,fileURLToPath(new URL('../src/db/migrations',import.meta.url)));
  for(const n of [1,2])db.prepare("INSERT INTO users(id,email,display_name,role) VALUES(?,?,?,'member')").run(n,`fixture${n}@example.test`,`Fixture ${n}`);
  for(const name of ['source','target','other'])db.prepare("INSERT INTO conversations(id,assistant_id,user_id,title,provider,native_session_id,visibility) VALUES(?,1,1,?,'claude',?,'team')").run(name,name,`native-${name}`);
  human={user:db.prepare('SELECT * FROM users WHERE id=1').get() as UserRow};bot={...human,conversationId:'source'};target={...human,conversationId:'target'};
  s=createBotService(db);s.register(human,'source','Source',true);h=createDecisionHandoffs(db);
  id=s.raise(bot,{source_key:'fixture',proposal_key:'fixture',proposal:proposal()}).id;
 });
 afterEach(()=>db.close());
 const request=(key='request')=>h.create(human,id,{request_key:key,expected_version:1,target_id:'target',text:'Investigate this bounded fixture'});
 it('creates one durable request/result without answering, changing version or importing instructions',()=>{
  const a=request(),b=request();expect(b).toEqual(a);
  expect(db.prepare('SELECT count(*) n FROM conversation_wakeups').get()).toEqual({n:1});
  expect(db.prepare('SELECT count(*) n FROM bot_discussion_instructions').get()).toEqual({n:0});
  expect(s.view(human,s.read(human,id))).toMatchObject({state:'needs_input',version:1,answer:null});
  expect(()=>s.recordDiscussionDecision(bot,id,a.id,1,'approve')).toThrow();
  const read=h.read(target,a.id);expect(read.context.request).toContain('bounded');expect(read.current_version).toBe(1);
  expect(()=>h.read(bot,a.id)).toThrow('selected thread');
  expect(()=>h.create(bot,id,{request_key:'bad',expected_version:1,target_id:'target',text:'Request'})).toThrow('human');
  expect(()=>h.create(human,id,{request_key:'request',expected_version:1,target_id:'other',text:'Changed'})).toThrow('different');
  h.report(target,a.id,{request_key:'result',text:'Verified fixture finding'});h.report(target,a.id,{request_key:'result',text:'Verified fixture finding'});
  expect(()=>h.report(target,a.id,{request_key:'other-result',text:'Changed'})).toThrow('already');
  expect(db.prepare('SELECT count(*) n FROM conversation_wakeups').get()).toEqual({n:2});
  expect((s.thread(human,id).messages as {text:string;actor_conversation_id:string;instruction_version:number|null}[]).at(-1)).toMatchObject({actor_conversation_id:'target',instruction_version:null});
  expect(s.view(human,s.read(human,id))).toMatchObject({state:'needs_input',version:1,answer:null});
  expect(()=>db.prepare("UPDATE bot_decision_handoffs SET request_text='rewrite'").run()).toThrow('immutable');
  expect(()=>db.prepare('DELETE FROM bot_decision_handoff_results').run()).toThrow('immutable');
 });
 it('rejects stale create but labels returned findings against their original version',()=>{
  const a=request();s.revise(bot,id,1,'revise',{...proposal(),question:'Changed scope'});
  expect(()=>h.create(human,id,{request_key:'new',expected_version:1,target_id:'target',text:'Old'})).toThrow('changed');
  expect(h.read(target,a.id)).toMatchObject({current_version:2,proposal_changed:true});
  h.report(target,a.id,{request_key:'result',text:'Old version findings'});
  expect((s.thread(human,id).messages as {text:string;actor_conversation_id:string;instruction_version:number|null}[]).at(-1)?.text).toContain('current v2; review changes');
 });
 it.each(['archive','requester','source-bot','target-bot','evidence','audience'])('rechecks %s access before wake/read/report',kind=>{
  if(kind==='target-bot')s.register(human,'target','Target',true);
  if(kind==='evidence'){
   s.revise(bot,id,1,'evidence',{...proposal(),evidence:[{conversation_id:'other',label:'Reference'}]});
  }
  const a=h.create(human,id,{request_key:'request',expected_version:kind==='evidence'?2:1,target_id:'target',text:'Read only'});
  const w=db.prepare('SELECT * FROM conversation_wakeups WHERE id=?').get(a.id) as ConversationWakeupRow;
  const c=db.prepare("SELECT * FROM conversations WHERE id='target'").get() as ConversationRow;
  expect(botWakeAllowed(db,w,c)).toBe(true);
  if(kind==='archive')db.prepare("UPDATE conversations SET archived=1 WHERE id='target'").run();
  if(kind==='requester')db.prepare("UPDATE users SET status='disabled' WHERE id=1").run();
  if(kind==='source-bot')db.prepare("UPDATE bot_registrations SET active=0 WHERE conversation_id='source'").run();
  if(kind==='target-bot')db.prepare("UPDATE bot_registrations SET active=0 WHERE conversation_id='target'").run();
  if(kind==='evidence')db.prepare("UPDATE conversations SET visibility='private' WHERE id='other'").run();
  if(kind==='audience')db.prepare("UPDATE conversations SET visibility='private' WHERE id='source'").run();
  expect(botWakeAllowed(db,w,c)).toBe(false);expect(()=>h.read(target,a.id)).toThrow();expect(()=>h.report(target,a.id,{request_key:'r',text:'No'})).toThrow();
 });
 it('filters foreign business and private evidence rather than granting access',()=>{
  db.prepare("INSERT INTO business_teams(id,name,owner_id) VALUES('a','A',1),('b','B',1)").run();
  db.prepare("UPDATE conversations SET business_team_id='a' WHERE id='source'").run();db.prepare("UPDATE conversations SET business_team_id='b' WHERE id='target'").run();
  expect(()=>request()).toThrow('Cross-business');expect(h.targets(human,id,'target')).toEqual([]);
 });
 it('checks the complete destination audience and historical source references',()=>{
  s.revise(bot,id,1,'evidence',{...proposal(),evidence:[{conversation_id:'other',label:'Old reference'}]});s.revise(bot,id,2,'new',proposal());
  db.prepare("UPDATE conversations SET visibility='private' WHERE id='other'").run();
  expect(()=>h.create(human,id,{request_key:'a',expected_version:3,target_id:'target',text:'Read'})).toThrow('current access');
 });
 it('serves restricted humans through narrow authenticated routes, never target result tools',async()=>{
  db.prepare('INSERT INTO employee_workspaces VALUES(1)').run();for(const c of ['source','target'])db.prepare('INSERT INTO employee_bot_access VALUES(1,?)').run(c);
  expect(employeeRouteAllowed('GET',`/bots/decisions/${id}/handoff-targets`)).toBe(true);
  expect(employeeRouteAllowed('POST','/bots/handoffs/x/result')).toBe(false);
  const app=express();app.use(express.json());app.use((req,_res,next)=>{req.user=human.user;next();});app.use('/api',employeeApiBoundary(db));app.use('/api/bots',createDecisionHandoffRouter({db} as AppContext));
  const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));const port=(server.address() as {port:number}).port;
  try{
   const list=await fetch(`http://127.0.0.1:${port}/api/bots/decisions/${id}/handoff-targets?q=target`);expect(list.status).toBe(200);expect((await list.json()).targets[0].id).toBe('target');
   const response=await fetch(`http://127.0.0.1:${port}/api/bots/decisions/${id}/handoffs`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({request_key:'http',expected_version:1,target_id:'target',text:'Read fixture'})});expect(response.status).toBe(200);
  }finally{await new Promise<void>(r=>server.close(()=>r()));}
 });
});
