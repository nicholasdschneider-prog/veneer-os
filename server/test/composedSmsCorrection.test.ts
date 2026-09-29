import fs from 'node:fs';
import {composedSmsCorrection,correctionReviewSchema,verifyCorrectionAuthority} from '../src/bots/composedSmsCorrection.js';
import {fixtureCredentialExpiry} from './composeGuardFixture.js';
import {fixtureGuards} from './composeGuardFixture.js';
import {composedSmsVerifier} from '../src/bots/composedSmsVerifier.js';
import {bindingHash,type ComposeAuthority} from '../src/bots/composedSmsContract.js';
import type {ComposeRegistration} from '../src/bots/composedSmsTrust.js';
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
 const reg:ComposeRegistration={registrationId:'40000000-0000-4000-8000-000000000001',revision:1,active:true,businessId:ids.business,businessOwnerUserId:1,sourceOrigin:'https://orderops-dev-web-production.up.railway.app',runtime:{projectId:ids.business,environmentId:ids.canonical,serviceId:ids.contact},sourceRegistrationHash:'c'.repeat(64),sourceAccountId:evidence.account_id,servicePrincipalId:'dedicated-fixture',serviceCredentialHash:'d'.repeat(64),nativeAudience:'dedicated-fixture-audience',cfClientId:'dedicated-fixture-client',capabilities:['compose.authority.read','compose.permit.redeem','compose.association.read'],executorBindings:[{conversationId:ids.executor,userId:1,principalId:'executor-fixture'}],senderReceiptIssuerId:'fixture-issuer',guardContractHash:'e'.repeat(64),expiresAt:new Date(clock+3600000).toISOString(),credentialExpiry:fixtureCredentialExpiry(),custodyReceipt:'synthetic-only',readbackCredential:{project:'fixture',config:'test',name:'DEDICATED_READBACK'},readbackCustodyReceipt:'synthetic-only'};
 fixtureGuards(reg);
 evidence.dispatch_material_hash='f'.repeat(64);
 evidence.boundary={registration:reg,materialHash:'f'.repeat(64),sender:{receiptId:'50000000-0000-4000-8000-000000000001',revision:1,issuerId:'fixture-issuer',providerAccountId:'AC'+'a'.repeat(32),fromPhone:evidence.sender_phone,expiresAt:new Date(clock+3600000).toISOString()},guardContractHash:reg.guardContractHash,assertFresh:()=>evidence.assertFresh()};
 s=composedSmsService(db,async()=>evidence,()=>clock);
});
afterEach(()=>{vi.useRealTimers();db.close();});

