import Database from 'better-sqlite3';
import express from 'express';
import {it,expect} from 'vitest';
import type {AddressInfo} from 'node:net';
import {fileURLToPath} from 'node:url';
import {migrate} from '../src/db/migrate.js';
import {purchaseTimingVerifierRoutes,purchaseTimingSetupRoutes} from '../src/bots/purchaseTimingRoutes.js';
import type {AppContext} from '../src/context.js';
import {purchaseTimingService} from '../src/bots/purchaseTiming.js';
import {createBotService,proposalSchema} from '../src/bots/service.js';
import {canonicalJson,canonicalSha256} from '../src/bots/canonical.js';
import type {TimingScope} from '../src/bots/purchaseTimingSchema.js';
import type {UserRow} from '../src/db/db.js';
it('keeps dedicated service auth separate from owner setup and returns strict errors',async()=>{
 const db=new Database(':memory:');migrate(db,fileURLToPath(new URL('../src/db/migrations',import.meta.url)));
 db.prepare("INSERT INTO users(id,email,display_name,role) VALUES(1,'owner@test','Owner','owner')").run();
 const ctx={db,config:{identity:'cloudflare',cfTeamDomain:'fixture.cloudflareaccess.com',cfAud:'human',purchaseTimingCfAud:'timing',purchaseTimingClientId:'client'}} as AppContext;
 const app=express();app.use('/verifier',purchaseTimingVerifierRoutes(ctx,async req=>req.headers['x-fixture-service']==='yes'?{kind:'purchase_timing_verifier',clientId:'client',audience:'timing'}:null));
 app.use(express.json());app.use('/setup',(req,_res,next)=>{req.user=db.prepare('SELECT * FROM users WHERE id=1').get() as UserRow;if(req.headers['x-fixture-bot'])req.agentConversationId='bot';next();},purchaseTimingSetupRoutes(ctx));
 const server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
 try{
  for(const url of ['/verifier/verify','/verifier/claims','/verifier/captures']){
   const r=await fetch(base+url,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});expect(r.status).toBe(401);expect(await r.json()).toMatchObject({code:'IDENTITY_REJECTED',execute:false});
   const invalid=await fetch(base+url,{method:'POST',headers:{'Content-Type':'application/json','x-fixture-service':'yes'},body:'{"approved":true}'});expect(invalid.status).toBe(400);expect(await invalid.json()).toMatchObject({code:'INVALID_FIELDS',execute:false});
  }
  const botSetup=await fetch(base+'/setup',{headers:{'x-fixture-bot':'yes'}});expect(botSetup.status).toBe(403);
  const options=await fetch(base+'/setup');expect(await options.json()).toMatchObject({configured:true,businesses:[]});
  // Real disposable service setup and a genuinely answered native fixture.
  db.prepare("INSERT INTO business_teams(id,name,owner_id) VALUES('team','Fixture',1)").run();
  db.prepare("INSERT INTO conversations(id,assistant_id,user_id,title,provider,native_session_id,visibility,business_team_id) VALUES('sage',1,1,'Sage','codex','fixture','team','team')").run();
  db.prepare("INSERT INTO bot_registrations(conversation_id,name,registered_by) VALUES('sage','Sage',1)").run();
  const human={user:db.prepare('SELECT * FROM users WHERE id=1').get() as UserRow},bot={...human,conversationId:'sage'};
  const timing=purchaseTimingService(db,ctx.config),bots=createBotService(db);
  const identity={kind:'purchase_timing_verifier' as const,clientId:'client',audience:'timing'};
  const enrollment={request_key:'setup',business_id:'team',executor_id:'sage',source_origin:'https://source.test',account_id:'account',principal_id:'principal',source_deployment:'fixture',custody_receipt:'fixture'};
  const trust=timing.enroll(human,{enrollment,review_hash:timing.setupReview(human,enrollment).review_hash,confirm:true}).receipt!.trust_id;
  const scope:TimingScope={schema_version:'orderops-purchase-timing-material/v1',business_id:'team',account_id:'account',source_origin:'https://source.test',principal_id:'principal',executor_id:'sage',order_id:'order',order_number:'100',shopify_order_id:'shopify',lines:[{order_line_id:'line',shopify_line_id:'shopify-line',sku:'643922',quantity:1}],amount_cents:3090,currency:'USD',original_delivery:{start:'2026-09-23',end:'2026-09-25'},checkout_delivery:{start:'2026-10-05',end:'2026-10-05'},timezone:'America/New_York',source_action_id:'action',source_proposal_version:'p1',material_version:'m1',cart_version:'c1',material_fingerprint:'a'.repeat(64),authorization_expires_at:new Date(Date.now()+3600000).toISOString()};
  const c=timing.capture(identity,{schema_version:'veneer-purchase-timing-capture/v1',trust_id:trust,request_key:'capture',captured_at:new Date().toISOString(),scope});
  const proposal=proposalSchema.parse({question:'Exact timing?',recommendation:'Exact fixture',consequence:'Timing only',blocked_action:'Sage only',assignee_id:1,purchase_timing:{schema_version:'veneer-purchase-timing-proposal/v1',capture_id:c.capture_id,scope}});
  const d=bots.raise(bot,{source_key:'order',proposal_key:'timing',proposal});bots.answer(human,d.id,1,'answer',{action:'approve',scope:'this_case',text:'Approve exact fixture'});
  db.prepare("UPDATE conversation_wakeups SET status='delivered'").run();db.prepare("UPDATE bot_decisions SET state='action_pending'").run();
  bots.result(bot,d.id,1,'running',{state:'running',evidence:'Fixture',material_evidence_unchanged:true});
  const intent={schema_version:'veneer-purchase-timing-request/v1',trust_id:trust,request_key:'intent',decision_id:d.id,decision_version:1,native_proposal_hash:canonicalSha256(proposal),source_capture_id:c.capture_id};
  const post=(path:string,body:unknown)=>fetch(base+'/verifier/'+path,{method:'POST',headers:{'Content-Type':'application/json','x-fixture-service':'yes'},body:JSON.stringify(body)});
  const denied=await post('claims',intent);expect(denied.status).toBe(409);expect(await denied.json()).toMatchObject({code:'EXECUTION_BOUNDARY_UNAVAILABLE',execute:false});
  expect(db.prepare('SELECT count(*) n FROM purchase_timing_claims').get()).toEqual({n:0});
  const {execute:_,...proof}=timing.verify(identity,intent);
  db.prepare('INSERT INTO purchase_timing_claims(id,trust_id,request_key,decision_id,business_id,account_id,order_id,request_json,receipt_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run('historical',trust,'intent',d.id,'team','account','order',canonicalJson(intent),canonicalJson(proof),new Date().toISOString());
  const check=await post('execution-checks',{schema_version:'veneer-purchase-timing-execution-check/v1',trust_id:trust,request_key:'intent',source_capture_id:c.capture_id});
  expect(check.status).toBe(409);expect(await check.json()).toMatchObject({code:'EXECUTION_BOUNDARY_UNAVAILABLE',execute:false});
  const replay=await post('claims',intent);expect(replay.status).toBe(200);expect(await replay.json()).toMatchObject({claim_id:'historical',execute:false,reconciliation_only:true});
  const malformed=await fetch(base+'/verifier/claims',{method:'POST',headers:{'Content-Type':'application/json','x-fixture-service':'yes'},body:'{'});expect(malformed.status).toBe(400);expect(await malformed.json()).toMatchObject({execute:false});
  const missing=await fetch(base+'/verifier/trusts/no-trust/claims/intent',{headers:{'x-fixture-service':'yes'}});expect(missing.status).toBe(404);expect(await missing.json()).toMatchObject({code:'NOT_FOUND',execute:false});
 }finally{server.close();db.close();}
});
