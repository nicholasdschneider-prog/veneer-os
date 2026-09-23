import Database from 'better-sqlite3';
import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import express from 'express';
import type { Server } from 'node:http';
import { migrate } from '../src/db/migrate.js';
import { createBotService, proposalSchema, type Actor } from '../src/bots/service.js';
import { communicationService } from '../src/bots/communication.js';
import { messageDelegationService } from '../src/bots/messageDelegation.js';
import { approvedMessageSchema } from '../src/bots/draftPayload.js';
import { createCommunicationRouter } from '../src/bots/communicationRoutes.js';
import type { AppContext } from '../src/context.js';
import type { UserRow } from '../src/db/db.js';

describe('exact approved message delegation',()=>{
 let db:Database.Database, bots:ReturnType<typeof createBotService>, s:ReturnType<typeof communicationService>, bridge:ReturnType<typeof messageDelegationService>, owner:Actor, executor:Actor, human:Actor;
 const servers:Server[]=[];
 const scope=()=>approvedMessageSchema.parse({canonical_case:'case-fixture',executor_conversation_id:'nora',payload:{channel:'email',account:'fixture-support',recipients:['customer@example.test'],subject:'Fixture explanation',body:'Exact approved body.\nNo repeated refund.',customer:'Fixture customer',ticket:'case-fixture',attachments:[{name:'context.pdf',reference:'case-fixture/immutable-context',sha256:'a'.repeat(64)}],context:'Email only'}});
 beforeEach(()=>{
  db=new Database(':memory:');db.pragma('foreign_keys=ON');migrate(db,fileURLToPath(new URL('../src/db/migrations',import.meta.url)));
  for(const id of [1,2,3])db.prepare("INSERT INTO users(id,email,display_name,role) VALUES(?,?,?,'owner')").run(id,`fixture${id}@example.test`,`Person ${id}`);
  db.prepare("INSERT INTO business_teams(id,name,owner_id) VALUES('team','Fixture business',1),('foreign','Other business',1)").run();
  db.prepare("INSERT INTO business_team_members(team_id,user_id,role) VALUES('team',2,'manager'),('team',3,'manager')").run();
  for(const id of ['grant','nora','outsider','foreign'])db.prepare("INSERT INTO conversations(id,assistant_id,user_id,title,provider,native_session_id,visibility,business_team_id) VALUES(?,1,1,?,'claude',?,'team',?)").run(id,id,id,id==='foreign'?'foreign':'team');
  const user=db.prepare('SELECT * FROM users WHERE id=1').get() as UserRow;owner={user,conversationId:'grant'};executor={user,conversationId:'nora'};human={user:db.prepare('SELECT * FROM users WHERE id=2').get() as UserRow};
  bots=createBotService(db);s=communicationService(db);bridge=messageDelegationService(db);for(const id of ['grant','nora','outsider','foreign'])db.prepare('INSERT INTO bot_registrations(conversation_id,name,active,registered_by) VALUES(?,?,1,1)').run(id,id);
 });
 afterEach(async()=>{for(const server of servers.splice(0))await new Promise<void>(resolve=>server.close(()=>resolve()));db.close();});
 function approved(structured=true){const d=bots.raise(owner,{source_key:'fixture',proposal_key:'v1',proposal:proposalSchema.parse({question:'Send this exact fixture message?',recommendation:'One message only.',consequence:'No financial action.',assignee_id:2,blocked_action:'EXACT DRAFT: legacy prose is not transport proof.',...(structured?{message_delivery:scope()}:{})})});bots.answer(human,d.id,1,'human-approved',{action:'approve',text:'Approved as proposed.',scope:'this_case'});return d.id;}
 function setup(){const id=approved();const g=bridge.delegate(owner,id,1,'nora','delegate-once',scope());const d=bridge.accept(executor,g.id,'accept-once',scope());return {id,g,d};}
 function running(id:string){db.prepare("UPDATE conversation_wakeups SET status='delivered' WHERE id IN (SELECT id FROM bot_decision_events WHERE decision_id=? AND kind='answered')").run(id);db.prepare("UPDATE bot_decisions SET state='action_pending' WHERE id=?").run(id);bots.result(owner,id,1,'owner-material-check',{state:'running',evidence:'Fixture current source checked',material_evidence_unchanged:true});}
 const checks=(hash:string)=>({payload_hash:hash,material_evidence_unchanged:true,recipient_account_case_verified:true,lease_and_duplicates_checked:true,evidence:'Fixture lease, recipient and duplicate scan verified'});
 function proof(draft:string,hash:string){return {provider:'fixture-provider',provider_message_id:'receipt-123',account:scope().payload.account,recipients:scope().payload.recipients,canonical_case:scope().canonical_case,payload_hash:hash,idempotency_key:`veneer-message:${draft}`,verified:true};}
 it('returns concrete legacy missing proof without draft/delegation/decision mutation',()=>{
  const id=approved(false);const before=db.prepare('SELECT * FROM bot_decisions WHERE id=?').get(id);const result=bridge.inspect(owner,id,1);expect(result.ready).toBe(false);expect(JSON.stringify(result)).toContain('legacy EXACT DRAFT');expect(()=>bridge.delegate(owner,id,1,'nora','missing',scope())).toThrow('needs proof');expect(db.prepare('SELECT count(*) n FROM bot_message_drafts').get()).toEqual({n:0});expect(db.prepare('SELECT count(*) n FROM bot_message_delegations').get()).toEqual({n:0});expect(db.prepare('SELECT * FROM bot_decisions WHERE id=?').get(id)).toEqual(before);
 });
 it('preserves the original approval and exact text through one owner delegation, acceptance and claim',()=>{
  const {id,g,d}=setup();expect(d.authorized_by).toBe(2);expect(d.conversation_id).toBe('nora');expect(JSON.parse(d.payload_json)).toEqual(scope().payload);expect(bridge.delegate(owner,id,1,'nora','delegate-once',scope()).id).toBe(g.id);expect(bridge.accept(executor,g.id,'accept-once',scope()).id).toBe(d.id);
  expect(()=>s.claim(executor,d.id,'claim',checks(g.payload_hash))).toThrow('RUNNING');running(id);expect(()=>s.claim(executor,d.id,'claim')).toThrow();const first=s.claim(executor,d.id,'claim',checks(g.payload_hash));expect(first.execute).toBe(true);expect(first.approval_source).toContain(g.approval_event_id);expect(s.claim(executor,d.id,'claim').execute).toBe(false);expect(()=>s.claim(executor,d.id,'different',checks(g.payload_hash))).toThrow('already');
  expect(()=>s.receipt(executor,d.id,'claim','sent','provider receipt')).toThrow();expect(()=>s.receipt(executor,d.id,'claim','sent','provider receipt',{...proof(d.id,g.payload_hash),provider_message_id:'unknown'})).toThrow();
  s.receipt(executor,d.id,'claim','uncertain','timeout');expect(()=>s.claim(executor,d.id,'retry',checks(g.payload_hash))).toThrow();s.receipt(executor,d.id,'claim','sent','reconciled provider receipt',proof(d.id,g.payload_hash));s.receipt(executor,d.id,'claim','sent','reconciled provider receipt',proof(d.id,g.payload_hash));expect(()=>s.receipt(executor,d.id,'claim','sent','reconciled provider receipt',{...proof(d.id,g.payload_hash),provider_message_id:'different'})).toThrow('duplicate');
  expect(db.prepare("SELECT count(*) n FROM bot_decision_events WHERE decision_id=? AND kind='answered'").get(id)).toEqual({n:1});expect((db.prepare('SELECT state FROM bot_decisions WHERE id=?').get(id) as {state:string}).state).toBe('running');
 });
 it.each(['body','recipients','account','ticket','attachments','subject'] as const)('rejects changed %s and conflicting acceptance keys',field=>{
  const {g,d}=setup();const changed=scope();Object.assign(changed.payload,{[field]:field==='attachments'?[]:field==='recipients'?['other@example.test']:changed.payload[field]+' '});expect(()=>bridge.accept(executor,g.id,'accept-once',changed)).toThrow('differs');expect(()=>bridge.accept(executor,g.id,'other-key',scope())).toThrow('already');expect(db.prepare('SELECT count(*) n FROM bot_message_drafts WHERE delegation_id=?').get(g.id)).toEqual({n:1});expect(d.id).toBeTruthy();
 });
 it('rejects changed canonical case, executor, other owner, foreign bots and request-key conflicts',()=>{
  const id=approved();expect(()=>bridge.delegate(executor,id,1,'nora','wrong-owner',scope())).toThrow();expect(()=>bridge.delegate(owner,id,1,'outsider','wrong-executor',scope())).toThrow();expect(()=>bridge.delegate({...owner,conversationId:'foreign'},id,1,'nora','foreign',scope())).toThrow();expect(()=>bridge.delegate(owner,id,1,'nora','case',{...scope(),canonical_case:'different'})).toThrow();const g=bridge.delegate(owner,id,1,'nora','once',scope());expect(()=>bridge.accept({...owner,conversationId:'outsider'},g.id,'foreign',scope())).toThrow();expect(()=>bridge.delegate(owner,id,1,'nora','twice',scope())).toThrow('already bound');
 });
 it.each(['approver','owner','executor','executor-owner','delegation'] as const)('revocation of %s blocks a queued claim',kind=>{
  const {id,g,d}=setup();running(id);
  if(kind==='approver')db.prepare("DELETE FROM business_team_members WHERE user_id=2").run();
  if(kind==='owner')db.prepare("UPDATE bot_registrations SET active=0 WHERE conversation_id='grant'").run();
  if(kind==='executor')db.prepare("UPDATE bot_registrations SET active=0 WHERE conversation_id='nora'").run();
  if(kind==='executor-owner')db.prepare("UPDATE conversations SET user_id=3 WHERE id='nora'").run();
  if(kind==='delegation')bridge.revoke(owner,g.id,'stop','Fixture revoke');
  expect(()=>s.claim(executor,d.id,'claim',checks(g.payload_hash))).toThrow();expect((db.prepare('SELECT state FROM bot_message_drafts WHERE id=?').get(d.id) as {state:string}).state).toBe('queued');
 });
 it('rejects revised or tampered approval snapshots and preserves immutable audits',()=>{
  const {id,g,d}=setup();expect(()=>db.prepare("UPDATE bot_message_delegations SET payload_hash='x' WHERE id=?").run(g.id)).toThrow('immutable');expect(()=>db.prepare('DELETE FROM bot_message_delegation_events WHERE delegation_id=?').run(g.id)).toThrow('immutable');
  const p=JSON.parse((db.prepare('SELECT proposal_json FROM bot_decisions WHERE id=?').get(id) as {proposal_json:string}).proposal_json);p.message_delivery.payload.body+=' tampered';db.prepare('UPDATE bot_decisions SET proposal_json=? WHERE id=?').run(JSON.stringify(p),id);expect(()=>s.claim(executor,d.id,'claim',checks(g.payload_hash))).toThrow('snapshot');
 });
 it('invalidates old version bindings after a genuine proposal revision',()=>{const {id,g,d}=setup();const p=proposalSchema.parse({...JSON.parse((db.prepare('SELECT proposal_json FROM bot_decisions WHERE id=?').get(id) as {proposal_json:string}).proposal_json),question:'Changed question'});bots.revise(owner,id,1,'new-evidence',p);expect(()=>bridge.accept(executor,g.id,'accept-once',scope())).toThrow('version');expect(()=>s.claim(executor,d.id,'claim',checks(g.payload_hash))).toThrow('version');});
 it('requires exact current send checks and prevents foreign/unknown delivery claims',()=>{const {id,g,d}=setup();running(id);expect(()=>s.claim(executor,d.id,'claim',{...checks(g.payload_hash),payload_hash:'0'.repeat(64)})).toThrow('hash');expect(()=>s.receipt(executor,d.id,'unknown','sent','fake',proof(d.id,g.payload_hash))).toThrow();s.claim(executor,d.id,'claim',checks(g.payload_hash));expect(()=>s.receipt(owner,d.id,'claim','sent','fake',proof(d.id,g.payload_hash))).toThrow();expect(()=>s.receipt(executor,d.id,'claim','sent','wrong case',{...proof(d.id,g.payload_hash),canonical_case:'other'})).toThrow();});
 it('serializes racing HTTP claims and accepts one execution only',async()=>{
  const {id,g,d}=setup();running(id);const app=express();app.use(express.json());app.use((req,_res,next)=>{req.user=executor.user;req.agentConversationId='nora';next();});app.use(createCommunicationRouter({db} as AppContext));const server=app.listen(0,'127.0.0.1');servers.push(server);await new Promise<void>(resolve=>server.once('listening',resolve));const port=(server.address() as {port:number}).port;
  const send=(key:string)=>fetch(`http://127.0.0.1:${port}/drafts/${d.id}/claim`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({claim_key:key,send_check:checks(g.payload_hash)})});
  const replies=await Promise.all([send('race-a'),send('race-b')]);expect(replies.map(r=>r.status).sort()).toEqual([200,409]);const bodies=await Promise.all(replies.map(r=>r.json()));expect(bodies.filter(r=>r.execute===true)).toHaveLength(1);expect(db.prepare("SELECT count(*) n FROM bot_message_delegation_events WHERE delegation_id=? AND kind='claimed'").get(g.id)).toEqual({n:1});
 });
 it('serializes racing delegation and acceptance requests without duplicate rows',async()=>{
  const id=approved();const app=express();app.use(express.json());app.use((req,_res,next)=>{req.user=owner.user;req.agentConversationId=req.header('x-fixture-bot')==='grant'?'grant':'nora';next();});app.use(createCommunicationRouter({db} as AppContext));const server=app.listen(0,'127.0.0.1');servers.push(server);await new Promise<void>(resolve=>server.once('listening',resolve));const port=(server.address() as {port:number}).port;
  const post=(bot:string,path:string,body:unknown)=>fetch(`http://127.0.0.1:${port}/approved-messages/${path}`,{method:'POST',headers:{'Content-Type':'application/json','x-fixture-bot':bot},body:JSON.stringify(body)});
  const delegates=await Promise.all([1,2].map(()=>post('grant','delegate',{decision_id:id,expected_version:1,executor_conversation_id:'nora',request_key:'race-delegate',scope:scope()})));expect(delegates.every(r=>r.status===200)).toBe(true);const gs=await Promise.all(delegates.map(r=>r.json()));expect(gs[0].id).toBe(gs[1].id);
  const accepts=await Promise.all([1,2].map(()=>post('nora','accept',{delegation_id:gs[0].id,request_key:'race-accept',scope:scope()})));expect(accepts.every(r=>r.status===200)).toBe(true);const ds=await Promise.all(accepts.map(r=>r.json()));expect(ds[0].id).toBe(ds[1].id);expect(db.prepare('SELECT count(*) n FROM bot_message_drafts').get()).toEqual({n:1});expect(db.prepare('SELECT count(*) n FROM bot_message_delegations').get()).toEqual({n:1});
 });
 it('keeps ordinary drafts unapproved and reports ownership mismatch separately from version mismatch',()=>{
  const id=approved(false);expect(()=>s.saveDraft(executor,'nora','ordinary',scope().payload,id,1)).toThrow('another bot');const d=s.saveDraft(owner,'grant','ordinary',scope().payload,id,1);expect(d.state).toBe('draft');expect(()=>s.claim(owner,d.id,'not-approved')).toThrow('authorization');expect(()=>s.saveDraft(owner,'grant','stale',scope().payload,id,2)).toThrow('proposal changed');
 });
});