let correction:string;
const correctedBody='Please reply with a photo of the unit you received.';
const correctedPayload={...payload,body:correctedBody};
const direction='Please compose and send the corrected SMS asking only for a photo of the unit received to +12025550111. Use the same account and executor.';
beforeEach(()=>{
 db.prepare("UPDATE bot_message_drafts SET created_at=? WHERE id='draft'").run(new Date(Date.now()-500).toISOString());
 vi.useFakeTimers();vi.setSystemTime(Date.now()+1000);correction=captureHumanMessage(db,ids.owner,1,direction);vi.useRealTimers();
 const proposal=JSON.parse((db.prepare('SELECT proposal_json FROM bot_decisions WHERE id=?').get(decision) as {proposal_json:string}).proposal_json);
 bots.revise(owner,decision,1,'corrected',{...proposal,recommendation:'Photo only',message_delivery:{...proposal.message_delivery,payload:{...proposal.message_delivery.payload,body:correctedBody}}});
 db.prepare("INSERT INTO bot_message_drafts(id,conversation_id,request_key,payload_json) VALUES('corrected',?,'corrected',?)").run(ids.executor,JSON.stringify(correctedPayload));
});
const corrections=()=>composedSmsCorrection(db,async()=>evidence,()=>clock);
const correctionInput=()=>({...input(),draft_id:'corrected',decision_id:decision,expected_decision_version:2,lineage_draft_id:'draft',correction_source_kind:'direct_message' as const,correction_source_id:correction});
const correctionReview=()=>({...review(),instruction_kind:'compose_and_send' as const,correction_instruction:{id:correction,text:direction},send_instruction:{id:correction,text:direction},composition_instruction:{id:correction,text:direction},channel_instruction:{id:correction,text:direction},interpretation:'Human explicitly directs a bounded corrected composition and sending, without another business choice.',parts:[{start:0,end:correctedBody.length,assessment:'supported' as const,human_ids:[correction],message_ids:['email','sms'],explanation:'Only the photo request explicitly directed by the correction.'}]});
async function correctionRequest(){const p=correctionInput(),i=await corrections().inspect(owner,p);return {...p,inspection_hash:i.inspection_hash!,request_key:'correction',review:correctionReview()};}
it('derives real prospective correction authority without rewriting old consumed approval or either draft',async()=>{
 const tables=['bot_decisions','bot_decision_events','bot_conversational_answers','bot_message_drafts','bot_human_messages'];
 const before=tables.map(t=>db.prepare('SELECT * FROM '+t).all());
 await expect(s.inspect(owner,input())).rejects.toThrow('no longer eligible');
 const p=await correctionRequest(),g=await corrections().derive(owner,p);
 expect(g.authority!.schemaVersion).toBe('native-compose-sms-correction/v1');expect(g.execute).toBe(false);expect(g.authority!.payloadHash).toBe(canonicalSha256(correctedPayload));expect(g.authority!.sourceInstructionHash).not.toBe((db.prepare('SELECT source_hash FROM bot_conversational_answers').get() as any).source_hash);
 expect(tables.map(t=>db.prepare('SELECT * FROM '+t).all())).toEqual(before);
 expect(db.prepare('SELECT count(*) n FROM bot_composed_sms_dispatch_authorities').get()).toEqual({n:0});
 await expect(s.accept(executor,g.authority_id,'accept',canonicalSha256(correctedPayload))).rejects.toThrow('CORRECTION_AUTHORITY_EXPORT_UNAVAILABLE');
 await expect(s.claim(executor,g.authority_id,'claim',{})).rejects.toThrow('CORRECTION_AUTHORITY_EXPORT_UNAVAILABLE');
 expect(()=>s.serviceCurrent(g.authority_id)).toThrow('CORRECTION_AUTHORITY_EXPORT_UNAVAILABLE');
 expect(s.reconcile(owner,g.authority_id).proof_kind).toBe('native-compose-sms-correction/v1');
});
it.each(['wording_edit','status_question','quoted_or_reported','conditional','ambiguous'] as const)('denies original-owner interpretation %s rather than treating it as send consent',async instruction_kind=>{
 const p=await correctionRequest();await expect(corrections().derive(owner,{...p,review:{...p.review,instruction_kind}})).rejects.toThrow('AND sending');expect(db.prepare('SELECT count(*) n FROM bot_composed_sms_authorities').get()).toEqual({n:0});
});
it('does not reuse old email/channel approval for correction sending or accept invented quotations',async()=>{
 const p=await correctionRequest();await expect(corrections().derive(owner,{...p,review:{...p.review,send_instruction:review().channel_instruction}})).rejects.toThrow('Correction itself');
 await expect(corrections().derive(owner,{...p,review:{...p.review,correction_instruction:{id:correction,text:'Fabricated direction'}}})).rejects.toThrow('authenticated');
 await expect(corrections().derive(owner,{...p,review:{...p.review,unresolved_choices:['Unclear recipient']}})).rejects.toThrow('AND sending');
 await expect(corrections().derive(owner,{...p,review:{...p.review,parts:[{...p.review.parts[0],assessment:'unsupported'}]}})).rejects.toThrow('body span');
});
it.each(['body','recipients','account','channel','customer','ticket','version'] as const)('rejects changed corrected %s after inspection',async field=>{
 const p=await correctionRequest();if(field==='version')db.prepare("UPDATE bot_message_drafts SET version=2 WHERE id='corrected'").run();else db.prepare("UPDATE bot_message_drafts SET payload_json=? WHERE id='corrected'").run(JSON.stringify({...correctedPayload,[field]:field==='recipients'?['+12025550999']:'changed'}));
 await expect(corrections().derive(owner,p)).rejects.toThrow();
});
it('rejects unauthorized owner and changed original executor',async()=>{
 await expect(corrections().inspect(executor,correctionInput())).rejects.toThrow('original source-owning');
 await expect(corrections().inspect(owner,{...correctionInput(),executor_conversation_id:ids.other})).rejects.toThrow();
});
it.each(['human','owner','executor','source','sender','phone','business'] as const)('fails closed after %s revocation/drift',async kind=>{
 const p=await correctionRequest();
 if(kind==='human')db.prepare("UPDATE users SET status='disabled' WHERE id=1").run();
 if(kind==='owner'||kind==='executor')db.prepare('UPDATE bot_registrations SET active=0 WHERE conversation_id=?').run(kind==='owner'?ids.owner:ids.executor);
 if(kind==='source')allow=false;if(kind==='sender')evidence.sender_verified=false;if(kind==='phone')evidence.projection.cases[1]!.customer.phone='+12025550999';if(kind==='business')evidence.business_id=ids.other;
 await expect(corrections().derive(owner,p)).rejects.toThrow();
});
it('rejects newer human context and a same-version context edit',async()=>{
 const p=await correctionRequest();expect(()=>db.prepare('UPDATE bot_human_messages SET text=? WHERE id=?').run(direction+' Extra.',correction)).toThrow('immutable');
 db.prepare('UPDATE bot_decisions SET handling_revision=handling_revision+1 WHERE id=?').run(decision);await expect(corrections().derive(owner,p)).rejects.toThrow('changed');
 vi.useFakeTimers();vi.setSystemTime(Date.now()+2000);captureHumanMessage(db,ids.owner,1,'Wait, do not send.');vi.useRealTimers();await expect(corrections().inspect(owner,correctionInput())).rejects.toThrow('supersedes');
});
it('dedupes concurrent derive, copied drafts and different keys with durable shared action fence',async()=>{
 const p=await correctionRequest(),results=await Promise.all([corrections().derive(owner,p),corrections().derive(owner,p)]);expect(results[0].authority_id).toBe(results[1].authority_id);expect(results[1].replayed).toBe(true);
 await expect(corrections().derive(owner,{...p,request_key:'replacement'})).rejects.toThrow('already reserved');
 db.prepare("INSERT INTO bot_message_drafts(id,conversation_id,request_key,payload_json) VALUES('copy',?,'copy',?)").run(ids.executor,JSON.stringify(correctedPayload));const cp={...correctionInput(),draft_id:'copy'},ci=await corrections().inspect(owner,cp);
 await expect(corrections().derive(owner,{...p,...cp,inspection_hash:ci.inspection_hash,request_key:'copy'})).rejects.toThrow('already reserved');
 s.revoke(owner,results[0].authority_id,'revoke','Human direction withdrawn');expect(s.reconcile(owner,results[0].authority_id).state).toBe('revoked');
 await expect(corrections().derive(owner,{...p,request_key:'after-revoke'})).rejects.toThrow('already reserved');
});
it('blocks prior effect/UNKNOWN across different payloads and copied draft IDs',async()=>{
 db.prepare("INSERT INTO bot_message_drafts(id,conversation_id,request_key,payload_json,state,claim_key) VALUES('unknown',?,'unknown',?,'sending','existing-claim')").run(ids.executor,JSON.stringify(payload));
 await expect(corrections().inspect(owner,correctionInput())).rejects.toThrow('UNKNOWN');
});
it('refreshes native context inside the immediate recording transaction after source await',async()=>{
 const p=await correctionRequest();const racing=composedSmsCorrection(db,async()=>{db.prepare("UPDATE bot_message_drafts SET version=version+1 WHERE id='corrected'").run();return evidence;},()=>clock);
 await expect(racing.derive(owner,p)).rejects.toThrow();expect(db.prepare('SELECT count(*) n FROM bot_composed_sms_authorities').get()).toEqual({n:0});
});
it('strictly rejects unsupported request keys and never accepts imported source evidence',async()=>{
 await expect(corrections().inspect(owner,{...correctionInput(),evidence})).rejects.toThrow();
 expect(correctionReviewSchema.safeParse({...correctionReview(),same_case:true}).success).toBe(false);
});
it.each([
 ['Please change the wording to ask only for a photo.','wording_edit'],
 ['So you sent that?','status_question'],
 ['The earlier bot said "send it".','quoted_or_reported'],
 ['Send this if the customer confirms the phone number.','conditional'],
 ['Maybe use that reply.','ambiguous'],
] as const)('rejects reviewed human message %s without keyword approval',async(text,instruction_kind)=>{
 vi.useFakeTimers();vi.setSystemTime(Date.now()+3000);const latest=captureHumanMessage(db,ids.owner,1,text);vi.useRealTimers();
 const p={...correctionInput(),correction_source_id:latest},i=await corrections().inspect(owner,p),cite={id:latest,text};
 await expect(corrections().derive(owner,{...p,inspection_hash:i.inspection_hash!,request_key:'no',review:{...correctionReview(),instruction_kind,correction_instruction:cite,send_instruction:cite,composition_instruction:cite,channel_instruction:cite,parts:[{...correctionReview().parts[0],human_ids:[latest]}]}})).rejects.toThrow('AND sending');
});
it.each([null,ids.executor])('uses native result-reply authorship and anchor, bot actor=%s',async actor=>{
 db.prepare("INSERT INTO bot_message_threads(id,conversation_id,anchor,source_text) VALUES('thread',?,'original-result','Complete original result')").run(ids.owner);
 db.prepare("INSERT INTO bot_message_replies(id,thread_id,actor_id,actor_conversation_id,text,request_key,created_at) VALUES('reply','thread',1,?,?,'reply',?)").run(actor,direction,new Date(Date.now()+3000).toISOString());
 const p={...correctionInput(),correction_source_kind:'result_reply' as const,correction_source_id:'reply'};
 if(actor){await expect(corrections().inspect(owner,p)).rejects.toThrow('authenticated human');return;}
 const i=await corrections().inspect(owner,p),cite={id:'reply',text:direction};expect(i.correction.anchor).toEqual({original_result:'Complete original result',anchor:'original-result'});
 const result=await corrections().derive(owner,{...p,inspection_hash:i.inspection_hash!,request_key:'reply',review:{...correctionReview(),correction_instruction:cite,send_instruction:cite,composition_instruction:cite,channel_instruction:cite,parts:[{...correctionReview().parts[0],human_ids:['reply']}]}});
 expect(result.authority!.sourceInstructionHash).toBe(canonicalSha256(i.correction));
});
it('blocks expired sender and credentials instead of granting a fresh authority window',async()=>{
 const p=await correctionRequest();clock=Date.parse(evidence.boundary!.sender.expiresAt);
 await expect(corrections().derive(owner,p)).rejects.toThrow('expired');
});
it('preserves cross-proof durable dedupe even for revoked or UNKNOWN historical authority',async()=>{
 const p=await correctionRequest(),action=canonicalSha256({business_id:ids.business,decision_id:decision,channel:'sms'});
 db.prepare("INSERT INTO bot_composed_sms_authorities(id,action_id,owner_id,executor_id,source_id,draft_id,request_key,request_hash,snapshot_json,expires_at) VALUES('prior',?,?,?,?,?,'prior',?,'{}',?)").run(action,ids.owner,ids.executor,source,'draft','a'.repeat(64),new Date(clock+60000).toISOString());
 db.prepare("INSERT INTO bot_composed_sms_events(authority_id,kind,actor_id,actor_conversation_id,request_key,payload_json) VALUES('prior','unknown',1,?,'unknown','{}')").run(ids.executor);
 await expect(corrections().derive(owner,p)).rejects.toThrow('already reserved');
 expect(db.prepare('SELECT count(*) n FROM bot_composed_sms_authorities').get()).toEqual({n:1});
});
it('ordinary claim cannot bypass prospective correction authority',async()=>{
 const g=await corrections().derive(owner,await correctionRequest());
 expect(()=>communicationService(db).claim(executor,'corrected','attempt')).toThrow('separate derived authority');
 expect(()=>db.prepare("UPDATE bot_composed_sms_authorities SET snapshot_json='{}' WHERE id=?").run(g.authority_id)).toThrow('immutable');
 expect(()=>db.prepare('DELETE FROM bot_composed_sms_authorities WHERE id=?').run(g.authority_id)).toThrow('immutable');
});

