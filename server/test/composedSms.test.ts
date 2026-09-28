import {communicationService} from '../src/bots/communication.js';
import Database from 'better-sqlite3';
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {fileURLToPath} from 'node:url';
import {migrate} from '../src/db/migrate.js';
import {createBotService,type Actor} from '../src/bots/service.js';
import {captureHumanMessage} from '../src/bots/humanMessages.js';
import {composedSmsService,type CompositionEvidence,type ComposedInput} from '../src/bots/composedSms.js';
import {canonicalSha256} from '../src/bots/canonical.js';
import type {UserRow} from '../src/db/db.js';
const ids={owner:'10000000-0000-4000-8000-000000000001',executor:'10000000-0000-4000-8000-000000000002',other:'10000000-0000-4000-8000-000000000003',business:'20000000-0000-4000-8000-000000000001',canonical:'30000000-0000-4000-8000-000000000001',contact:'30000000-0000-4000-8000-000000000002'};
let db:Database.Database,owner:Actor,executor:Actor,human:Actor,s:ReturnType<typeof composedSmsService>,bots:ReturnType<typeof createBotService>,source:string,composition:string,decision:string,evidence:CompositionEvidence,clock:number,allow=true;
const body='Please send photos of what arrived and what is missing.';
const payload={channel:'sms',account:'Synthetic SMS +12025550100',recipients:['+12025550111'],subject:'',body,attachments:[],customer:'Synthetic person',ticket:'PHONE',context:'Reference only'};
const input=():ComposedInput=>({source_id:source,draft_id:'draft',expected_draft_version:1,executor_conversation_id:ids.executor,canonical_case:ids.canonical,contact_case:ids.contact});
const review=()=>({mode:'compose_and_send' as const,reviewed_full_context:true as const,recipient_instruction:{id:composition,text:'Ask for photos of what arrived and what is missing. Reply to +12025550111.'},composition_instruction:{id:composition,text:'Ask for photos of what arrived and what is missing. Reply to +12025550111.'},channel_instruction:{id:source,text:'Send the email and SMS as well.'},purpose:'Obtain photos and missing-parts description',relationship_explanation:'Customer messages identify the same request and specific phone, not a merged customer record',customer_message_ids:['email','sms'],parts:[{start:0,end:body.length,assessment:'supported' as const,human_ids:[composition],message_ids:['email','sms'],explanation:'Implements the bounded request without a remedy or new commitment'}],unresolved_choices:[]});
beforeEach(()=>{
 db=new Database(':memory:');migrate(db,fileURLToPath(new URL('../src/db/migrations',import.meta.url)));
 db.prepare("INSERT INTO users(id,email,display_name,role) VALUES(1,'fixture@test','Human','owner')").run();db.prepare('INSERT INTO business_teams(id,name,owner_id) VALUES(?,?,1)').run(ids.business,'Fixture');
 for(const c of [ids.owner,ids.executor,ids.other]){db.prepare("INSERT INTO conversations(id,assistant_id,user_id,title,provider,native_session_id,visibility,business_team_id) VALUES(?,1,1,?,'codex',?,'team',?)").run(c,c,c,ids.business);db.prepare('INSERT INTO bot_registrations(conversation_id,name,active,registered_by) VALUES(?,?,1,1)').run(c,c);}
 human={user:db.prepare('SELECT * FROM users WHERE id=1').get() as UserRow};owner={...human,conversationId:ids.owner};executor={...human,conversationId:ids.executor};bots=createBotService(db);
 decision=bots.raise(owner,{source_key:'case',proposal_key:'email',proposal:{question:'Send exact email?',recommendation:'Photos',consequence:'Customer reply',blocked_action:'Only this email',assignee_id:1,evidence:[],message_delivery:{canonical_case:ids.canonical,executor_conversation_id:ids.owner,payload:{...payload,channel:'email',account:'fixture@example.test',recipients:['customer@example.test'],ticket:'EMAIL'}}}}).id;
 vi.useFakeTimers(); vi.setSystemTime(Date.now()-2000);
 composition=captureHumanMessage(db,ids.owner,1,'Ask for photos of what arrived and what is missing. Reply to +12025550111.');vi.setSystemTime(Date.now()+1000);source=captureHumanMessage(db,ids.owner,1,'Send the email and SMS as well.');
 vi.useRealTimers();
 const ci=bots.inspectConversationalDecision(owner,decision,1,'direct_message',source);bots.recordConversationalDecision(owner,decision,1,'direct_message',source,ci.inspection_hash!,'approve',true);
 db.prepare("INSERT INTO bot_message_drafts(id,conversation_id,request_key,payload_json,created_at) VALUES('draft',?,'ordinary',?,'2099-01-01 00:00:00')").run(ids.executor,JSON.stringify(payload));
 clock=Date.now();allow=true;
 evidence={projection:{cases:[{id:ids.canonical,ticketNumber:'EMAIL',customerId:'customer-one',relatedOrderId:null,customer:{phone:null}},{id:ids.contact,ticketNumber:'PHONE',customerId:'customer-two',relatedOrderId:null,customer:{phone:payload.recipients[0]!}}],messages:[{id:'email',conversationId:ids.canonical,direction:'inbound',channel:'email',messageType:'message',body:'Order fixture, my phone is +12025550111.',fromPhone:null,actorType:null,actorId:null,agentId:null,aiGenerated:false},{id:'sms',conversationId:ids.contact,direction:'inbound',channel:'sms',messageType:'message',body:'Same order fixture.',fromPhone:payload.recipients[0]!,actorType:null,actorId:null,agentId:null,aiGenerated:false}]},snapshot_hash:'a'.repeat(64),registration_hash:'b'.repeat(64),business_id:ids.business,account_id:'source-account',principal_id:'fixture',sms_account:payload.account,sender_phone:'+12025550100',sender_verified:true,dispatch:{supported:true,contract:'native-compose-sms/v1',revision:'fixture-accepted-transport',reason:'Synthetic fenced transport only'},assertFresh(){if(!allow)throw Error('Source authority revoked');}};
 s=composedSmsService(db,async()=>evidence,()=>clock);
});
afterEach(()=>{vi.useRealTimers();db.close();});
async function request(){const inspected=await s.inspect(owner,input());return {...input(),inspection_hash:inspected.inspection_hash,request_key:'derive',review:review()};}
async function derive(){return s.derive(owner,await request());}
async function accept(){const g=await derive();await s.accept(executor,g.authority_id,'accept',canonicalSha256(payload));return g;}
const check=()=>({payload_hash:canonicalSha256(payload),material_evidence_unchanged:true,recipient_account_case_verified:true,lease_and_duplicates_checked:true,evidence:'Synthetic exact lease, latest both-channel context, suppression, local-time and duplicates verified'});
it('consumes real typed evidence and original owner review, preserves email and ordinary draft, then claims once',async()=>{
 const email=db.prepare('SELECT * FROM bot_decisions').get(),draft=db.prepare('SELECT * FROM bot_message_drafts').get(),answer=db.prepare('SELECT * FROM bot_conversational_answers').get();
 const g=await accept();const claim=await s.claim(executor,g.authority_id,'claim',check());expect(claim.execute).toBe(true);
 expect((await s.claim(executor,g.authority_id,'different',check())).execute).toBe(false);expect(s.reconcile(executor,g.authority_id).state).toBe('unknown');
 expect(db.prepare("SELECT count(*) n FROM bot_composed_sms_events WHERE kind='claimed'").get()).toEqual({n:1});
 expect(db.prepare('SELECT * FROM bot_decisions').get()).toEqual(email);expect(db.prepare('SELECT * FROM bot_message_drafts').get()).toEqual(draft);expect(db.prepare('SELECT * FROM bot_conversational_answers').get()).toEqual(answer);
});
it('does not regard later drafting as disqualifying, but denies channel-only or ambiguous instruction',async()=>{
 const p=await request();await expect(s.derive(owner,{...p,review:{...p.review,mode:'channel_only'}})).rejects.toThrow('discretion');
 await expect(s.derive(owner,{...p,review:{...p.review,unresolved_choices:['New refund promise']}})).rejects.toThrow('material choice');
 await expect(s.derive(owner,{...p,review:{...p.review,composition_instruction:p.review.channel_instruction}})).rejects.toThrow('substantive');
 expect((await s.derive(owner,p)).state).toBe('derived');
});
it.each(['unsupported','ambiguous'])('refuses %s substantive additions even if owner asks to derive',async assessment=>{
 const p=await request();await expect(s.derive(owner,{...p,review:{...p.review,parts:[{...p.review.parts[0]!,assessment:assessment as 'unsupported'|'ambiguous'}]}})).rejects.toThrow('draft character');
});
it('rejects forged citations, partial body review and bot notes as customer evidence',async()=>{
 const p=await request();await expect(s.derive(owner,{...p,review:{...p.review,composition_instruction:{id:composition,text:'Invented authority'}}})).rejects.toThrow('authenticated');
 await expect(s.derive(owner,{...p,review:{...p.review,parts:[{...p.review.parts[0]!,end:body.length-1}]}})).rejects.toThrow('Incomplete');
 evidence.projection.messages[1]!.actorType='bot';await expect(s.derive(owner,p)).rejects.toThrow('customer-origin');
});
it('denies wrong owner, executor and receipt impersonation',async()=>{
 await expect(s.inspect(executor,input())).rejects.toThrow();const g=await derive();await expect(s.accept(owner,g.authority_id,'accept',canonicalSha256(payload))).rejects.toThrow('executor');
 expect(()=>s.reconcile({...owner,conversationId:ids.other},g.authority_id)).toThrow('executor');
});
it.each(['phone','business','canonical'])('rejects %s source mismatches',async field=>{
 if(field==='phone')evidence.projection.cases[1]!.customer.phone='+12025550999';if(field==='account')evidence.sms_account='other';if(field==='sender')evidence.sender_verified=false;if(field==='business')evidence.business_id=ids.other;if(field==='canonical')evidence.projection.cases[0]!.id=ids.other;
 await expect(s.inspect(owner,input())).rejects.toThrow('evidence');
});
it('dedupes copied drafts and changed request keys by source action, not draft id',async()=>{
 const p=await request(),g=await s.derive(owner,p);expect((await s.derive(owner,p)).authority_id).toBe(g.authority_id);
 await expect(s.derive(owner,{...p,request_key:'new'})).rejects.toThrow('already has');
 db.prepare("INSERT INTO bot_message_drafts(id,conversation_id,request_key,payload_json) VALUES('copy',?,'copy',?)").run(ids.executor,JSON.stringify(payload));
 const copy={...input(),draft_id:'copy'},inspection=await s.inspect(owner,copy);
 await expect(s.derive(owner,{...p,...copy,request_key:'copy',inspection_hash:inspection.inspection_hash})).rejects.toThrow('already has');
});
it('serializes two preflighted claims and keeps lost responses UNKNOWN without repeat',async()=>{
 const g=await accept();const claims=await Promise.all([s.claim(executor,g.authority_id,'one',check()),s.claim(executor,g.authority_id,'two',check())]);
 expect(claims.filter(x=>x.execute)).toHaveLength(1);expect(s.reconcile(executor,g.authority_id)).toMatchObject({state:'unknown',execute:false});
});
it.each(['context','body','version','source','transport','custody','expiry','revocation'])('denies %s drift before claim',async kind=>{
 const g=await accept();if(kind==='context')captureHumanMessage(db,ids.owner,1,'Hold.');if(kind==='body')db.prepare('UPDATE bot_message_drafts SET payload_json=?').run(JSON.stringify({...payload,body:'changed'}));if(kind==='version')db.prepare('UPDATE bot_message_drafts SET version=2').run();if(kind==='source')evidence.snapshot_hash='c'.repeat(64);if(kind==='transport')evidence.dispatch.revision='changed';if(kind==='custody')allow=false;if(kind==='expiry')clock+=31*60_000;if(kind==='revocation')s.revoke(owner,g.authority_id,'revoke','Human withdrew direction');
 await expect(s.claim(executor,g.authority_id,'claim',check())).rejects.toThrow();expect(db.prepare("SELECT count(*) n FROM bot_composed_sms_events WHERE kind='claimed'").get()).toEqual({n:0});
});
it('can derive while dispatch remains explicitly unsupported, without consuming the attempt',async()=>{
 evidence.dispatch={supported:false,contract:null,revision:'legacy',reason:'Missing native action, executor and sender binding'};
 const g=await accept();await expect(s.claim(executor,g.authority_id,'claim',check())).rejects.toThrow('SOURCE_NATIVE_ACTION_TRANSPORT_UNAVAILABLE');
 expect(db.prepare("SELECT count(*) n FROM bot_composed_sms_events WHERE kind='claimed'").get()).toEqual({n:0});
});
it('records exact receipt once, rejects claim-key/provider conflicts, and never reopens a sent action',async()=>{
 const g=await accept(),c=await s.claim(executor,g.authority_id,'claim',check());if(!('claim_key' in c))throw Error('fixture claim missing');
 const proof={provider:'fixture',provider_message_id:'fixture-sid',account:payload.account,recipients:payload.recipients,canonical_case:ids.canonical,payload_hash:canonicalSha256(payload),idempotency_key:c.idempotency_key,verified:true};
 expect(()=>s.delivery(executor,g.authority_id,'receipt','wrong',proof)).toThrow('mismatch');
 expect(s.delivery(executor,g.authority_id,'receipt',c.claim_key,proof).state).toBe('sent');expect(s.delivery(executor,g.authority_id,'receipt',c.claim_key,proof).state).toBe('sent');
 expect(()=>s.delivery(executor,g.authority_id,'receipt',c.claim_key,{...proof,provider_message_id:'other'})).toThrow('Conflicting');
 expect((await s.claim(executor,g.authority_id,'again',check())).execute).toBe(false);
});

