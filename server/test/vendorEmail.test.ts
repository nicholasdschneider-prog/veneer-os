import Database from 'better-sqlite3';
import {beforeEach,afterEach,describe,it,expect} from 'vitest';
import {fileURLToPath} from 'node:url';
import {migrate} from '../src/db/migrate.js';
import {vendorEmailService,vendorEmailScope,vendorEmailReview,vendorEmailCheck} from '../src/bots/vendorEmail.js';
import {communicationService} from '../src/bots/communication.js';
import {createBotService,proposalSchema,type Actor} from '../src/bots/service.js';
import type {UserRow} from '../src/db/db.js';
import {BOT_TOOL_DEFINITIONS,callBotTool} from '../src/mcp/botTools.js';
import {createCommunicationRouter} from '../src/bots/communicationRoutes.js';
import type {AppContext} from '../src/context.js';
import express from 'express';
import type {Server} from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

describe('prospective vendor email from a native human direction',()=>{
 let db:Database.Database,a:Actor,s:ReturnType<typeof vendorEmailService>,attachmentAvailable:boolean;
 const servers:Server[]=[],dirs:string[]=[];
 const words='Please compose and send a reply to Vendor in the existing thread. Attach the corrected same PO, not a new order.';
 const scope=()=>vendorEmailScope.parse({executor_conversation_id:'clara',channel:'email',account:'accounting@example.test',recipient:'vendor@example.test',thread_id:'thread-exact',in_reply_to:'correction-message',subject:'Re: Existing purchase order',body:'Please find the corrected same purchase order attached. This supersedes the old version.\nClara, a virtual assistant',attachments:[{name:'corrected.pdf',path:'/fixture/corrected.pdf',sha256:'a'.repeat(64)}]});
 const input=()=>({source_kind:'direct_message' as const,source_id:'human',scope:scope()});
 function human(id='human',text=words,time='2026-10-02T12:00:00.000Z'){db.prepare('INSERT INTO bot_human_messages(id,conversation_id,actor_id,text,proposals_json,created_at) VALUES(?,?,?,?,?,?)').run(id,'clara',2,text,'[]',time);}
 beforeEach(()=>{
  db=new Database(':memory:');db.pragma('foreign_keys=ON');migrate(db,fileURLToPath(new URL('../src/db/migrations',import.meta.url)));
  for(const id of [1,2])db.prepare("INSERT INTO users(id,email,display_name,role) VALUES(?,?,?,'owner')").run(id,`fixture${id}@example.test`,`Person ${id}`);
  db.prepare("INSERT INTO business_teams(id,name,owner_id) VALUES('team','Fixture',1)").run();db.prepare("INSERT INTO business_team_members(team_id,user_id,role) VALUES('team',2,'manager')").run();
  for(const id of ['clara','other']){db.prepare("INSERT INTO conversations(id,assistant_id,user_id,title,provider,native_session_id,visibility,business_team_id) VALUES(?,1,1,?,'claude',?,'team','team')").run(id,id,id);db.prepare('INSERT INTO bot_registrations(conversation_id,name,active,registered_by) VALUES(?,?,1,1)').run(id,id);}
  a={user:db.prepare('SELECT * FROM users WHERE id=1').get() as UserRow,conversationId:'clara'};attachmentAvailable=true;
  s=vendorEmailService(db,async()=>{if(!attachmentAvailable)throw Error('Attachment bytes changed');});human();
 });
 afterEach(async()=>{for(const server of servers.splice(0))await new Promise<void>(r=>server.close(()=>r()));db.close();for(const dir of dirs.splice(0))fs.rmSync(dir,{recursive:true,force:true});});
 const explain='Fixture full context and current source were reviewed with exact supported scope.';
 async function prepared(p=input()){
  const i=await s.inspect(a,p);
  const review=vendorEmailReview.parse({reviewed_full_context:true,interpretation:'unconditional_compose_and_send',instruction:{kind:i.source.kind,id:i.source.id,text:i.source.text},explanation:explain,scope_explanation:explain,
   later_context:i.later_human_context.map(m=>({citation:{kind:m.kind,id:m.id,text:m.text},classification:'status_only',explanation:explain})),
   records:[...i.context.drafts,...i.context.decisions].map(m=>({kind:m.kind,id:m.id,classification:m.kind==='draft'?'same_reply_unapproved':'unrelated',explanation:explain})),
   body_parts:[{start:0,end:p.scope.body.length,human_ids:[i.source.id],evidence:explain}],unresolved_choices:[]});
  const source_check=vendorEmailCheck.parse({observed_at:new Date().toISOString(),payload_hash:i.payload_hash,account_thread_recipient_verified:true,permissions_verified:true,attachments_verified:true,no_prior_or_uncertain_send:true,exclusive_source_ownership:true,evidence:explain});
  return {...p,inspection_hash:i.inspection_hash,review,source_check,request_key:'bind-once'};
 }
 async function setup(){const p=await prepared(),g=await s.bind(a,p);return {p,g,id:g.authority.id};}
 async function claim(id:string,p=undefined as Awaited<ReturnType<typeof prepared>>|undefined){p??=await prepared();return s.claim(a,{authority_id:id,claim_key:'claim-once',inspection_hash:p.inspection_hash,review:p.review,source_check:p.source_check});}
 function receipt(id:string,state='sent'){const g=s.read(a,id);return {authority_id:id,claim_key:'claim-once',request_key:'receipt-'+state,state,evidence:explain,...(state==='sent'?{proof:{provider:'gmail',provider_message_id:'provider-receipt',account:scope().account,recipient:scope().recipient,thread_id:scope().thread_id,in_reply_to:scope().in_reply_to,payload_hash:g.authority.payload_hash,idempotency_key:g.idempotency_key,verified:true}}:{})};}
 it('preserves ordinary drafts, creates no human approval and executes once with exact proof',async()=>{
  const old=communicationService(db).saveDraft(a,'clara','old',{...scope(),recipients:[scope().recipient],customer:'Vendor',ticket:scope().thread_id,context:'Unapproved draft',attachments:[]});
  const before=db.prepare('SELECT * FROM bot_message_drafts WHERE id=?').get(old.id);
  const {p,g,id}=await setup();expect(g.execute).toBe(false);expect((await s.bind(a,p)).authority.id).toBe(id);
  expect(db.prepare('SELECT * FROM bot_message_drafts WHERE id=?').get(old.id)).toEqual(before);expect(db.prepare('SELECT count(*) n FROM bot_conversational_answers').get()).toEqual({n:0});
  const first=await claim(id);expect(first.execute).toBe(true);if(first.execute)expect(first.scope).toEqual(scope());
  expect((await claim(id)).execute).toBe(false);expect((await s.claim(a,{authority_id:id,claim_key:'different',inspection_hash:p.inspection_hash,review:p.review,source_check:p.source_check})).execute).toBe(false);
  s.receipt(a,receipt(id,'uncertain'));expect((await claim(id)).execute).toBe(false);
  expect(s.receipt(a,receipt(id)).target.state).toBe('sent');expect(s.receipt(a,receipt(id)).target.state).toBe('sent');
  expect(()=>s.receipt(a,{...receipt(id),request_key:'different'})).toThrow('Terminal');expect(db.prepare('SELECT * FROM bot_message_drafts WHERE id=?').get(old.id)).toEqual(before);
 });
 it.each(['account','recipient','thread_id','in_reply_to','subject','body','attachments','executor_conversation_id'] as const)('rejects changed %s after inspection',async(field)=>{
  const p=await prepared();Object.assign(p.scope,{[field]:field==='attachments'?[]:field==='account'||field==='recipient'?'other@example.test':p.scope[field]+'x'});await expect(s.bind(a,p)).rejects.toThrow();
 });
 it('requires full exact instruction and every later human citation, with no inferred status consent',async()=>{
  human('later','Did you finish it?','2026-10-02T12:01:00Z');const p=await prepared();p.review.later_context=[];await expect(s.bind(a,p)).rejects.toThrow('every later');
  const q=await prepared();q.review.instruction.text='send';await expect(s.bind(a,q)).rejects.toThrow('Complete exact');
  const r=await prepared();r.review.later_context[0]!.classification='supersedes';await expect(s.bind(a,r)).rejects.toThrow('Later correction');
  const ok=await prepared();expect((await s.bind(a,ok)).execute).toBe(false);
 });
 it.each(['status_only','wording_edit','quoted','conditional','ambiguous'])('rejects %s interpretation at schema boundary',async(mode)=>{const p=await prepared();await expect(s.bind(a,{...p,review:{...p.review,interpretation:mode}})).rejects.toThrow();});
 it('blocks claim on new context until the same scope gets a fresh complete review',async()=>{
  const {p,id}=await setup();human('later','What is the status?','2026-10-02T12:01:00Z');await expect(claim(id,p)).rejects.toThrow('context');
  const current=await prepared();current.review.later_context[0]!.classification='ambiguous';await expect(claim(id,current)).rejects.toThrow('Later correction');
  expect((await claim(id)).execute).toBe(true);
 });
 it('records an unclaimed correction prospectively and never replaces an attempted thread',async()=>{
  const {id}=await setup();human('corrected','Compose and send the corrected same reply, removing the pickup question.','2026-10-02T12:02:00Z');
  const q=await prepared({...input(),source_id:'corrected',scope:{...scope(),body:'Corrected existing PO attached. Clara, a virtual assistant'}});
  const newer=await s.bind(a,{...q,request_key:'correction',supersedes_id:id});expect(s.read(a,id).events).toHaveLength(1);
  await expect(claim(id)).rejects.toThrow('superseded');
  expect((await claim(newer.authority.id,q)).execute).toBe(true);
  await expect(s.bind(a,{...q,request_key:'after-claim',supersedes_id:newer.authority.id})).rejects.toThrow('already attempted');
 });
 it('preserves source fencing across thread changes, replacement keys, failure and revocation',async()=>{
  const {id}=await setup();const q=await prepared({...input(),scope:{...scope(),thread_id:'other-thread'}});await expect(s.bind(a,{...q,request_key:'bypass'})).rejects.toThrow('another email thread');
  await claim(id);s.receipt(a,receipt(id,'failed'));await expect(s.bind(a,{...await prepared(),request_key:'retry'})).rejects.toThrow('already attempted');expect((await claim(id)).execute).toBe(false);
 });
 it('revokes an unclaimed authority without freeing its fence',async()=>{const {id}=await setup();s.revoke(a,{authority_id:id,request_key:'revoke',reason:explain});await expect(claim(id)).rejects.toThrow('revoked');await expect(s.bind(a,{...await prepared(),request_key:'retry'})).rejects.toThrow('revoked');});
 it.each(['author','executor','registration','membership','ownership','archived'])('fresh %s revocation blocks claim',async(what)=>{
  const {p,id}=await setup();if(what==='author')db.prepare("UPDATE users SET status='disabled' WHERE id=2").run();if(what==='executor')db.prepare("UPDATE users SET status='disabled' WHERE id=1").run();if(what==='registration')db.prepare("UPDATE bot_registrations SET active=0 WHERE conversation_id='clara'").run();if(what==='membership')db.prepare("DELETE FROM business_team_members WHERE user_id=2").run();if(what==='ownership')db.prepare("UPDATE conversations SET user_id=2 WHERE id='clara'").run();if(what==='archived')db.prepare("UPDATE conversations SET archived=1 WHERE id='clara'").run();await expect(claim(id,p)).rejects.toThrow();
 });
 it('refuses builders, humans, alternate bots and invented/forwarded sources',async()=>{
  const p=await prepared();await expect(s.bind({...a,conversationId:'other'},p)).rejects.toThrow();await expect(s.bind({user:a.user},p)).rejects.toThrow();await expect(s.inspect(a,{...input(),source_id:'handoff-only'})).rejects.toThrow('authenticated');
  db.prepare("INSERT INTO bot_message_threads(id,conversation_id,anchor,source_text) VALUES('t','clara','a','Original result')").run();db.prepare("INSERT INTO bot_message_replies(id,thread_id,actor_id,actor_conversation_id,text,request_key) VALUES('bot','t',1,'clara',?,'r')").run(words);
  await expect(s.inspect(a,{...input(),source_kind:'result_reply',source_id:'bot'})).rejects.toThrow('authenticated');
 });
 it('retains human result reply attribution and its complete original anchor',async()=>{
  db.prepare("INSERT INTO bot_message_threads(id,conversation_id,anchor,source_text) VALUES('t','clara','a','Original complete result payload')").run();db.prepare("INSERT INTO bot_message_replies(id,thread_id,actor_id,text,request_key) VALUES('reply','t',2,?,'r')").run(words);
  const p=await prepared({...input(),source_kind:'result_reply' as 'direct_message',source_id:'reply'});expect(p.review.instruction.kind).toBe('result_reply');const g=await s.bind(a,p);expect(g.authority.author_id).toBe(2);
  db.prepare("UPDATE bot_message_threads SET source_text='Altered anchor' WHERE id='t'").run();await expect(claim(g.authority.id,p)).rejects.toThrow('context');
 });
 it('fresh checks cover drift, stale observations and changed attachment bytes',async()=>{
  const p=await prepared();await expect(s.bind(a,{...p,source_check:{...p.source_check,observed_at:'2020-01-01T00:00:00Z'}})).rejects.toThrow('Fresh');
  const {id}=await setup();attachmentAvailable=false;await expect(claim(id,p)).rejects.toThrow('Attachment bytes');
 });
 it('blocks old native claims and prior/unknown native sends to the same account/recipient',async()=>{
  const old=communicationService(db).saveDraft(a,'clara','old',{channel:'email',account:scope().account,recipients:[scope().recipient],subject:'Old',body:'Old',customer:'Vendor',ticket:scope().thread_id,context:'',attachments:[]});
  const {id}=await setup();expect(()=>communicationService(db).claim(a,old.id,'raw')).toThrow('Vendor reply authority');
  db.prepare("UPDATE bot_message_drafts SET state='uncertain',claim_key='prior' WHERE id=?").run(old.id);await expect(claim(id)).rejects.toThrow();
 });
 it('guards immutable authority and event history, receipt scope and replay',async()=>{
  const {id}=await setup();expect(()=>db.prepare('UPDATE bot_vendor_email_authorities SET source_id=? WHERE id=?').run('fake',id)).toThrow('Immutable');await claim(id);
  for(const field of ['account','recipient','thread_id','in_reply_to','payload_hash','idempotency_key']){const p=receipt(id);await expect(async()=>s.receipt(a,{...p,proof:{...p.proof,[field]:'wrong@example.test'}})).rejects.toThrow();}
  expect(()=>s.receipt(a,{...receipt(id),proof:undefined})).toThrow('Verified exact');
  s.receipt(a,receipt(id));expect(()=>s.receipt(a,{...receipt(id),evidence:'Different conflicting evidence for the same receipt.'})).toThrow('Conflicting');
  expect(()=>db.prepare('DELETE FROM bot_vendor_email_events WHERE authority_id=?').run(id)).toThrow('Immutable');
 });
 it('does not reuse an accepted provider receipt for another thread',async()=>{
  const {id}=await setup();await claim(id);s.receipt(a,receipt(id));
  human('second','Compose and send this other vendor thread reply.', '2026-10-02T12:05:00Z');const otherScope={...scope(),thread_id:'second-thread'};const p=await prepared({...input(),source_id:'second',scope:otherScope});
  const other=await s.bind(a,{...p,request_key:'second-bind'});await claim(other.authority.id,p);const r=receipt(other.authority.id);await expect(async()=>s.receipt(a,{...r,proof:{...r.proof,thread_id:'second-thread'}})).rejects.toThrow('already belongs');
 });
 it('preserves a real pending business hold and requires its explicit review',async()=>{
  const bots=createBotService(db),d=bots.raise(a,{source_key:'hold-fixture',proposal_key:'hold-v1',proposal:proposalSchema.parse({question:'Resolve vendor mismatch?',recommendation:'Hold this reply until resolved.',consequence:'No financial action.',assignee_id:2,blocked_action:'Do not send while this mismatch remains.'})});
  const before=db.prepare('SELECT * FROM bot_decisions WHERE id=?').get(d.id),p=await prepared();p.review.records[0]!.classification='blocking';await expect(s.bind(a,p)).rejects.toThrow('blocks this reply');
  p.review.records=[];await expect(s.bind(a,p)).rejects.toThrow('every draft and decision');expect(db.prepare('SELECT * FROM bot_decisions WHERE id=?').get(d.id)).toEqual(before);
 });
 it('does not reuse a human source already consumed by an existing native approval',async()=>{
  const d=createBotService(db).raise(a,{source_key:'decision-fixture',proposal_key:'v1',proposal:proposalSchema.parse({question:'Send the existing exact proposal?',recommendation:'Keep original executor.',consequence:'Only this message.',assignee_id:2,blocked_action:'Existing proposal binding.'})});
  db.prepare("INSERT INTO bot_conversational_answers(source_kind,source_id,decision_id,version,inspection_hash,source_hash,action,event_key) VALUES('direct_message','human',?,1,?,?,'approve','existing-answer')").run(d.id,'a'.repeat(64),'b'.repeat(64));
  await expect(s.inspect(a,input())).rejects.toThrow('already consumed');expect(db.prepare('SELECT count(*) n FROM bot_vendor_email_authorities').get()).toEqual({n:0});
 });
 it('serializes simultaneous claims; at most one response authorizes execution',async()=>{const {id}=await setup();const p=await prepared();const replies=await Promise.all([claim(id,p),claim(id,p)]);expect(replies.filter(r=>r.execute)).toHaveLength(1);});
 it('routes every supported tool and retains all fields without a transport call',async()=>{
  const contextCalls:unknown[]=[];await callBotTool({name:'read_vendor_email_context',args:{},callApi:async(...args:unknown[])=>{contextCalls.push(args);return {execute:false};}});expect(contextCalls).toEqual([['/api/bot-communication/vendor-email/context',{method:'POST',body:'{}'}]]);
  for(const [name,path] of [['inspect_vendor_email','inspect'],['bind_vendor_email','bind'],['read_vendor_email','read'],['claim_vendor_email','claim'],['record_vendor_email_delivery','receipt'],['revoke_vendor_email','revoke']]){
   expect(BOT_TOOL_DEFINITIONS.some(t=>t.name===name)).toBe(true);const calls:unknown[]=[];await callBotTool({name:name!,args:{authority_id:'exact'},callApi:async(...args:unknown[])=>{calls.push(args);return {execute:false};}});expect(calls).toEqual([['/api/bot-communication/vendor-email/'+path,{method:'POST',body:'{"authority_id":"exact"}'}]]);
  }
 });
 it('discovers native source IDs while keeping bot and voice reports out of authority candidates',()=>{
  const result=s.context(a);expect(result.execute).toBe(false);expect(result.source_candidates.map(m=>m.id)).toEqual(['human']);
  expect(()=>s.context({...a,conversationId:'other'})).not.toThrow();expect(s.context({...a,conversationId:'other'}).source_candidates).toEqual([]);
 });
 it('requires review of later shared voice directions without exposing private voice sessions',async()=>{
  const {p,id}=await setup();db.prepare("INSERT INTO voice_dispatches(user_id,conversation_id,instruction_id,text,result_json,created_at) VALUES(2,'clara','voice-stop','Do not send the reply yet.',?,?)").run('{"ok":true}', '2026-10-02 12:03:00');
  await expect(claim(id,p)).rejects.toThrow('context');const fresh=await prepared();expect(fresh.review.later_context[0]!.citation.kind).toBe('voice_dispatch');fresh.review.later_context[0]!.classification='supersedes';await expect(claim(id,fresh)).rejects.toThrow('Later correction');
  expect(JSON.stringify(s.context(a))).not.toContain('voice_entries');
 });
 it('serializes identical binding retries and rejects altered review under the same key',async()=>{
  const p=await prepared();const [a1,a2]=await Promise.all([s.bind(a,p),s.bind(a,p)]);expect(a1.authority.id).toBe(a2.authority.id);
  await expect(s.bind(a,{...p,review:{...p.review,scope_explanation:'A changed conflicting interpretation of the scope.'}})).rejects.toThrow('Conflicting');
 });
 it('does not leak broader authority through extra properties, other channels or missing body coverage',async()=>{
  const p=await prepared();await expect(s.bind(a,{...p,authorized_by:2})).rejects.toThrow();await expect(s.bind(a,{...p,scope:{...p.scope,thread_id:'THREAD-EXACT'}})).rejects.toThrow();await expect(s.bind(a,{...p,scope:{...p.scope,channel:'sms'}})).rejects.toThrow();
  p.review.body_parts[0]!.end--;await expect(s.bind(a,p)).rejects.toThrow('entire composed body');
 });
 it('HTTP attachment verifier checks actual retained bytes and denies unregistered paths',async()=>{
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'vendor-email-')));dirs.push(dir);const file=path.join(dir,'po.pdf');fs.writeFileSync(file,'%PDF-1.4\nfixture retained bytes');
  const fileHash=crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const app=express();app.use(express.json());app.use((req,_res,next)=>{req.user=a.user;req.agentConversationId=a.conversationId;next();});app.use(createCommunicationRouter({db,manager:{listSessionFiles:async()=>[{path:file,source:'download'}]}} as unknown as AppContext));
  const server=app.listen(0,'127.0.0.1');servers.push(server);await new Promise<void>(r=>server.once('listening',r));const port=(server.address() as {port:number}).port;
  const post=(attachment:unknown)=>fetch(`http://127.0.0.1:${port}/vendor-email/inspect`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...input(),scope:{...scope(),attachments:[attachment]}})});
  expect((await post({name:'po.pdf',path:file,sha256:fileHash})).status).toBe(200);
  fs.writeFileSync(file,'%PDF-1.4\nCHANGED retained bytes');expect((await post({name:'po.pdf',path:file,sha256:fileHash})).status).toBe(409);
  expect((await post({name:'po.pdf',path:path.join(dir,'missing.pdf'),sha256:fileHash})).status).toBe(404);
 });
});
