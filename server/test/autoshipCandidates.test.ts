import {createConversationManager} from '../src/runtime/conversationManager.js';
import type {ProviderAdapter} from '../src/providers/types.js';
import type {ConversationRow} from '../src/db/db.js';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Database from 'better-sqlite3';
import {beforeEach,afterEach,it,expect} from 'vitest';
import {fileURLToPath} from 'node:url';
import {migrate} from '../src/db/migrate.js';
import {autoshipCandidates,CANDIDATE_WORKER as worker,CANDIDATE_BUSINESS as business,candidateWakeAllowed,startQueuedCandidate} from '../src/botWorkflows/autoshipCandidates.js';
import type {Actor} from '../src/bots/service.js';
import type {UserRow} from '../src/db/db.js';
let db:Database.Database,s:ReturnType<typeof autoshipCandidates>,owner:Actor,sourceId:string;
const identity={clientId:'candidate-client',audience:'candidate-audience'};
const registration={business_id:business,recipient_id:worker,account_id:'fixture-account',source_origin:'https://source.example.test',client_id:identity.clientId,audience:identity.audience,request_key:'fixture-source-v1'};
const event=()=>({schema_version:'autoship-candidate/v1',source_id:sourceId,event_id:'evt1',candidate_id:'candidate1',order_id:'11111111-1111-4111-8111-111111111111',order_revision:'revision1',occurred_at:'2026-09-24T12:00:00Z',business_id:business,recipient_id:worker,account_id:'fixture-account',kind:'order.new_candidate'});
beforeEach(()=>{db=new Database(':memory:');db.pragma('foreign_keys=ON');migrate(db,fileURLToPath(new URL('../src/db/migrations',import.meta.url)));db.prepare("INSERT INTO users(id,email,display_name,role) VALUES(1,'owner@fixture.test','Owner','owner'),(2,'other@fixture.test','Other','member')").run();db.prepare("INSERT INTO business_teams(id,name,owner_id) VALUES(?,'Fixture',1)").run(business);db.prepare("INSERT INTO conversations(id,assistant_id,user_id,title,provider,native_session_id,visibility,business_team_id) VALUES(?,1,1,'Fixture','claude','fixture','team',?)").run(worker,business);db.prepare("INSERT INTO bot_registrations(conversation_id,name,registered_by) VALUES(?,'Fixture',1)").run(worker);owner={user:db.prepare('SELECT * FROM users WHERE id=1').get() as UserRow};s=autoshipCandidates(db);sourceId=s.enroll(owner,registration,identity).id;});
afterEach(()=>db.close());
it('durably accepts exactly one candidate/wake and returns original receipt on replay or lost-response GET',()=>{const r=s.accept(identity,event());expect(r.shipping_authority).toBe(false);expect(s.accept(identity,event())).toEqual(r);expect(s.reconcile(identity,sourceId,'evt1').receipt).toEqual(r);expect(db.prepare('SELECT count(*) n FROM conversation_wakeups').get()).toEqual({n:1});expect(()=>s.accept(identity,{...event(),order_revision:'changed'})).toThrow('Conflicting');expect(()=>db.prepare("UPDATE autoship_candidate_events SET event_id='other'").run()).toThrow('Immutable');expect(candidateWakeAllowed(db,r.delivery_id)).toBe(true);});
it('rejects foreign identity/business/account/recipient/order and missing stock confirmation',()=>{expect(()=>s.accept({clientId:'foreign',audience:identity.audience},event())).toThrow('identity');for(const patch of [{business_id:'foreign'},{recipient_id:'foreign'},{account_id:'other'},{order_id:'not-a-uuid'},{kind:'stock.newly_eligible'}])expect(()=>s.accept(identity,{...event(),...patch})).toThrow();const r=s.accept(identity,{...event(),kind:'stock.newly_eligible',stock_change:{inventory_item_id:'item1',location_id:'location1',evidence_kind:'confirmed_receipt',evidence_id:'receipt1',revision:'r1',confirmed_at:'2026-09-24T11:59:00Z'}});expect(r.delivery_id).toBeTruthy();});
it('requires real current owner and dedicated identity; prevents registration retry drift',()=>{expect(()=>s.enroll({...owner,conversationId:worker},registration,identity)).toThrow('owner');expect(()=>s.enroll({user:db.prepare('SELECT * FROM users WHERE id=2').get() as UserRow},registration,identity)).toThrow('owner');expect(()=>s.enroll(owner,registration,null)).toThrow('configured');expect(s.enroll(owner,registration,identity).id).toBe(sourceId);expect(()=>s.enroll(owner,{...registration,account_id:'different'},identity)).toThrow('Conflicting');});
it('serializes revoke-before-delivery and queued-start, but retains readonly receipt after revocation',()=>{const r=s.accept(identity,event());db.prepare("INSERT INTO hub_inbound_messages(idempotency_key,conversation_id,message_id,source_kind) VALUES(?,?,7,'wakeup')").run('wakeup:'+r.delivery_id,worker);s.revoke(owner,sourceId,'stop');expect(candidateWakeAllowed(db,r.delivery_id)).toBe(false);expect(startQueuedCandidate(db,worker,7)).toBe(false);expect(db.prepare('SELECT count(*) n FROM autoship_candidate_starts').get()).toEqual({n:0});expect(()=>s.accept(identity,event())).toThrow('revoked');expect(s.reconcile(identity,sourceId,'evt1').receipt).toEqual(r);expect(()=>s.reconcile({clientId:'other',audience:identity.audience},sourceId,'evt1')).toThrow('identity');expect(db.prepare('SELECT status FROM conversation_wakeups').get()).toEqual({status:'cancelled'});});
it('records start-before-revoke without treating notification as an external shipping result',()=>{const r=s.accept(identity,event());db.prepare("INSERT INTO hub_inbound_messages(idempotency_key,conversation_id,message_id,source_kind) VALUES(?,?,7,'wakeup')").run('wakeup:'+r.delivery_id,worker);expect(startQueuedCandidate(db,worker,7)).toBe(true);expect(startQueuedCandidate(db,worker,7)).toBe(true);expect(db.prepare('SELECT count(*) n FROM autoship_candidate_starts').get()).toEqual({n:1});s.revoke(owner,sourceId,'stop');expect(startQueuedCandidate(db,worker,7)).toBe(false);expect(s.reconcile(identity,sourceId,'evt1').receipt.shipping_authority).toBe(false);});
it('rechecks owner and worker access at dispatch',()=>{const r=s.accept(identity,event());db.prepare('UPDATE bot_registrations SET active=0').run();expect(candidateWakeAllowed(db,r.delivery_id)).toBe(false);db.prepare('UPDATE bot_registrations SET active=1').run();db.prepare('UPDATE business_teams SET owner_id=2').run();expect(candidateWakeAllowed(db,r.delivery_id)).toBe(false);expect(()=>s.accept(identity,event())).toThrow('owner');});