it('exposes sender proof gap during inspection and blocks derivation',async()=>{evidence.sender_verified=false;const i=await s.inspect(owner,input());expect(i.missing_proof).toContain('SMS_SENDER_OWNERSHIP_UNVERIFIED');await expect(s.derive(owner,{...input(),inspection_hash:i.inspection_hash,request_key:'deny',review:review()})).rejects.toThrow('unverified');});

it('never equates email executor with separately reviewed SMS executor',async()=>{
 // The email executor is immutable evidence, not a requirement to reassign SMS.
 const g=await derive();expect(g.scope.executor_conversation_id).toBe(ids.executor);
});
it('rejects expired or revoked original participants before deriving',async()=>{
 const p=await request();db.prepare('UPDATE bot_registrations SET active=0 WHERE conversation_id=?').run(ids.executor);
 await expect(s.derive(owner,p)).rejects.toThrow();
});

it('serializes against ordinary drafts and copied-payload claims without authorizing them',async()=>{
 const g=await derive();expect(()=>communicationService(db).claim(executor,'draft','ordinary')).toThrow('separate derived authority');
 db.prepare("INSERT INTO bot_message_drafts(id,conversation_id,request_key,payload_json,state,claim_key) VALUES('possible-effect',?,'other',?,'uncertain','existing')").run(ids.executor,JSON.stringify(payload));
 await expect(s.accept(executor,g.authority_id,'accept',canonicalSha256(payload))).rejects.toThrow('UNKNOWN');
});
