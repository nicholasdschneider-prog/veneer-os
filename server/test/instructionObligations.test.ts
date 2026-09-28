import express from 'express';
import type {AddressInfo} from 'node:net';
import {createBotsRouter} from '../src/bots/routes.js';
import type {AppContext} from '../src/context.js';
import Database from 'better-sqlite3';
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {fileURLToPath} from 'node:url';
import {migrate} from '../src/db/migrate.js';
import {createBotService,type Actor} from '../src/bots/service.js';
import {captureHumanMessage} from '../src/bots/humanMessages.js';
import {createInstructionObligations} from '../src/bots/instructionObligations.js';
import {callBotTool,BOT_TOOL_DEFINITIONS} from '../src/mcp/botTools.js';
import type {UserRow} from '../src/db/db.js';
let db:Database.Database, s:ReturnType<typeof createBotService>, o:ReturnType<typeof createInstructionObligations>, bot:Actor, human:Actor, decision:string, source:string;
const input=()=>({source_id:source,draft_id:'sms',expected_draft_version:1,executor_conversation_id:'tess'});
const payload={channel:'sms',account:'SMS account',recipients:['+12025550111'],subject:'',body:'Please send photos.',attachments:[],customer:'Customer',ticket:'PHONE-SISTER',context:'Alleged same case, NOT verified'};
beforeEach(()=>{
 db=new Database(':memory:');migrate(db,fileURLToPath(new URL('../src/db/migrations',import.meta.url)));
 db.prepare("INSERT INTO users(id,email,display_name,role) VALUES(1,'one@test','Human','owner'),(2,'two@test','Other','member')").run();
 for(const c of ['grant','tess','other'])db.prepare("INSERT INTO conversations(id,assistant_id,user_id,title,provider,native_session_id,visibility) VALUES(?,1,1,?,'codex',?,'team')").run(c,c,c);
 human={user:db.prepare('SELECT * FROM users WHERE id=1').get() as UserRow};bot={...human,conversationId:'grant'};
 s=createBotService(db);for(const c of ['grant','tess','other'])s.register(human,c,c,true);
 decision=s.raise(bot,{source_key:'case',proposal_key:'email',proposal:{question:'Send email?',recommendation:'Email only',consequence:'Customer gets reply',blocked_action:'Only exact email',assignee_id:1,evidence:[]}}).id;
 source=captureHumanMessage(db,'grant',1,'Send the email and SMS as well');
 const inspected=s.inspectConversationalDecision(bot,decision,1,'direct_message',source);
 s.recordConversationalDecision(bot,decision,1,'direct_message',source,inspected.inspection_hash!,'approve',true);
 db.prepare("INSERT INTO bot_message_drafts(id,conversation_id,request_key,payload_json,created_at) VALUES('sms','tess','draft',?,'2099-01-01 00:00:00')").run(JSON.stringify(payload));
 o=createInstructionObligations(db);
});
afterEach(()=>db.close());
function request(){return {...input(),inspection_hash:o.inspect(bot,input()).inspection_hash,request_key:'obligation',intent_summary:'Separate requested SMS remains outstanding',reviewed_full_context:true as const};}
it('retains consumed email and truthful later exact SMS snapshot, without granting authority or waking anybody',()=>{
 const email=db.prepare('SELECT * FROM bot_decisions').get(),receipt=db.prepare('SELECT * FROM bot_conversational_answers').get(),draft=db.prepare('SELECT * FROM bot_message_drafts').get(),wakes=db.prepare('SELECT count(*) n FROM conversation_wakeups').get();
 const inspection=o.inspect(bot,input());expect(inspection).toMatchObject({ready:false,execute:false,derivation:{post_instruction_draft:true},draft:{payload}});
 expect(inspection.missing_proof).toContain('AUTHENTICATED_SOURCE_CASE_LINKAGE_MISSING');
 const p=request(),result=o.record(bot,p);expect(result.obligation?.snapshot.intent_summary).toContain('SMS');
 expect(o.record(bot,p).obligation?.id).toBe(result.obligation?.id);
 expect(db.prepare('SELECT count(*) n FROM bot_instruction_obligations').get()).toEqual({n:1});
 expect(db.prepare('SELECT * FROM bot_decisions').get()).toEqual(email);expect(db.prepare('SELECT * FROM bot_conversational_answers').get()).toEqual(receipt);
 expect(db.prepare('SELECT * FROM bot_message_drafts').get()).toEqual(draft);expect(db.prepare('SELECT count(*) n FROM conversation_wakeups').get()).toEqual(wakes);
 expect(()=>s.recordConversationalDecision(bot,decision,1,'direct_message',source,p.inspection_hash,'approve',true)).toThrow('Conflicting');
});
it('requires exact original owner and executor, current registration and source author access',()=>{
 for(const actor of [human,{...human,conversationId:'tess'},{...human,conversationId:'other'}])expect(()=>o.inspect(actor,input())).toThrow('original source-owning');
 expect(()=>o.inspect(bot,{...input(),executor_conversation_id:'other'})).toThrow('executor draft');
 db.prepare("UPDATE bot_registrations SET active=0 WHERE conversation_id='tess'").run();expect(()=>o.inspect(bot,input())).toThrow('inactive');
 db.prepare("UPDATE bot_registrations SET active=1").run();db.prepare("UPDATE users SET status='disabled' WHERE id=1").run();expect(()=>o.inspect(bot,input())).toThrow();
});
it.each(['body','account','recipients','ticket','customer'])('rejects stale review after %s changes and retains old immutable snapshot',field=>{
 const p=request();o.record(bot,p);
 const changed={...payload,[field]:field==='recipients'?['+12025550222']:'changed'};
 db.prepare('UPDATE bot_message_drafts SET payload_json=?').run(JSON.stringify(changed));
 expect(o.inspect(bot,input()).missing_proof).toContain('RECORDED_OBSERVATION_CHANGED');
 expect(o.record(bot,p).obligation?.snapshot.draft.payload).toEqual(payload); // replay reports original, never overwrites
 expect(()=>o.record(bot,{...request(),request_key:'replacement'})).toThrow('Conflicting');
});
it('rejects pre-record stale hashes and draft version mismatch',()=>{
 const p=request();db.prepare('UPDATE bot_message_drafts SET payload_json=?').run(JSON.stringify({...payload,body:'Changed'}));
 expect(()=>o.record(bot,p)).toThrow('changed');db.prepare('UPDATE bot_message_drafts SET version=2').run();
 expect(()=>o.inspect(bot,input())).toThrow('version changed');
});
it('retains an outstanding intent while exposing newer human context and later proposal drift, never making it ready',()=>{
 const p=request();captureHumanMessage(db,'grant',1,'Wait, investigate first');
 expect(()=>o.record(bot,p)).toThrow('changed');
 const fresh=o.inspect(bot,input());expect(fresh.missing_proof).toContain('NEWER_HUMAN_CONTEXT_REQUIRES_REVIEW');
 const result=o.record(bot,request());expect(result.execute).toBe(false);
 s.revise(bot,decision,1,'change',{...s.view(bot,s.read(bot,decision)).proposal,recommendation:'Different proposal'});
 expect(o.inspect(bot,input()).missing_proof).toEqual(expect.arrayContaining(['CONSUMED_PROPOSAL_CHANGED','RECORDED_OBSERVATION_CHANGED']));
});
it('requires original consumption and captured immutable proposal; cannot import legacy transcript or false aliases',()=>{
 expect(()=>o.inspect(bot,{...input(),source_id:'legacy'})).toThrow('not found');
 const next=captureHumanMessage(db,'grant',1,'SMS please');expect(()=>o.inspect(bot,{...input(),source_id:next})).toThrow('consumption');
 expect(()=>o.record(bot,{...request(),same_case:true} as never)).toThrow();
 expect(o.inspect(bot,input()).missing_proof).toEqual(expect.arrayContaining(['EXACT_LATER_PAYLOAD_AUTHORITY_MISSING','AUTHENTICATED_SOURCE_CASE_LINKAGE_MISSING']));
});
it('does not classify human words or grant approval from a reviewed summary',()=>{
 expect(()=>o.record(bot,{...request(),reviewed_full_context:false} as never)).toThrow();
 const result=o.record(bot,{...request(),intent_summary:'approved send immediately'});
 expect(result.execute).toBe(false);expect(result.ready).toBe(false);expect(db.prepare('SELECT authorized_by,claim_key FROM bot_message_drafts').get()).toEqual({authorized_by:null,claim_key:null});
});
it('serializes conflicting records and keys, and appends immutable idempotent revocation',()=>{
 const p=request(),first=o.record(bot,p);expect(()=>o.record(bot,{...p,intent_summary:'different'})).toThrow('Conflicting');
 const id=first.obligation!.id;expect(o.revoke(bot,id,'Direction withdrawn','revoke')).toEqual({obligation_id:id,revoked:true,execute:false});
 expect(o.revoke(bot,id,'Direction withdrawn','revoke').revoked).toBe(true);
 expect(()=>o.revoke(bot,id,'different','revoke')).toThrow('Conflicting');expect(o.record(bot,p).missing_proof).toContain('OBLIGATION_REVOKED');
 expect(()=>db.prepare("UPDATE bot_instruction_obligations SET snapshot_json='{}'").run()).toThrow('immutable');
 expect(()=>db.prepare('DELETE FROM bot_instruction_obligation_revocations').run()).toThrow('immutable');
});
it.each(['sending','sent','queued'])('cannot create a new obligation against %s or unknown effects',state=>{
 const p=request();db.prepare('UPDATE bot_message_drafts SET state=?,claim_key=?').run(state,'existing-private-claim');
 const read=o.inspect(bot,input());expect(read.execute).toBe(false);expect(JSON.stringify(read)).not.toContain('existing-private-claim');
 expect(read.missing_proof).toContain('EXISTING_EFFECT_OR_UNKNOWN_RECONCILE_ONLY');expect(()=>o.record(bot,{...p,inspection_hash:read.inspection_hash})).toThrow('possible effects');
});
it('exposes exact tools without a claim surface and routes immutable bindings',async()=>{
 const callApi=vi.fn(async()=>({execute:false}));const p=request();
 await callBotTool({name:'inspect_instruction_obligation',args:input(),callApi});
 expect(callApi).toHaveBeenCalledWith('/api/bots/instruction-obligations/inspect',{method:'POST',body:JSON.stringify(input())});
 await callBotTool({name:'record_instruction_obligation',args:p,callApi});expect(callApi).toHaveBeenLastCalledWith('/api/bots/instruction-obligations',{method:'POST',body:JSON.stringify(p)});
 expect(JSON.stringify(BOT_TOOL_DEFINITIONS)).toContain('inspect_instruction_obligation');expect(JSON.stringify(BOT_TOOL_DEFINITIONS)).not.toContain('claim_instruction_obligation');
});
it('prevents private and foreign executor exposure',()=>{
 db.prepare("UPDATE conversations SET user_id=2,visibility='private' WHERE id='tess'").run();
 expect(()=>o.inspect(bot,input())).toThrow('not found');
 db.prepare("UPDATE conversations SET visibility='team' WHERE id='tess'").run();
 expect(()=>o.inspect(bot,input())).toThrow('outside source owner');
});
it('fails rather than returning a truncated context',()=>{
 db.prepare("INSERT INTO bot_human_messages(id,conversation_id,actor_id,text,proposals_json,created_at) VALUES('large','grant',1,?,'[]','2099-01-01')").run('x'.repeat(120001));
 expect(()=>o.inspect(bot,input())).toThrow('Full context exceeds');
});
it('handles competing service instances with one immutable record and lost-response reconciliation',async()=>{
 const p=request(),other=createInstructionObligations(db);
 const results=await Promise.all([Promise.resolve().then(()=>o.record(bot,p)),Promise.resolve().then(()=>other.record(bot,p))]);
 expect(results[0].obligation?.id).toBe(results[1].obligation?.id);
 expect(other.inspect(bot,input()).obligation?.id).toBe(results[0].obligation?.id);
 expect(db.prepare('SELECT count(*) n FROM bot_instruction_obligations').get()).toEqual({n:1});
});
it('enforces native route ownership and strict schema; inspection performs no writes',async()=>{
 const app=express();app.use(express.json());app.use((req,_res,next)=>{req.user=human.user;req.agentConversationId=req.headers['x-test-bot'] as string|undefined;next();});
 app.use('/api/bots',createBotsRouter({db} as AppContext));
 const server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));
 const url=`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/bots/instruction-obligations`;
 const post=(path:string,body:unknown,actor='grant')=>fetch(url+path,{method:'POST',headers:{'content-type':'application/json','x-test-bot':actor},body:JSON.stringify(body)});
 try{
  const changes=db.prepare('SELECT total_changes() n').get();
  const inspected=await post('/inspect',input());expect(inspected.status).toBe(200);expect(await inspected.json()).toMatchObject({execute:false,ready:false});
  expect(db.prepare('SELECT total_changes() n').get()).toEqual(changes);
  expect((await post('/inspect',input(),'tess')).status).toBe(403);
  expect((await post('/inspect',{...input(),same_case:true})).status).toBe(400);
  const p=request();const recorded=await post('',p);expect(recorded.status).toBe(200);const result=await recorded.json();
  expect((await post('',p)).status).toBe(200);
  expect((await post(`/${result.obligation.id}/revoke`,{reason:'Withdrawn intent',request_key:'revoke'})).status).toBe(200);
  expect((await post('/claim',{})).status).toBe(404);
 }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
