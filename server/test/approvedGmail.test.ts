import express from 'express';
import {createCommunicationRouter} from '../src/bots/communicationRoutes.js';
import type {AppContext} from '../src/context.js';
import Database from 'better-sqlite3';
import {beforeEach,afterEach,describe,it,expect} from 'vitest';
import {fileURLToPath} from 'node:url';
import {migrate} from '../src/db/migrate.js';
import {createBotService,proposalSchema,type Actor} from '../src/bots/service.js';
import {communicationService} from '../src/bots/communication.js';
import {messageDelegationService} from '../src/bots/messageDelegation.js';
import {approvedMessageSchema} from '../src/bots/draftPayload.js';
import {approvedGmailResolver,type ApprovedGmailReader} from '../src/bots/approvedGmail.js';
import {gmailBindSchema,gmailSourceSchema} from '../src/bots/approvedGmailContract.js';
import {canonicalSha256 as hash} from '../src/bots/canonical.js';
import type {UserRow} from '../src/db/db.js';
describe('prospective exact approved Gmail existing draft (offline)',()=>{
 let db:Database.Database,a:Actor,human:Actor,bots:ReturnType<typeof createBotService>,messages:ReturnType<typeof communicationService>;
 let scope:any,target:any,evidence:any,reader:ApprovedGmailReader,time:number,revoked:boolean,calls:number;
 beforeEach(()=>{
  db=new Database(':memory:');db.pragma('foreign_keys=ON');migrate(db,fileURLToPath(new URL('../src/db/migrations',import.meta.url)));
  db.prepare("INSERT INTO users(id,email,display_name,role) VALUES(1,'owner@example.test','Owner','owner'),(2,'approver@example.test','Approver','owner')").run();
  db.prepare("INSERT INTO business_teams(id,name,owner_id) VALUES('business','Fixture',1)").run();
  db.prepare("INSERT INTO business_team_members(team_id,user_id,role) VALUES('business',2,'manager')").run();
  for(const id of ['owner','foreign']){
   db.prepare("INSERT INTO conversations(id,assistant_id,user_id,title,provider,native_session_id,visibility,business_team_id) VALUES(?,1,1,?,'claude',?,'team','business')").run(id,id,id);
   db.prepare('INSERT INTO bot_registrations(conversation_id,name,active,registered_by) VALUES(?,?,1,1)').run(id,id);
  }
  a={user:db.prepare('SELECT * FROM users WHERE id=1').get() as UserRow,conversationId:'owner'};
  human={user:db.prepare('SELECT * FROM users WHERE id=2').get() as UserRow};
  bots=createBotService(db);messages=communicationService(db);
  scope=approvedMessageSchema.parse({canonical_case:'gmail-thread',executor_conversation_id:'owner',payload:{channel:'email',account:'account@example.test',recipients:['vendor@example.test'],subject:'Exact subject',body:'Exact body.\nArcher - Personal Assistant',attachments:[],customer:'Vendor',ticket:'order1 / original order2 / literal',context:''}});
  const d=bots.raise(a,{source_key:'fixture',proposal_key:'exact',proposal:proposalSchema.parse({question:'Send unchanged?',recommendation:'One exact reply.',consequence:'Email only.',blocked_action:'Send only the unchanged existing vendor reply after checks.',assignee_id:2,message_delivery:scope})});
  bots.answer(human,d.id,1,'approve',{action:'approve',text:'Approve unchanged',scope:'this_case'});
  const draft=messages.saveDraft(a,'owner','existing',{...scope.payload,context:'Retained original thread and reply provenance; no additional authority.'},d.id,1);
  target={decision_id:d.id,expected_version:1,draft_id:draft.id,draft_version:1,thread_id:'gmail-thread',reply_message_id:'inbound-message',reply_rfc_message_id:'<original@example.test>'};
  time=Date.now();revoked=false;calls=0;
  evidence={schema_version:'approved-gmail-source/v1',caller_id:'owner',user_id:1,business_id:'business',connection_id:'own-connection',principal_id:'verified-account-subject',custody_hash:'a'.repeat(64),account:scope.payload.account,thread_id:target.thread_id,reply_message_id:target.reply_message_id,reply_rfc_message_id:target.reply_rfc_message_id,latest_inbound_id:target.reply_message_id,recipients:scope.payload.recipients,source_revision:'b'.repeat(64),material_hash:'c'.repeat(64),attachment_hashes:[],observed_at:new Date(time).toISOString(),expires_at:new Date(time+15000).toISOString(),decision_id:d.id,decision_version:1,scope_hash:hash(scope)};
  reader={read:async()=>{calls++;return {evidence:structuredClone(evidence),revalidate:()=>{if(revoked)throw Error('custody revoked');}};}};
 });
 afterEach(()=>db.close());
 async function bridge(){return messageDelegationService(db,await approvedGmailResolver(db,reader,()=>time).prepare(a,target));}
 async function inspected(){
  const b=await bridge(),i=b.inspectExisting(a,target.decision_id,1,target.draft_id,1);
  const review={approved_context_hash:hash(i.approved_context),draft_context_hash:hash(i.draft_context),interpretation:'operational_provenance_only',scope_explanation:'All send fields remain exactly approved; this is retained provenance only.',segments:[{start:0,end:i.draft_context.length,text:i.draft_context,classification:'provenance_without_authority_change',explanation:'This complete citation records source provenance without changing send authority.'}]};
  return {b,i,input:{...target,inspection_hash:i.inspection_hash,request_key:'one-binding',review}};
 }
 function running(){db.prepare("UPDATE conversation_wakeups SET status='delivered' WHERE id IN (SELECT id FROM bot_decision_events WHERE decision_id=? AND kind='answered')").run(target.decision_id);db.prepare("UPDATE bot_decisions SET state='action_pending' WHERE id=?").run(target.decision_id);bots.result(a,target.decision_id,1,'run',{state:'running',evidence:'Fixture fresh material, ownership and duplicate checks.',material_evidence_unchanged:true});}
 function checks(h:string){return {payload_hash:h,material_evidence_unchanged:true,recipient_account_case_verified:true,lease_and_duplicates_checked:true,evidence:'Fixture current source checks, exclusive ownership and no prior send.'};}
 it('requires an installed native reader, never a bot source assertion',async()=>{
  await expect(approvedGmailResolver(db).prepare(a,target)).rejects.toThrow('native own-account reader unavailable');expect(calls).toBe(0);
  expect(()=>gmailBindSchema.parse({...target,source:evidence})).toThrow();
 });
 it('binds one existing draft prospectively, preserving payload/version and immutable approval',async()=>{
  const before=messages.readDraft(a,target.draft_id),decision=bots.read(a,target.decision_id),events=db.prepare('SELECT * FROM bot_decision_events WHERE decision_id=? ORDER BY rowid').all(target.decision_id);
  const {b,i,input}=await inspected();expect(i.execute).toBe(false);expect(i.approved_payload_hash).not.toBe(i.draft_payload_hash);
  const out=b.bindExisting(a,input);expect(out.execute).toBe(false);
  const after=messages.readDraft(a,target.draft_id);expect(after.payload_json).toBe(before.payload_json);expect(after.version).toBe(before.version);expect(after.state).toBe('queued');
  expect(bots.read(a,target.decision_id)).toEqual(decision);expect(db.prepare('SELECT * FROM bot_decision_events WHERE decision_id=? ORDER BY rowid').all(target.decision_id)).toEqual(events);
  expect(b.bindExisting(a,input)).toMatchObject({replayed:true,execute:false,draft_id:before.id});
  expect(db.prepare('SELECT count(*) n FROM bot_message_drafts').get()).toEqual({n:1});
  expect(()=>db.prepare('DELETE FROM approved_gmail_draft_bindings').run()).toThrow('Permanent');
 });
 it.each(['caller_id','business_id','account','thread_id','reply_message_id','reply_rfc_message_id','latest_inbound_id','scope_hash','source_revision'])('rejects foreign/tampered %s',async(field)=>{
  if(field==='source_revision'){
   const {b,input}=await inspected();b.bindExisting(a,input);evidence.source_revision='d'.repeat(64);
   const fresh=await bridge();expect(()=>fresh.bound(a,messages.readDraft(a,target.draft_id))).toThrow('revision changed');
  }else {evidence[field]=field==='account'?'foreign@example.test':field==='scope_hash'?'d'.repeat(64):'foreign';await expect(bridge()).rejects.toThrow();}
 });
 it.each(['recipients','attachment_hashes'])('rejects changed %s',async(field)=>{evidence[field]=field==='recipients'?['foreign@example.test']:['d'.repeat(64)];await expect(bridge()).rejects.toThrow();});
 it.each(['body','subject','ticket','account','context'])('rejects altered %s after inspection',async(field)=>{
  const {b,input}=await inspected();const d=messages.readDraft(a,target.draft_id),p=JSON.parse(d.payload_json);p[field]+=' changed';
  db.prepare('UPDATE bot_message_drafts SET payload_json=? WHERE id=?').run(JSON.stringify(p),d.id);
  expect(()=>b.bindExisting(a,input)).toThrow();
 });
 it.each(['expired','future','revoked'])('rejects %s source without mutation',async(kind)=>{
  const {b,input}=await inspected();if(kind==='expired')time+=15001;if(kind==='future')time--;if(kind==='revoked')revoked=true;
  expect(()=>b.bindExisting(a,input)).toThrow();expect(messages.readDraft(a,target.draft_id).authorized_by).toBeNull();
 });
 it('requires the original owner, complete citations and supported interpretation',async()=>{
  const {b,input}=await inspected();
  expect(()=>b.bindExisting({...a,conversationId:'foreign'},input)).toThrow();
  expect(()=>b.bindExisting(a,{...input,review:{...input.review,interpretation:'ambiguous'}})).toThrow();
  expect(()=>b.bindExisting(a,{...input,review:{...input.review,segments:[{...input.review.segments[0],end:3,text:'Ret'}]}})).toThrow('Complete');
 });
 it('rejects literal aliases and revoked approver or owner access',async()=>{
  await expect(approvedGmailResolver(db,reader).prepare(a,{...target,thread_id:scope.payload.ticket})).rejects.toThrow();
  const {b,input}=await inspected();db.prepare("UPDATE users SET status='disabled' WHERE id=2").run();expect(()=>b.bindExisting(a,input)).toThrow();
 });
 it('blocks competing drafts and serializes duplicate binding requests',async()=>{
  const {b,input}=await inspected();const other=messages.saveDraft(a,'owner','other',{...scope.payload,context:'Other provenance'},target.decision_id,1);
  expect(()=>b.bindExisting(a,input)).toThrow('Competing');
  db.prepare("UPDATE bot_message_drafts SET state='discarded' WHERE id=?").run(other.id);
  const results=await Promise.all([Promise.resolve().then(()=>b.bindExisting(a,input)),Promise.resolve().then(()=>b.bindExisting(a,input))]);
  expect(results.map(x=>x.replayed)).toEqual([false,true]);
  expect(()=>b.delegate(a,target.decision_id,1,'owner','fallback',scope)).toThrow('existing Gmail');
  expect(()=>b.bindExisting(a,{...input,request_key:'other'})).toThrow('permanently');
 });
 it('retains RUNNING, fresh-source and UNKNOWN fences across claim paths',async()=>{
  const {b,input}=await inspected(),out=b.bindExisting(a,input);
  const check=await approvedGmailResolver(db,reader,()=>time).prepare(a,target),s=communicationService(db,check);
  expect(()=>s.claim(a,target.draft_id,'claim',checks(hash(scope)))).toThrow('RUNNING');
  running();
  const renewed=await approvedGmailResolver(db,reader,()=>time).prepare(a,target),m=communicationService(db,renewed);
  expect(m.claim(a,target.draft_id,'claim',checks(hash(scope))).execute).toBe(true);
  expect(m.claim(a,target.draft_id,'claim').execute).toBe(false);
  m.receipt(a,target.draft_id,'claim','uncertain','Synthetic lost outcome');
  expect(()=>m.claim(a,target.draft_id,'new-key',checks(hash(scope)))).toThrow();
  expect((await bridge()).bindExisting(a,input)).toMatchObject({execute:false,replayed:true,delegation_id:out.delegation_id});
  const other=messages.saveDraft(a,'owner','new-draft',{...scope.payload,context:'copy'},target.decision_id,1);
  expect(()=>m.claim(a,other.id,'escape',checks(hash(scope)))).toThrow('permanently');
 });

 it('serves exact owner routes and denies source assertions or absent installed reader',async()=>{
  const app=express();app.use(express.json());app.use((req,_res,next)=>{req.user=a.user;req.agentConversationId=a.conversationId;next();});
  app.use('/disabled',createCommunicationRouter({db} as AppContext));
  app.use('/fixture',createCommunicationRouter({db} as AppContext,reader));
  const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));
  try{
   const base='http://127.0.0.1:'+((server.address() as any).port);
   const post=(prefix:string,path:string,body:unknown)=>fetch(base+'/'+prefix+'/approved-messages/gmail/'+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
   expect((await post('disabled','inspect',target)).status).toBe(409);expect(calls).toBe(0);
   expect((await post('fixture','inspect',{...target,source:evidence})).status).toBe(400);
   const result=await post('fixture','inspect',target);expect(result.status).toBe(200);const i=await result.json();expect(i.execute).toBe(false);
   const {input}=await inspected();
   const results=await Promise.all([post('fixture','bind',input),post('fixture','bind',input)]);
   expect(results.map(x=>x.status)).toEqual([200,200]);
   const values=await Promise.all(results.map(x=>x.json()));expect(values.every(x=>x.execute===false)).toBe(true);
   expect(new Set(values.map(x=>x.delegation_id)).size).toBe(1);
   expect(()=>db.prepare('UPDATE bot_message_drafts SET version=version+1 WHERE id=?').run(target.draft_id)).toThrow('Immutable');
  }finally{await new Promise<void>(r=>server.close(()=>r()));}
 });
 it('rejects native revision and context drift and revoked owner before source reads',async()=>{
  const {b,input}=await inspected();
  bots.reply(human,target.decision_id,'later','Hold for review');
  expect(()=>b.bindExisting(a,input)).toThrow('Inspection changed');
  const before=calls;db.prepare('UPDATE bot_registrations SET active=0 WHERE conversation_id=?').run(a.conversationId);
  await expect(bridge()).rejects.toThrow();expect(calls).toBe(before);
 });

 it('stops an already bound action on later native discussion without changing its reservation',async()=>{
  const {b,input}=await inspected();b.bindExisting(a,input);
  bots.reply(human,target.decision_id,'later-hold','Hold this reply for review.');
  expect(()=>b.bindExisting(a,input)).toThrow('native context changed');
  expect(db.prepare('SELECT count(*) n FROM approved_gmail_draft_bindings').get()).toEqual({n:1});
 });
 it('strictly parses source evidence without extra caller flags',()=>{expect(gmailSourceSchema.parse(evidence)).toEqual(evidence);expect(()=>gmailSourceSchema.parse({...evidence,authorized:true})).toThrow();});
});
