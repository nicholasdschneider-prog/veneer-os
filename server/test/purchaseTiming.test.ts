import Database from 'better-sqlite3';
import {beforeEach,afterEach,it,expect} from 'vitest';
import {fileURLToPath} from 'node:url';
import {migrate} from '../src/db/migrate.js';
import {createBotService,proposalSchema,type Actor} from '../src/bots/service.js';
import {purchaseTimingService} from '../src/bots/purchaseTiming.js';
import {timingClaimResponseSchema,timingVerifyResponseSchema,timingCaptureSchema,type TimingScope,type TimingRequest} from '../src/bots/purchaseTimingSchema.js';
import {canonicalJson,canonicalSha256} from '../src/bots/canonical.js';
import type {Config} from '../src/config.js';
import type {UserRow} from '../src/db/db.js';
import {captureHumanMessage} from '../src/bots/humanMessages.js';
import {purchaseTimingResolver,timingConfiguration,type TimingIdentity} from '../src/identity/purchaseTimingVerifier.js';
import type {IncomingMessage} from 'node:http';
let db:Database.Database,s:ReturnType<typeof purchaseTimingService>,bots:ReturnType<typeof createBotService>,human:Actor,bot:Actor,trustId:string,time:number;
const config={identity:'cloudflare',cfTeamDomain:'https://fixture.cloudflareaccess.com',cfAud:'human-aud',purchaseTimingCfAud:'timing-aud',purchaseTimingClientId:'timing-client'} as Config;
const identity:TimingIdentity={kind:'purchase_timing_verifier',clientId:'timing-client',audience:'timing-aud'};
const enrollment={request_key:'enroll-once',business_id:'team',executor_id:'sage',source_origin:'https://source.example.test',account_id:'account',principal_id:'source-worker',source_deployment:'deployed-v1',custody_receipt:'operator-reviewed-mapping-v1'};
function material():TimingScope{return {schema_version:'orderops-purchase-timing-material/v1',business_id:'team',account_id:'account',source_origin:enrollment.source_origin,principal_id:'source-worker',executor_id:bot.conversationId!,order_id:'order',order_number:'100',shopify_order_id:'shopify-order',lines:[{order_line_id:'line',shopify_line_id:'shopify-line',sku:'SKU643922',quantity:1}],amount_cents:3090,currency:'USD',original_delivery:{start:'2026-09-25',end:'2026-09-25'},checkout_delivery:{start:'2026-10-05',end:'2026-10-05'},timezone:'America/Indiana/Indianapolis',source_action_id:'action-1',source_proposal_version:'p1',material_version:'m1',cart_version:'c1',material_fingerprint:'a'.repeat(64),authorization_expires_at:new Date(time+3600000).toISOString()};}
function capture(scope=material(),key='capture-1'){return s.capture(identity,{schema_version:'veneer-purchase-timing-capture/v1',trust_id:trustId,request_key:key,captured_at:new Date(time).toISOString(),scope});}
function ready(approve=true,structured=true){
 const scope=material(),c=capture(scope);
 const proposal=proposalSchema.parse({question:'Approve this exact timing exception?',recommendation:'One SKU643922 at $30.90, delivery October 5',consequence:'Timing exception only; all other source guards remain',assignee_id:2,blocked_action:'Only Sage may place the exact order after fresh checks',...(structured?{purchase_timing:{schema_version:'veneer-purchase-timing-proposal/v1',capture_id:c.capture_id,scope}}:{})});
 const d=bots.raise(bot,{source_key:'order',proposal_key:'timing',proposal});
 if(approve){
  const approver={user:db.prepare('SELECT * FROM users WHERE id=2').get() as UserRow};
  bots.answer(approver,d.id,1,'answer',{action:'approve',text:'Approve this exact proposal',scope:'this_case'});
  db.prepare("UPDATE conversation_wakeups SET status='delivered'").run();
  db.prepare("UPDATE bot_decisions SET state='action_pending' WHERE id=?").run(d.id);
  bots.result(bot,d.id,1,'running',{state:'running',evidence:'Fixture material unchanged',material_evidence_unchanged:true});
  // SQLite records the answer on its real clock; fixture setup may take over a
  // second under full-suite contention. Sample the verifier clock after it.
  time=Date.now();
 }
 const args:TimingRequest={schema_version:'veneer-purchase-timing-request/v1',trust_id:trustId,request_key:'intent-1',decision_id:d.id,decision_version:1,native_proposal_hash:canonicalSha256(proposal),source_capture_id:c.capture_id};
 return {args,scope,d,proposal};
}
// A pre-408 claim is retained only in this disposable fixture. No production
// endpoint creates these records after the execution-boundary closure.
function historicalClaim(args:TimingRequest){
 const proof=s.verify(identity,args),{execute:_,...receipt}=proof;
 const id='historical-claim';
 db.prepare('INSERT INTO purchase_timing_claims(id,trust_id,request_key,decision_id,business_id,account_id,order_id,request_json,receipt_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,trustId,args.request_key,args.decision_id,'team','account','order',canonicalJson(args),canonicalJson(receipt),new Date(time).toISOString());
 return {claim_id:id};
}
beforeEach(()=>{
 time=Date.now();db=new Database(':memory:');db.pragma('foreign_keys=ON');migrate(db,fileURLToPath(new URL('../src/db/migrations',import.meta.url)));
 db.prepare("INSERT INTO users(id,email,display_name,role) VALUES(1,'owner@test','Owner','owner'),(2,'human@test','Approver','member')").run();
 db.prepare("INSERT INTO business_teams(id,name,owner_id) VALUES('team','Fixture',1)").run();
 db.prepare("INSERT INTO business_team_members VALUES('team',2,'member')").run();
 db.prepare("INSERT INTO conversations(id,assistant_id,user_id,title,provider,native_session_id,visibility,business_team_id) VALUES('sage',1,1,'Sage','codex','fixture','team','team')").run();
 db.prepare("INSERT INTO bot_registrations(conversation_id,name,registered_by) VALUES('sage','Sage',1)").run();
 human={user:db.prepare('SELECT * FROM users WHERE id=1').get() as UserRow};bot={...human,conversationId:'sage'};bots=createBotService(db);s=purchaseTimingService(db,config,()=>time);
 const review=s.setupReview(human,enrollment);trustId=s.enroll(human,{enrollment,review_hash:review.review_hash,confirm:true}).receipt!.trust_id;
});afterEach(()=>db.close());
it('preserves proof namespaces but refuses new grants without an enforced browser boundary',()=>{
 const {args,scope}=ready(),before=db.prepare('SELECT * FROM bot_decisions').get();
 const v=timingVerifyResponseSchema.parse(s.verify(identity,args));expect(v.execute).toBe(false);expect(v.native_proposal_hash).not.toBe(v.source_scope_hash);expect(v.source_material_fingerprint).toBe(scope.material_fingerprint);
 expect(()=>s.claim(identity,args)).toThrow('No enforced purchase request transport');
 expect(db.prepare('SELECT count(*) n FROM purchase_timing_claims').get()).toEqual({n:0});
 historicalClaim(args);
 expect(timingClaimResponseSchema.parse(s.claim(identity,args))).toMatchObject({execute:false,reconciliation_only:true});
 expect(()=>timingClaimResponseSchema.parse({...s.claim(identity,args),execute:true,reconciliation_only:false})).toThrow();
 expect(s.reconcile(identity,trustId,args.request_key).execute).toBe(false);
 expect(()=>s.executionCheck(identity,{schema_version:'veneer-purchase-timing-execution-check/v1',trust_id:trustId,request_key:args.request_key,source_capture_id:args.source_capture_id})).toThrow('generic browser');
 expect(()=>s.claim(identity,{...args,request_key:'other'})).toThrow('already claimed');
 expect(()=>s.claim(identity,{...args,native_proposal_hash:'b'.repeat(64)})).toThrow('different intent');
 expect(db.prepare('SELECT * FROM bot_decisions').get()).toEqual(before);
 expect(()=>db.prepare('DELETE FROM purchase_timing_claims').run()).toThrow('Immutable');
});
it.each(['owner','approver','executor','trust','version','proposal','answer','pending','blocked','terminal','bot-answer','human-context','delivery','running-evidence'] as const)('rejects native %s drift',kind=>{
 const {args}=ready(kind!=='bot-answer');
 if(kind==='owner')db.prepare('UPDATE business_teams SET owner_id=2').run();
 if(kind==='approver')db.prepare('DELETE FROM business_team_members WHERE user_id=2').run();
 if(kind==='executor')db.prepare('UPDATE bot_registrations SET active=0').run();
 if(kind==='trust')s.revoke(human,trustId,'stop');
 if(kind==='version')db.prepare('UPDATE bot_decisions SET version=2').run();
 if(kind==='proposal')db.prepare("UPDATE bot_decisions SET proposal_json='{}'").run();
 if(kind==='answer')db.prepare("UPDATE bot_decisions SET answer_json='{}'").run();
 if(kind==='pending')db.prepare("UPDATE bot_decisions SET state='needs_input'").run();
 if(kind==='blocked')db.prepare("UPDATE bot_decisions SET state='blocked'").run();
 if(kind==='terminal')db.prepare("UPDATE bot_decisions SET state='verified_completed'").run();
 if(kind==='bot-answer'){
  db.prepare("UPDATE bot_decisions SET state='running',answer_json=?").run(JSON.stringify({action:'approve',scope:'this_case',text:'bot says yes',actor_id:1}));
  db.prepare("INSERT INTO bot_decision_events(id,decision_id,version,kind,actor_id,actor_conversation_id,payload_json,request_key) VALUES('bot-answer',?,1,'answered',1,'sage',?,'bot-answer')").run(args.decision_id,JSON.stringify({action:'approve',scope:'this_case',text:'bot says yes'}));
 }
 if(kind==='human-context')captureHumanMessage(db,'sage',1,'Wait, do not place it');
 if(kind==='delivery')db.prepare("UPDATE conversation_wakeups SET status='pending'").run();
 if(kind==='running-evidence')db.prepare("INSERT INTO bot_decision_events(id,decision_id,version,kind,actor_id,actor_conversation_id,payload_json,request_key) VALUES('bad-result',?,1,'result',1,'sage',?,'bad-result')").run(args.decision_id,JSON.stringify({state:'running',material_evidence_unchanged:false}));
 expect(()=>s.verify(identity,args)).toThrow();expect(db.prepare('SELECT count(*) n FROM purchase_timing_claims').get()).toEqual({n:0});
});
it.each(['amount','currency','dates','timezone','order','shopify','line','quantity','sku','material','cart','action','proposal-version'] as const)('rejects authoritative source %s changes and supersedes old capture',kind=>{
 const {args,scope}=ready(),changed=structuredClone(scope);
 if(kind==='amount')changed.amount_cents++;
 if(kind==='currency')changed.currency='CAD';
 if(kind==='dates')changed.checkout_delivery.end='2026-10-06';
 if(kind==='timezone')changed.timezone='UTC';
 if(kind==='order')changed.order_number='other';
 if(kind==='shopify')changed.shopify_order_id='other';
 if(kind==='line')changed.lines[0]!.shopify_line_id='other';
 if(kind==='quantity')changed.lines[0]!.quantity=2;
 if(kind==='sku')changed.lines[0]!.sku='other';
 if(kind==='material')changed.material_fingerprint='b'.repeat(64);
 if(kind==='cart')changed.cart_version='c2';
 if(kind==='action')changed.source_action_id='action2';
 if(kind==='proposal-version')changed.source_proposal_version='p2';
 const c=capture(changed,'capture-2');
 expect(()=>s.verify(identity,args)).toThrow('supersedes');
 expect(()=>s.verify(identity,{...args,source_capture_id:c.capture_id})).toThrow();
});
it('refuses legacy prose and pending decisions, with no approval import',()=>{
 const {args}=ready(true,false);expect(()=>s.verify(identity,args)).toThrow('Native human approval is retained');
});
it('expires fresh evidence and never renews a claimed execution window',()=>{
 const {args}=ready();historicalClaim(args);time+=5001;
 expect(()=>s.executionCheck(identity,{schema_version:'veneer-purchase-timing-execution-check/v1',trust_id:trustId,request_key:args.request_key,source_capture_id:args.source_capture_id})).toThrow('expired');
 time+=31000;expect(()=>s.verify(identity,args)).toThrow('Fresh');
 expect(s.claim(identity,args).execute).toBe(false);expect(s.reconcile(identity,trustId,'intent-1').execute).toBe(false);
});
it('reconciles UNKNOWN after revoked trust/version/expiry without allowing an effect',()=>{
 const {args}=ready();const first=historicalClaim(args);s.revoke(human,trustId,'stop');time+=86400001;db.prepare('UPDATE bot_decisions SET version=2').run();
 expect(s.reconcile(identity,trustId,'intent-1')).toMatchObject({claim_id:first.claim_id,execute:false,reconciliation_only:true});
 expect(s.claim(identity,args).execute).toBe(false);
 expect(()=>s.executionCheck(identity,{schema_version:'veneer-purchase-timing-execution-check/v1',trust_id:trustId,request_key:args.request_key,source_capture_id:args.source_capture_id})).toThrow('revoked');
 expect(()=>s.reconcile(identity,trustId,'unknown')).toThrow('No claim');
});
it('enrolls only the actual owner with exact review; reconciles stable key without another registration',()=>{
 const r=s.setupReview(human,enrollment);expect(r.status).toBe('registered');
 expect(s.setupStatus(human,enrollment.request_key).trust_id).toBe(trustId);
 expect(()=>s.enroll(bot,{enrollment,review_hash:r.review_hash,confirm:true})).toThrow('owner');
 expect(()=>s.enroll(human,{enrollment,review_hash:'wrong',confirm:true})).toThrow('Review');
 expect(()=>s.setupReview(human,{...enrollment,principal_id:'foreign'})).toThrow('different immutable');
 s.revoke(human,trustId,'stop');expect(()=>s.enroll(human,{enrollment,review_hash:r.review_hash,confirm:true})).toThrow('Revoked');
});
it('rejects foreign identities, account/principal/origin and unsafe or extra schema fields',()=>{
 const {args,scope}=ready();expect(()=>s.verify({...identity,clientId:'return-client'},args)).toThrow('Dedicated');
 for(const field of ['business_id','account_id','principal_id','executor_id'] as const)expect(()=>capture({...scope,[field]:'foreign'},field)).toThrow('mismatch');
 expect(()=>capture({...scope,source_origin:'https://other.test'},'origin')).toThrow('mismatch');
 expect(()=>timingCaptureSchema.parse({scope,eligible:true})).toThrow();
 expect(()=>capture({...scope,amount_cents:30.9},'fraction')).toThrow();
 expect(()=>capture({...scope,checkout_delivery:{start:'2026-02-30',end:'2026-10-05'}},'date')).toThrow();
 expect(()=>capture({...scope,lines:[...scope.lines,...scope.lines]},'duplicate')).toThrow();
 expect(()=>s.claim(identity,{...args,approved:true})).toThrow();
});
it('dedicates authentication and rejects human JWTs, wrong clients, wrong audiences and all credential reuse',async()=>{
 const req={headers:{'cf-access-jwt-assertion':'synthetic-token'}} as IncomingMessage;
 expect(await purchaseTimingResolver(config,async(_token,aud)=>{expect(aud).toBe('timing-aud');return {common_name:'timing-client'};})(req)).toEqual(identity);
 for(const payload of [{common_name:'timing-client',email:'human@test'},{common_name:'other'},{email:'human@test'}])expect(await purchaseTimingResolver(config,async()=>payload)(req)).toBe(null);
 for(const field of ['returnVerifierCfAud','routineVerifierCfAud','autoshipVerifierCfAud','autoshipCandidateCfAud','cfAud'])expect(timingConfiguration({...config,[field]:'timing-aud'})).toBe(null);
 for(const field of ['returnVerifierClientId','routineVerifierClientId','autoshipVerifierClientId','autoshipCandidateClientId'])expect(timingConfiguration({...config,[field]:'timing-client'})).toBe(null);
 expect(await purchaseTimingResolver({...config,identity:'dev'},async()=>({common_name:'timing-client'}))(req)).toBe(null);
});
it('preserves immutable approval audit and rejects changed evidence access',()=>{
 const {args}=ready();expect(()=>db.prepare("UPDATE bot_decision_events SET payload_json='{}'").run()).toThrow('immutable');
 db.prepare("UPDATE users SET status='disabled' WHERE id=2").run();expect(()=>s.verify(identity,args)).toThrow('Active');
});
it('keeps durable one-time claims across two connections and a restart',async()=>{
 const {mkdtempSync,rmSync}=await import('node:fs'),{tmpdir}=await import('node:os'),{join}=await import('node:path');
 const {args}=ready(),dir=mkdtempSync(join(tmpdir(),'timing-fixture-')),file=join(dir,'test.sqlite');historicalClaim(args);
 await db.backup(file);const a=new Database(file),b=new Database(file);
 try{
  b.pragma('busy_timeout=0');let attempted=false;
  const atomic=purchaseTimingService(a,config,()=>{
   if(!attempted){attempted=true;expect(()=>purchaseTimingService(b,config,()=>time).revoke(human,trustId,'racing revoke')).toThrow(/locked/);}
   return time;
  });
  expect(atomic.verify(identity,args).execute).toBe(false);expect(attempted).toBe(true);
  const first=purchaseTimingService(a,config,()=>time).claim(identity,args);
  const retry=purchaseTimingService(b,config,()=>time).claim(identity,args);
  expect(first.execute).toBe(false);expect(retry.execute).toBe(false);
  expect(()=>purchaseTimingService(b,config,()=>time).claim(identity,{...args,request_key:'competitor'})).toThrow('already claimed');
 }finally{a.close();b.close();}
 const reopened=new Database(file);try{expect(purchaseTimingService(reopened,config,()=>time).reconcile(identity,trustId,args.request_key).execute).toBe(false);}finally{reopened.close();rmSync(dir,{recursive:true,force:true});}
});
it('blocks subsequent human result/discussion instructions but ignores bot follow-up',()=>{
 const {args}=ready();bots.reply(bot,args.decision_id,'status','Working on required checks');expect(s.verify(identity,args).execute).toBe(false);
 bots.reply(human,args.decision_id,'human-stop','Stop');expect(()=>s.verify(identity,args)).toThrow('Human context');
});
it('requires a retained source capture before a native timing question can be raised',()=>{
 const p=proposalSchema.parse({question:'Fixture?',recommendation:'Fixture',consequence:'Fixture',assignee_id:2,blocked_action:'Fixture',purchase_timing:{schema_version:'veneer-purchase-timing-proposal/v1',capture_id:'invented',scope:material()}});
 expect(()=>bots.raise(bot,{source_key:'invented',proposal_key:'invented',proposal:p})).toThrow('authenticated source');
});
it('prevents another enrolled executor from claiming the same source account/order',()=>{
 const first=ready();historicalClaim(first.args);
 db.prepare("INSERT INTO conversations(id,assistant_id,user_id,title,provider,native_session_id,visibility,business_team_id) VALUES('other',1,1,'Other','codex','other','team','team')").run();
 db.prepare("INSERT INTO bot_registrations(conversation_id,name,registered_by) VALUES('other','Other',1)").run();
 const e={...enrollment,request_key:'other-registration',executor_id:'other'},r=s.setupReview(human,e);
 trustId=s.enroll(human,{enrollment:e,review_hash:r.review_hash,confirm:true}).receipt!.trust_id;bot={...human,conversationId:'other'};
 const other=ready();expect(()=>s.claim(identity,other.args)).toThrow('already claimed');
});
it('rejects expired authorization, unsupported delay, future evidence and overlong validity',()=>{
 const scope=material();
 expect(()=>capture({...scope,authorization_expires_at:new Date(time-1).toISOString()},'expired')).toThrow('expired');
 expect(()=>capture({...scope,authorization_expires_at:new Date(time+86400001).toISOString()},'long')).toThrow('24 hours');
 expect(()=>capture({...scope,checkout_delivery:{start:'2026-09-26',end:'2026-09-26'}},'routine')).toThrow('seven days');
 expect(()=>s.capture(identity,{schema_version:'veneer-purchase-timing-capture/v1',trust_id:trustId,request_key:'future',captured_at:new Date(time+1001).toISOString(),scope})).toThrow('fresh');
});

it('recognizes an original-style conversational answer without altering it or inventing a capture',()=>{
 const {args,d}=ready(false,false);
 const author={user:db.prepare('SELECT * FROM users WHERE id=2').get() as UserRow};
 const source=captureHumanMessage(db,'sage',author.user.id,'Place. I authorize you too. We are in catchup mode.');
 const inspected=bots.inspectConversationalDecision(bot,d.id,1,'direct_message',source);
 bots.recordConversationalDecision(bot,d.id,1,'direct_message',source,inspected.inspection_hash!,'approve',true);
 const before=db.prepare('SELECT * FROM bot_decisions WHERE id=?').get(d.id);
 const events=db.prepare('SELECT * FROM bot_decision_events WHERE decision_id=?').all(d.id);
 expect(()=>s.verify(identity,args)).toThrow('Missing authenticated source linkage');
 expect(db.prepare('SELECT * FROM bot_decisions WHERE id=?').get(d.id)).toEqual(before);
 expect(db.prepare('SELECT * FROM bot_decision_events WHERE decision_id=?').all(d.id)).toEqual(events);
 expect(db.prepare("SELECT count(*) n FROM bot_decision_events WHERE kind='purchase_timing_context'").get()).toEqual({n:0});
 db.prepare("UPDATE users SET status='disabled' WHERE id=2").run();
 expect(()=>s.verify(identity,args)).toThrow('Active');
});
it('never permits recovery or a replacement intent from a retained UNKNOWN receipt',()=>{
 const {args}=ready();historicalClaim(args);
 const restarted=purchaseTimingService(db,config,()=>time);
 expect(restarted.claim(identity,args).execute).toBe(false);
 expect(restarted.reconcile(identity,trustId,args.request_key).execute).toBe(false);
 expect(()=>restarted.claim(identity,{...args,request_key:'replacement'})).toThrow('already claimed');
 expect(()=>restarted.executionCheck(identity,{schema_version:'veneer-purchase-timing-execution-check/v1',trust_id:trustId,request_key:args.request_key,source_capture_id:args.source_capture_id})).toThrow('generic browser');
});
