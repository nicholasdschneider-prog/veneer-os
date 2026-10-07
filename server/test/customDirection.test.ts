import Database from 'better-sqlite3';
import {fileURLToPath} from 'node:url';
import {beforeEach,afterEach,expect,it,vi} from 'vitest';
import {migrate} from '../src/db/migrate.js';
import {createBotService,type Actor} from '../src/bots/service.js';
import {customDirections} from '../src/bots/customDirection.js';
import {captureHumanMessage} from '../src/bots/humanMessages.js';
import type {UserRow} from '../src/db/db.js';
import {callBotTool,BOT_TOOL_DEFINITIONS} from '../src/mcp/botTools.js';
import {botFeatureCatalog,botFeatureInstructions} from '../src/featureGuide/catalog.js';
import {coreVeneerRules} from '../src/instructions/context.js';
import {employeeRouteAllowed} from '../src/bots/employeeAccess.js';
import express from 'express';
import type {AddressInfo} from 'node:net';
import {createBotsRouter} from '../src/bots/routes.js';
import type {AppContext} from '../src/context.js';
let db:Database.Database,s:ReturnType<typeof createBotService>,directions:ReturnType<typeof customDirections>,human:Actor,bot:Actor,decision:string,answer:string;
const scope={kind:'purchasing_unit_cost_correction' as const,source_account:'accounting@example.test',source_message_id:'message',source_document_sha256:'a'.repeat(64),confirmation_number:'1083667',order_number:'100122320',supplier_id:'6243',autopo_id:'1114337',autopo_line_id:'3043346',inventory_item_id:'49499768815768',sku:'RL108-010',quantity:4,currency:'USD' as const,previous_unit_cents:6599,unit_cents:6299,total_cents:25196,unchanged_retail_cents:8799};
const input=()=>({decision_id:decision,expected_version:1,answer_event_id:answer,executor_conversation_id:'clara'});
beforeEach(()=>{
 db=new Database(':memory:');migrate(db,fileURLToPath(new URL('../src/db/migrations',import.meta.url)));
 db.prepare("INSERT INTO users(id,email,display_name,role) VALUES(1,'one@test','Human','owner'),(2,'two@test','Other','member')").run();
 for(const c of ['clara','other'])db.prepare("INSERT INTO conversations(id,assistant_id,user_id,title,provider,native_session_id,visibility) VALUES(?,1,1,?,'codex',?,'team')").run(c,c,c);
 human={user:db.prepare('SELECT * FROM users WHERE id=1').get() as UserRow};bot={...human,conversationId:'clara'};
 s=createBotService(db);for(const c of ['clara','other'])s.register(human,c,c,true);
 decision=s.raise(bot,{source_key:'source',proposal_key:'identity',proposal:{question:'Same four individual springs?',recommendation:'Confirm item identity',consequence:'Only resolves identity',blocked_action:'Reconcile existing confirmation',assignee_id:1,evidence:[]}}).id;
 s.answerCustom(human,decision,1,'custom','Same four individual springs. Correct purchasing unit cost to $62.99.');
 answer=(db.prepare("SELECT id FROM bot_decision_events WHERE kind='answered'").get() as {id:string}).id;
 db.prepare("UPDATE conversation_wakeups SET status='delivered' WHERE id=?").run(answer);
 s.result(bot,decision,1,'blocked',{state:'blocked',evidence:'Custom direction execution binding unavailable. No writes attempted.'});
 directions=customDirections(db);
});
afterEach(()=>db.close());
function request(){
 const i=directions.inspect(bot,input()),e=i.binding.answer_event;
 const citation={kind:'decision_event' as const,id:e.id,text:e.payload_json};
 return {...input(),inspection_hash:i.inspection_hash,request_key:'review',reviewed_full_context:true as const,answer_text:i.answer_text as string,interpretation:'unconditional_direction' as const,explanation:'Human direction retained; external scope facts are observed, not source-authorized.',scope,
 scope_review:Object.keys(scope).map(field=>({field,assessment:'supported' as const,citations:[citation],explanation:'Observation tied to exact original direction; never grants authority.'})),
 later_context:i.later_human_context.map(m=>({citation:{kind:m.kind as 'decision_event',id:m.id,text:m.text},classification:'status_only' as const,explanation:'No substantive correction to this bounded direction.'})),
 observation:{observed_at:new Date().toISOString(),source_identity:'Original own account observed',existing_business_authority:'Existing trained workflow; not created by review',ownership_and_duplicates:'Own source lease and no prior attempt observed',evidence:'Exact source four at 6299 cents; PO four at 6599 cents; retail unchanged'}};
}
it('records prospective separate review without altering raw decision/answer/wakes or unlocking execution',()=>{
 const before=db.prepare('SELECT * FROM bot_decisions').get(),events=db.prepare('SELECT * FROM bot_decision_events').all(),wakes=db.prepare('SELECT * FROM conversation_wakeups').all();
 const p=request(),r=directions.record(bot,p);
 expect(r).toMatchObject({execute:false,ready:false,authority:false,dispatchEntitlement:false,review:{snapshot:{assessment:'direction_retained',source_observation_authenticated:false}}});
 expect(r.missing_proof).toContain('AUTHENTICATED_SOURCE_EXECUTION_BOUNDARY_UNAVAILABLE');
 expect(directions.record(bot,p).review?.id).toBe(r.review?.id);
 expect(db.prepare('SELECT * FROM bot_decisions').get()).toEqual(before);expect(db.prepare('SELECT * FROM bot_decision_events').all()).toEqual(events);expect(db.prepare('SELECT * FROM conversation_wakeups').all()).toEqual(wakes);
 expect(()=>s.result(bot,decision,1,'running',{state:'running',evidence:'checked',material_evidence_unchanged:true})).toThrow('Invalid execution transition');
 expect(()=>s.inspectConversationalDecision(bot,decision,1,'direct_message',captureHumanMessage(db,'clara',1,'Yes'))).toThrow();
});
it.each(['identity_only','status_only','conditional','quoted_or_reported','ambiguous'] as const)('retains %s as unresolved, never execution authority',interpretation=>{
 const r=directions.record(bot,{...request(),interpretation});expect(r.review?.snapshot.assessment).toBe('unresolved');expect(r.execute).toBe(false);
});
it('rejects missing scope field, fabricated citations, unsafe/broadened amounts and unsupported scope',()=>{
 const p=request();expect(()=>directions.record(bot,{...p,scope_review:p.scope_review.slice(1)})).toThrow('every scope');
 expect(()=>directions.record(bot,{...p,scope_review:p.scope_review.map(x=>({...x,citations:[{kind:'decision_event',id:answer,text:'partial quote'}]}))})).toThrow('citations');
 expect(()=>directions.record(bot,{...p,scope:{...scope,total_cents:1}})).toThrow('quantity');
 expect(()=>directions.record(bot,{...p,scope:{...scope,retail_cents:100}})).toThrow();
 const r=directions.record(bot,{...p,scope_review:p.scope_review.map(x=>({...x,assessment:'unsupported'}))});expect(r.review?.snapshot.assessment).toBe('scope_unverified');expect(r.review?.snapshot.direction_assessment).toBe('direction_retained');
});
it('requires original bot/executor, active own user/author/registration, exact event/version and delivery',()=>{
 for(const a of [human,{...bot,conversationId:'other'}])expect(()=>directions.inspect(a,input())).toThrow('Original');
 expect(()=>directions.inspect(bot,{...input(),executor_conversation_id:'other'})).toThrow('executor');
 expect(()=>directions.inspect(bot,{...input(),answer_event_id:'false'})).toThrow('immutable');
 expect(()=>directions.inspect(bot,{...input(),expected_version:2})).toThrow('version');
 db.prepare("UPDATE conversation_wakeups SET status='pending' WHERE id=?").run(answer);expect(()=>directions.inspect(bot,input())).toThrow('delivery');
 db.prepare("UPDATE conversation_wakeups SET status='delivered' WHERE id=?").run(answer);
 db.prepare("UPDATE bot_registrations SET active=0 WHERE conversation_id='clara'").run();expect(()=>directions.inspect(bot,input())).toThrow('revoked');
 db.prepare('UPDATE bot_registrations SET active=1').run();db.prepare("UPDATE users SET status='disabled' WHERE id=1").run();expect(()=>directions.inspect(bot,input())).toThrow();
});
it('rejects review drift and includes complete shared voice/later human context without caller-private audio',()=>{
 const p=request();captureHumanMessage(db,'clara',1,'Wait, do not change the price.');
 db.prepare("INSERT INTO voice_dispatches(user_id,conversation_id,instruction_id,text,created_at) VALUES(1,'clara','voice','Keep the old cost',?)").run(new Date().toISOString());
 expect(()=>directions.record(bot,p)).toThrow('changed');
 const i=directions.inspect(bot,input());expect(i.context.shared_voice_directions[0]?.text).toBe('Keep the old cost');expect(i.coverage.caller_private_voice).toBe(false);
 const fresh=request();expect(()=>directions.record(bot,{...fresh,later_context:[]})).toThrow('every later');
 const withdrawn=directions.record(bot,{...fresh,later_context:fresh.later_context.map(x=>({...x,classification:'substantive_supersession'}))});expect(withdrawn.review?.snapshot.assessment).toBe('superseded');
});
it('rejects actor/proposal/version drift, stale source observations and incomplete bounded context',()=>{
 const p=request();db.prepare('UPDATE bot_decisions SET handling_revision=handling_revision+1').run();expect(()=>directions.record(bot,p)).toThrow('changed');
 expect(()=>directions.record(bot,{...request(),observation:{...p.observation,observed_at:'2020-01-01T00:00:00Z'}})).toThrow('Fresh');
 db.prepare("UPDATE bot_decisions SET answer_json=json_set(answer_json,'$.actor_id',2)").run();expect(()=>directions.inspect(bot,input())).toThrow('immutable');
});
it('retains permanent UNKNOWN/inflight fences and immutable source lineage after reconciliation/context drift',()=>{
 const p=request();directions.record(bot,p);
 const f={decision_id:decision,request_key:'fence',state:'unknown' as const,evidence:'Source outcome unknown; reconcile exact original attempt only'};
 expect(directions.fence(bot,f).fences).toHaveLength(1);expect(directions.fence(bot,f).fences).toHaveLength(1);
 expect(()=>directions.fence(bot,{...f,state:'inflight'})).toThrow('Conflicting');
 expect(()=>directions.record(bot,{...p,request_key:'replacement'})).toThrow('no replacement');
 captureHumanMessage(db,'clara',1,'Status?');expect(directions.record(bot,p).execute).toBe(false);
 expect(directions.read(bot,{decision_id:decision}).fences).toHaveLength(1);
 expect(()=>db.prepare('DELETE FROM bot_custom_direction_fences').run()).toThrow('permanent');
 expect(()=>db.prepare('UPDATE bot_custom_direction_reviews SET request_key=?').run('new')).toThrow('immutable');
 expect(()=>directions.fence(bot,{...f,state:'verified_completed'})).toThrow();
});
it('rejects changed native proposal and concurrent conflicting recordings without partial writes',()=>{
 const p=request();
 db.prepare("UPDATE bot_decisions SET proposal_json=json_set(proposal_json,'$.recommendation','broadened')").run();
 expect(()=>directions.inspect(bot,input())).toThrow('proposal binding');
 expect(db.prepare('SELECT count(*) n FROM bot_custom_direction_reviews').get()).toEqual({n:0});
});
it('reconciles identical competing original-owner records and rejects a distinct replacement',async()=>{
 const p=request(),other=customDirections(db);
 const results=await Promise.all([Promise.resolve().then(()=>directions.record(bot,p)),Promise.resolve().then(()=>other.record(bot,p))]);
 expect(results[0].review?.id).toBe(results[1].review?.id);
 expect(()=>other.record(bot,{...p,scope:{...scope,quantity:5,total_cents:31495}})).toThrow('no replacement');
 expect(db.prepare('SELECT count(*) n FROM bot_custom_direction_reviews').get()).toEqual({n:1});
});
it('rejects oversized native context and leaves no partial ledger',()=>{
 for(let n=0;n<501;n++)db.prepare("INSERT INTO bot_human_messages(id,conversation_id,actor_id,text,proposals_json,created_at) VALUES(?,'clara',1,'context','[]','2026-10-07T00:00:00Z')").run(String(n));
 expect(()=>directions.inspect(bot,input())).toThrow('500');expect(db.prepare('SELECT count(*) n FROM bot_custom_direction_reviews').get()).toEqual({n:0});
});
it('preserves ordinary approve delivery/running behavior',()=>{
 const d=s.raise(bot,{source_key:'other-source',proposal_key:'approve',proposal:{question:'Confirm scope?',recommendation:'Known scope',consequence:'Known result',blocked_action:'Action',assignee_id:1,evidence:[]}});
 s.answer(human,d.id,1,'approve',{action:'approve',text:'Exact scope approved',scope:'this_case'});
 db.prepare("UPDATE conversation_wakeups SET status='delivered'").run();db.prepare("UPDATE bot_decisions SET state='action_pending' WHERE id=?").run(d.id);
 expect(s.result(bot,d.id,1,'run',{state:'running',evidence:'fresh evidence',material_evidence_unchanged:true}).state).toBe('running');
});
it('routes all MCP calls with exact payloads and announces truthful limits to employees/resumed bots',async()=>{
 for(const [name,path] of Object.entries({inspect_custom_direction:'inspect',record_custom_direction_review:'reviews',read_custom_direction:'read',record_custom_direction_fence:'fences'})) {
  expect(BOT_TOOL_DEFINITIONS.some(x=>x.name===name)).toBe(true);
  const api=vi.fn(async()=>({execute:false}));await callBotTool({name,args:{decision_id:decision},callApi:api});
  expect(api).toHaveBeenCalledWith('/api/bots/custom-directions/'+path,{method:'POST',body:JSON.stringify({decision_id:decision})});
 }
 const feature=botFeatureCatalog(Date.parse('2026-10-07')).features.find(f=>f.id==='custom-direction-review')!;
 expect(feature.isNew).toBe(true);expect(feature.limits).toContain('AUTHENTICATED_SOURCE_EXECUTION_BOUNDARY_UNAVAILABLE');expect(botFeatureInstructions()).toContain(feature.agent);
 expect(employeeRouteAllowed('GET','/bot-workflows/guide')).toBe(true);
 for(const elevated of [false,true])expect(coreVeneerRules({workspaceDir:'/repo',assistantSlug:'bot',elevated})).toContain(feature.agent);
});
it('HTTP inspection is original-owner-only and exposes no executable entitlement',async()=>{
 const app=express();app.use(express.json());app.use((req,_res,next)=>{req.user=human.user;req.agentConversationId=(req.headers['x-test-bot'] as string|undefined)??bot.conversationId;next();});
 app.use('/api/bots',createBotsRouter({db} as AppContext));const server=app.listen(0,'127.0.0.1');
 await new Promise<void>(r=>server.once('listening',r));
 try {
  const url=`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/bots/custom-directions/inspect`;
  const changes=db.prepare('SELECT total_changes() n').get();
  const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input())});expect(r.status).toBe(200);expect(await r.json()).toMatchObject({execute:false,authority:false});
  expect(db.prepare('SELECT total_changes() n').get()).toEqual(changes);
  expect((await fetch(url,{method:'POST',headers:{'Content-Type':'application/json','x-test-bot':'other'},body:JSON.stringify(input())})).status).toBe(403);
  expect((await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...input(),execute:true})})).status).toBe(400);
 } finally {await new Promise<void>(r=>server.close(()=>r()));}
});
