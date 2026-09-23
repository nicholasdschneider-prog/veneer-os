import Database from 'better-sqlite3';
import {beforeEach,afterEach,it,expect} from 'vitest';
import {fileURLToPath} from 'node:url';
import {migrate} from '../src/db/migrate.js';
import {createBotService,proposalSchema,type Actor} from '../src/bots/service.js';
import {returnExceptionService,type ReturnCapture,type ReturnInterpretation} from '../src/bots/returnException.js';
import {canonicalSha256} from '../src/bots/canonical.js';
import type {UserRow} from '../src/db/db.js';
let db:Database.Database,s:ReturnType<typeof returnExceptionService>,human:Actor,bot:Actor,spec:ReturnInterpretation,trustId:string,time:number;
const identity={clientId:'fixture-service',audience:'fixture-audience'};
function source():ReturnCapture{return {schema_version:'orderops-return-source/v1',trust_id:trustId,request_key:'mapping-once',captured_at:new Date(time).toISOString(),source_revision:'rev1',account_id:'fixture-account',principal_id:'own-principal',enrollment_revision:'enroll1',completeness:'complete-parent-and-child-material/v1',lease:{canonical_case:'case',principal_id:'own-principal',expires_at:new Date(time+60000).toISOString(),revision:'lease1'},conversation:{id:'case',customer_id:'customer',order_id:'order',binding_version:'binding1',binding_kind:'persisted'},order:{id:'order',number:'100',shopify_order_id:'shopify',version:'c'.repeat(64),items:[{id:'native-item',order_id:'order',shopify_line_id:'line',sku:'SKU',quantity:3}]},draft:{id:'draft',order_id:'order',conversation_id:'case',version:'d'.repeat(64),type:'return',state:'draft',selected_items:[],policy_snapshot_hash:'a'.repeat(64)}};}
function mapped(){const capture=source();capture.draft.selected_items=[{order_item_id:'native-item',quantity:1}];const m=s.map(identity,capture);return {m,capture,args:{mapping_id:m.mappingId,request_key:'submission-once',scope_hash:m.scopeHash,source_capture:capture}};}
beforeEach(()=>{
 time=Date.parse('2026-09-23T18:00:00Z');db=new Database(':memory:');db.pragma('foreign_keys=ON');migrate(db,fileURLToPath(new URL('../src/db/migrations',import.meta.url)));
 db.prepare("INSERT INTO users(id,email,display_name,role) VALUES(1,'owner@example.test','Owner','owner'),(2,'approver@example.test','Approver','member')").run();db.prepare("INSERT INTO business_teams(id,name,owner_id) VALUES('team','Fixture',1)").run();db.prepare("INSERT INTO business_team_members VALUES('team',2,'member')").run();db.prepare("INSERT INTO conversations(id,assistant_id,user_id,title,provider,native_session_id,visibility,business_team_id) VALUES('avery',1,1,'Fixture','claude','fixture','team','team')").run();
 human={user:db.prepare('SELECT * FROM users WHERE id=1').get() as UserRow};bot={...human,conversationId:'avery'};const bots=createBotService(db);db.prepare("INSERT INTO bot_registrations(conversation_id,name,registered_by) VALUES('avery','Fixture',1)").run();
 const p=proposalSchema.parse({question:'Fixture unused return for one item?',recommendation:'Use existing draft, only window exception.',consequence:'No refund or other exceptions.',assignee_id:2,blocked_action:'Fixture only'});
 const d=bots.raise(bot,{source_key:'fixture',proposal_key:'v1',proposal:p});bots.answer({user:db.prepare('SELECT * FROM users WHERE id=2').get() as UserRow},d.id,1,'approval',{action:'approve',text:'Fixture approved',scope:'this_case'});
 const e=db.prepare("SELECT id FROM bot_decision_events WHERE decision_id=? AND kind='answered'").get(d.id) as {id:string};
 spec={decisionId:d.id,version:1,proposalHash:canonicalSha256(p),approvalEventId:e.id,businessId:'team',executorId:'avery',canonicalCase:'case',orderId:'order',orderNumber:'100',draftId:'draft',sku:'SKU',authorizedQty:1};
 s=returnExceptionService(db,{now:()=>time,interpretation:spec});trustId=s.enroll(human,{business_id:'team',executor_id:'avery',...{client_id:identity.clientId,audience:identity.audience},account_id:'fixture-account',principal_id:'own-principal',source_origin:'https://source.example.test',request_key:'trust'}).id;
});afterEach(()=>db.close());
it('preserves original approval and later source mapping; one item regardless of purchased quantity',()=>{
 const before=db.prepare('SELECT * FROM bot_decisions').get(),{m,args}=mapped();expect(m.scope.authorizedQty).toBe(1);expect(m.scope.orderItemId).toBe('native-item');expect(m.scope.refundAuthorized).toBe(false);expect(m.scope.allowNonreturnable).toBe(false);expect(m.scope.allowDamage).toBe(false);expect(m.scope.waiveShipping).toBe(false);
 const claim=s.claim(identity,args);expect(claim.execute).toBe(true);expect(s.claim(identity,args).execute).toBe(false);expect(s.reconcile(identity,args.request_key).id).toBe(claim.id);expect(db.prepare('SELECT * FROM bot_decisions').get()).toEqual(before);
 expect(()=>s.claim(identity,{...args,request_key:'new'})).toThrow('already claimed');expect(()=>db.prepare('DELETE FROM return_bridge_claims').run()).toThrow('Immutable');
});
it('revocation before claim denies; claim before revocation stays reconcilable without reusable authority',()=>{
 const {args}=mapped();s.revoke(human,trustId,'stop');expect(()=>s.claim(identity,args)).toThrow('revoked');
});
it('keeps successful claim after revocation, expiry and version change; same-key readback never reexecutes',()=>{
 const {args}=mapped(),c=s.claim(identity,args);s.revoke(human,trustId,'stop');time+=900000;db.prepare('UPDATE bot_decisions SET version=2').run();expect(s.claim(identity,args)).toMatchObject({id:c.id,execute:false});expect(s.reconcile(identity,args.request_key).execute).toBe(false);
 const receipt={request_key:args.request_key,scope_hash:args.scope_hash,local_submission_id:'local',local_committed_at:new Date(time).toISOString(),local_receipt_hash:'b'.repeat(64)};s.acknowledge(identity,receipt);s.acknowledge(identity,receipt);expect(()=>s.acknowledge(identity,{...receipt,local_submission_id:'other'})).toThrow('Conflicting');
});
it.each(['principal','case','order','draft','binding','ambiguous','quantity','stale','lease','extra'] as const)('rejects invalid source %s',kind=>{
 const c=source();if(kind==='principal')c.principal_id='foreign';if(kind==='case')c.conversation.id='foreign';if(kind==='order')c.order.id='foreign';if(kind==='draft')c.draft.id='foreign';if(kind==='binding')c.conversation.order_id='foreign';if(kind==='ambiguous')c.order.items.push({...c.order.items[0]!,id:'second',shopify_line_id:'second'});if(kind==='quantity')c.draft.selected_items=[{order_item_id:'native-item',quantity:2}];if(kind==='stale')c.captured_at=new Date(time-31000).toISOString();if(kind==='lease')c.lease.expires_at=new Date(time+10000).toISOString();if(kind==='extra')Object.assign(c,{eligible:true});expect(()=>s.map(identity,c)).toThrow();
});
it.each(['version','snapshot','approval','approver','executor'] as const)('denies changed native %s before claim',kind=>{
 const {args}=mapped();if(kind==='version')db.prepare('UPDATE bot_decisions SET version=2').run();if(kind==='snapshot')db.prepare("UPDATE bot_decisions SET proposal_json='{}'").run();if(kind==='approval')db.prepare("UPDATE bot_decisions SET answer_json='{}'").run();if(kind==='approver')db.prepare('DELETE FROM business_team_members WHERE user_id=2').run();if(kind==='executor')db.prepare('UPDATE bot_registrations SET active=0').run();expect(()=>s.claim(identity,args)).toThrow();
});
it('rejects foreign service, bot enrollment, stale mapping and capture drift',()=>{
 const {args}=mapped();expect(()=>s.claim({...identity,clientId:'other'},args)).toThrow();expect(()=>s.enroll(bot,{})).toThrow();const changed=structuredClone(args);changed.source_capture.order.version='e'.repeat(64);expect(()=>s.claim(identity,changed)).toThrow('drift');time+=31000;expect(()=>s.claim(identity,args)).toThrow('stale');
});