it('serializes real competing connections during acceptance and queued-start revocation',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'candidate-race-')),path=join(dir,'fixture.sqlite');await db.backup(path);
 const other=new Database(path,{timeout:0}),primary=new Database(path,{timeout:0}),a=autoshipCandidates(primary),b=autoshipCandidates(other);let raced=false;
 try {
  primary.function('compete',()=>{raced=true;expect(()=>b.accept(identity,event())).toThrow(/locked/);return 1;});
  primary.exec('CREATE TRIGGER acceptance_race BEFORE INSERT ON autoship_candidate_events BEGIN SELECT compete(); END');
  const r=a.accept(identity,event());expect(raced).toBe(true);expect(b.accept(identity,event())).toEqual(r);
  primary.exec('DROP TRIGGER acceptance_race');
  primary.prepare("INSERT INTO hub_inbound_messages(idempotency_key,conversation_id,message_id,source_kind) VALUES(?,?,9,'wakeup')").run('wakeup:'+r.delivery_id,worker);
  primary.function('revoke_race',()=>{expect(()=>b.revoke(owner,sourceId,'concurrent')).toThrow(/locked/);return 1;});
  primary.exec('CREATE TRIGGER start_race BEFORE INSERT ON autoship_candidate_starts BEGIN SELECT revoke_race(); END');
  expect(startQueuedCandidate(primary,worker,9)).toBe(true);b.revoke(owner,sourceId,'concurrent');expect(startQueuedCandidate(primary,worker,9)).toBe(false);
  expect(b.reconcile(identity,sourceId,'evt1').delivery).toMatchObject({source_revoked:true,worker_started:true,shipping_authority:false});
 }finally{primary.close();other.close();rmSync(dir,{recursive:true,force:true});}
});

it('uses the real manager durable wake receipt and suppresses revoked queued work without interrupting unrelated work',async()=>{
 const runs:Array<{prompt:string;finish:()=>void}>=[];
 const adapter:ProviderAdapter={id:'claude',mintSessionId:()=>'',readTranscript:async()=>[],runTurn(spec,onEvent){let finish!:()=>void;const done=new Promise<void>(resolve=>{finish=()=>{onEvent({type:'turn_done',turnId:spec.turnId});resolve();};});runs.push({prompt:spec.prompt,finish});return {done,kill:finish,respondToApproval:()=>true};}};
 const manager=createConversationManager({db,adapters:{claude:adapter},resolveWorkspace:()=>({workspaceDir:'/tmp',assistantSlug:'fixture',elevated:false,fullAccess:false}),log:{warn:()=>{},error:()=>{}}});
 const flush=()=>new Promise(resolve=>setImmediate(resolve));
 try{
  const conv=db.prepare('SELECT * FROM conversations WHERE id=?').get(worker) as ConversationRow;
  manager.postMessage(conv,'Unrelated fixture work');await flush();
  const r=s.accept(identity,event());const w=db.prepare('SELECT reason FROM conversation_wakeups WHERE id=?').get(r.delivery_id) as {reason:string};
  expect(manager.deliverWakeup(conv,w.reason,r.delivery_id,1).disposition).toBe('queued');
  expect(manager.deliverWakeup(conv,w.reason,r.delivery_id,1).disposition).toBe('duplicate');
  s.revoke(owner,sourceId,'stop before candidate starts');runs[0]!.finish();await flush();await flush();
  expect(runs).toHaveLength(1);expect(db.prepare('SELECT count(*) n FROM queued_messages').get()).toEqual({n:0});
  expect(db.prepare('SELECT count(*) n FROM autoship_candidate_starts').get()).toEqual({n:0});
 }finally{manager.shutdown();await flush();}
});