it('reconciles a lost response read-only with original key despite expired sender or later context',async()=>{
 const p=await correctionRequest(),g=await corrections().derive(owner,p);allow=false;clock+=3600000;
 const read=composedSmsCorrection(db,async()=>{throw Error('No source reads allowed');},()=>clock);
 const receipt=read.reconcile(owner,{decision_id:decision,source_id:source,request_key:p.request_key});
 expect(receipt).toMatchObject({recorded:true,authority_id:g.authority_id,expired:true,execute:false,ready:false,source_current:'not_checked'});
 expect(()=>read.reconcile(owner,{decision_id:'wrong',source_id:source,request_key:p.request_key})).toThrow('different immutable');
 expect(read.reconcile(executor,{decision_id:decision,source_id:source,request_key:p.request_key}).recorded).toBe(false);
 expect(db.prepare('SELECT count(*) n FROM bot_composed_sms_authorities').get()).toEqual({n:1});
});
it('pins a strict synthetic correction vector and rejects tampered authority/source/payload commitments',()=>{
 const fixture=JSON.parse(fs.readFileSync(fileURLToPath(new URL('../../docs/reports/composed-sms/build450/synthetic-correction-v1.json',import.meta.url)),'utf8'));
 expect(verifyCorrectionAuthority(fixture.authority).authorityHash).toBe('92a99ca88187409cdd8d1a8e06b1532b0936845d19c47e596e2e06f9e31d766e');
 expect(fixture.authority.payloadHash).toBe(canonicalSha256(fixture.payload));
 for(const field of ['sourceInstructionHash','contextHash','payloadHash','reviewHash','historicalConsumptionHash','nativeBindingHash','materialHash','wirePayloadHash'])expect(()=>verifyCorrectionAuthority({...fixture.authority,[field]:'0'.repeat(64)})).toThrow();
 expect(()=>verifyCorrectionAuthority({...fixture.authority,unknown:true})).toThrow();
});

it('returns complete native correction context but no derivation hash when source evidence is unavailable',async()=>{
 const {BotError}=await import('../src/bots/service.js');const c=composedSmsCorrection(db,async()=>{throw new BotError(503,'SMS_SENDER_OWNERSHIP_UNVERIFIED: expired receipt');},()=>clock);
 const i=await c.inspect(owner,correctionInput());expect(i.inspection_hash).toBe(null);expect(i.ready_for_authority_review).toBe(false);expect(i.correction.source.text).toBe(direction);expect(i.full_context.direct_messages.length).toBeGreaterThan(1);
 await expect(c.derive(owner,{...correctionInput(),inspection_hash:'a'.repeat(64),request_key:'no',review:correctionReview()})).rejects.toThrow('expired receipt');
});