it('retains raw nullable and whitespace SKUs; never normalizes target identity',()=>{
 const c=source();c.order.items.push({id:'other',order_id:'order',shopify_line_id:'other',sku:null,quantity:1});
 expect(s.map(identity,c).scope.orderItemId).toBe('native-item');
 c.request_key='whitespace';c.order.items[0]!.sku=' SKU ';expect(()=>s.map(identity,c)).toThrow('unique');
});
it('allows fresh unclaimed remap at submit, then permanently rejects a second mapping claim',()=>{
 const first=mapped();const next=source();next.request_key='submit-map';next.draft.version='e'.repeat(64);next.draft.selected_items=[{order_item_id:'native-item',quantity:1}];next.lease.revision='renewed';
 const m=s.map(identity,next);const args={mapping_id:m.mappingId,scope_hash:m.scopeHash,request_key:'pending-intent',source_capture:next};
 expect(s.claim(identity,args).execute).toBe(true);
 expect(s.reconcile(identity,'pending-intent')).toMatchObject({execute:false,authorized_submission:true,same_pending_intent_may_complete:true,external_effects_authorized_by_reconcile:false});
 expect(()=>s.claim(identity,first.args)).toThrow('already claimed');
 expect(()=>s.map(identity,next)).toThrow('Already claimed');
 expect(m.audience).toBe(identity.audience);expect(m.serviceClientId).toBe(identity.clientId);
});

it('does not allow an empty reservation mapping to become a submission claim',()=>{
 const capture=source(),m=s.map(identity,capture);
 expect(()=>s.claim(identity,{mapping_id:m.mappingId,scope_hash:m.scopeHash,request_key:'empty-submit',source_capture:capture})).toThrow('singleton');
});
it('persists a unique claim across connections and restart with competing same/different keys',async()=>{
 const {mkdtempSync,rmSync}=await import('node:fs'),{tmpdir}=await import('node:os'),{join}=await import('node:path');
 const dir=mkdtempSync(join(tmpdir(),'return-bridge-')),path=join(dir,'fixture.db'),{args}=mapped();
 await db.backup(path);
 const left=new Database(path),right=new Database(path);
 try {
  const a=returnExceptionService(left,{now:()=>time,interpretation:spec}),b=returnExceptionService(right,{now:()=>time,interpretation:spec});
  const results=await Promise.allSettled([Promise.resolve().then(()=>a.claim(identity,args)),Promise.resolve().then(()=>b.claim(identity,{...args,request_key:'competitor'}))]);
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  expect(b.claim(identity,args).execute).toBe(false);
 } finally {left.close();right.close();}
 const reopened=new Database(path);
 try {expect(returnExceptionService(reopened,{now:()=>time,interpretation:spec}).reconcile(identity,args.request_key)).toMatchObject({execute:false,authorized_submission:true});}
 finally {reopened.close();rmSync(dir,{recursive:true,force:true});}
});
it('rejects absent dedicated HTTP identity and isolates authenticated service bindings',async()=>{
 const express=(await import('express')).default,{returnExceptionRoutes}=await import('../src/bots/returnExceptionRoutes.js');
 const ctx={db,config:{}} as import('../src/context.js').AppContext;
 for(const accepted of [false,true]){
  const app=express();app.use('/verify',returnExceptionRoutes(ctx,async()=>accepted?{clientId:'foreign',audience:identity.audience}:null));
  const server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));
  try {
   const address=server.address() as import('node:net').AddressInfo;
   const r=await fetch('http://127.0.0.1:'+address.port+'/verify/mappings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(source())});
   expect(r.status).toBe(accepted?403:401);expect(r.headers.get('cache-control')).toBe('no-store');
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
 }
});
