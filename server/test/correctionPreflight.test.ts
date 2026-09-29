import Database from 'better-sqlite3';
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {fileURLToPath} from 'node:url';
import {migrate} from '../src/db/migrate.js';
import {createBotService,type Actor} from '../src/bots/service.js';
import {captureHumanMessage} from '../src/bots/humanMessages.js';
import {correctionPreflight} from '../src/bots/correctionPreflight.js';
import type {UserRow} from '../src/db/db.js';
let db:Database.Database,bots:ReturnType<typeof createBotService>,s:ReturnType<typeof correctionPreflight>,owner:Actor,human:Actor,decision:string,original:string,correction:string;
const direction='Compose and send a corrected reply asking only for a photo of the received unit.';
const input=()=>({decision_id:decision,expected_version:2,original_source_id:original,correction_source_kind:'direct_message',correction_source_id:correction});
function message(text:string,offset:number){vi.useFakeTimers();vi.setSystemTime(Date.now()+offset);const id=captureHumanMessage(db,'owner',1,text);vi.useRealTimers();return id;}
beforeEach(()=>{
 db=new Database(':memory:');migrate(db,fileURLToPath(new URL('../src/db/migrations',import.meta.url)));
 db.prepare("INSERT INTO users(id,email,display_name,role) VALUES(1,'fixture@test','Fixture','owner'),(2,'other@test','Other','member')").run();
 for(const id of ['owner','executor'])db.prepare("INSERT INTO conversations(id,assistant_id,user_id,title,provider,native_session_id,visibility) VALUES(?,1,1,?,'codex',?,'team')").run(id,id,id);
 human={user:db.prepare('SELECT * FROM users WHERE id=1').get() as UserRow};owner={...human,conversationId:'owner'};
 bots=createBotService(db);bots.register(human,'owner','Owner',true);bots.register(human,'executor','Executor',true);
 const proposal={question:'Send the email?',recommendation:'Ask for photos and description',consequence:'Customer reply',blocked_action:'This email only',assignee_id:1,evidence:[]};
 decision=bots.raise(owner,{source_key:'case',proposal_key:'email',proposal}).id;
 original=message('Send the exact email and SMS.',-3000);
 const i=bots.inspectConversationalDecision(owner,decision,1,'direct_message',original);bots.recordConversationalDecision(owner,decision,1,'direct_message',original,i.inspection_hash!,'approve',true);
 correction=message(direction,-1000);bots.revise(owner,decision,1,'correction',{...proposal,recommendation:'Only a photo of the unit'});
 s=correctionPreflight(db);
});
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();db.close();});
function review(){const i=s.inspect(owner,input());return {...input(),inspection_hash:i.inspection_hash,reviewed_full_context:true,correction:{kind:'direct_message',id:correction,text:direction},interpretation:'compose_and_send_direction',explanation:'Reviewed the complete correction and context as a bounded compose-and-send direction.',later_context:i.later_human_context.map(m=>({citation:{kind:m.kind,id:m.id,text:m.text},classification:'status_only',explanation:'This asks about progress only and provides no consent.'}))};}
it('reviews complete native correction with no draft, credential, source or writes',()=>{
 const fetch=vi.fn(()=>{throw Error('No network');});vi.stubGlobal('fetch',fetch);
 expect(db.prepare('SELECT count(*) n FROM bot_message_drafts').get()).toEqual({n:0});
 const before=db.serialize();db.pragma('query_only=ON');const first=s.inspect(owner,input()),second=s.inspect(owner,input());expect(first).toEqual(second);
 expect(first.coverage.complete).toBe(true);expect(first.context.direct_messages).toHaveLength(2);
 const result=s.review(owner,review());expect(result).toMatchObject({assessment:'direction_retained_for_semantic_review',execute:false,ready:false,authority:false,recorded:false});
 expect(s.review(owner,review())).toEqual(result);expect(fetch).not.toHaveBeenCalled();expect(db.serialize()).toEqual(before);
});
it('later status does not automatically supersede and supplies no consent',()=>{
 const status=message('So you sent that?',1000),r=review();expect(r.later_context[0]!.citation.id).toBe(status);
 expect(s.review(owner,r)).toMatchObject({assessment:'direction_retained_for_semantic_review',authority:false});
 expect(()=>s.review(owner,{...r,later_context:[]})).toThrow('every later');
});
it('substantive or ambiguous later context is explicitly unresolved without keyword classification',()=>{
 message('Wait, send it to a different person.',1000);const r=review();
 expect(s.review(owner,{...r,later_context:r.later_context.map(x=>({...x,classification:'substantive_supersession'}))}).assessment).toBe('substantively_superseded');
 expect(s.review(owner,{...r,later_context:r.later_context.map(x=>({...x,classification:'ambiguous'}))}).assessment).toBe('unresolved');
});
it.each(['wording_edit_only','status_only','quoted_or_reported','conditional','ambiguous'])('semantic interpretation %s never becomes consent',interpretation=>{
 const result=s.review(owner,{...review(),interpretation});expect(result.authority).toBe(false);expect(result.ready).toBe(false);expect(result.execute).toBe(false);expect(result.assessment).not.toBe('direction_retained_for_semantic_review');
});
it('cannot forge or excerpt correction/later citations or omit later surfaces',()=>{
 message('So you sent that?',1000);const r=review();
 expect(()=>s.review(owner,{...r,correction:{...r.correction,text:'Send'}})).toThrow('complete correction');
 expect(()=>s.review(owner,{...r,later_context:[{...r.later_context[0],citation:{...r.later_context[0]!.citation,text:'sent'}}]})).toThrow('complete later');
 expect(()=>s.review(owner,{...r,later_context:[r.later_context[0],r.later_context[0]]})).toThrow('duplicates');
});
it.each(['new_message','version','handling','proposal'])('rejects %s drift after inspection',kind=>{
 const r=review();if(kind==='new_message')message('Another question',1000);
 if(kind==='version')db.prepare('UPDATE bot_decisions SET version=3 WHERE id=?').run(decision);
 if(kind==='handling')db.prepare('UPDATE bot_decisions SET handling_revision=handling_revision+1 WHERE id=?').run(decision);
 if(kind==='proposal')db.prepare("UPDATE bot_decisions SET proposal_json=json_set(proposal_json,'$.recommendation','Changed') WHERE id=?").run(decision);
 expect(()=>s.review(owner,r)).toThrow(/changed/);
});
it.each(['author','owner'])('rejects revoked %s',kind=>{
 const r=review();if(kind==='author')db.prepare("UPDATE users SET status='disabled' WHERE id=1").run();else db.prepare("UPDATE bot_registrations SET active=0 WHERE conversation_id='owner'").run();expect(()=>s.review(owner,r)).toThrow();
});
it('rejects wrong owner, executor injection, lineage, correction kind and bot sources',()=>{
 expect(()=>s.inspect({...owner,conversationId:'executor'},input())).toThrow('owning');
 expect(()=>s.inspect(owner,{...input(),executor_conversation_id:'executor'})).toThrow();
 expect(()=>s.inspect(owner,{...input(),original_source_id:correction})).toThrow('lineage');
 expect(()=>s.inspect(owner,{...input(),correction_source_id:original})).toThrow('later authenticated');
 db.prepare("INSERT INTO bot_message_threads(id,conversation_id,anchor,source_text) VALUES('t','owner','a','Original complete result')").run();
 db.prepare("INSERT INTO bot_message_replies(id,thread_id,actor_id,actor_conversation_id,text,request_key,created_at) VALUES('bot','t',1,'executor','Send','bot','2099-01-01')").run();
 expect(()=>s.inspect(owner,{...input(),correction_source_kind:'result_reply',correction_source_id:'bot'})).toThrow('human correction');
});
it('retains full result anchors and bot context but never treats bot replies as human consent',()=>{
 db.prepare("INSERT INTO bot_message_threads(id,conversation_id,anchor,source_text) VALUES('t','owner','a','Full original result, with unrelated context retained')").run();
 db.prepare("INSERT INTO bot_message_replies(id,thread_id,actor_id,text,request_key,created_at) VALUES('human','t',1,?,'h','2099-01-01')").run(direction);
 db.prepare("INSERT INTO bot_message_replies(id,thread_id,actor_id,actor_conversation_id,text,request_key,created_at) VALUES('bot','t',1,'executor','Quoted send','b','2099-01-02')").run();
 const p={...input(),correction_source_kind:'result_reply',correction_source_id:'human'},i=s.inspect(owner,p);
 expect(i.correction.source_text).toContain('Full original result');expect(i.context.result_replies).toHaveLength(2);expect(i.later_human_context).toHaveLength(0);
 expect(s.review(owner,{...review(),...p,inspection_hash:i.inspection_hash,correction:{kind:'result_reply',id:'human',text:direction},later_context:[]}).authority).toBe(false);
});
it.each(['rows','bytes'])('fails closed for oversized complete context: %s',kind=>{
 if(kind==='rows')for(let n=0;n<500;n++)message('History '+n,1000+n);else message('x'.repeat(120001),1000);
 expect(()=>s.inspect(owner,input())).toThrow('Complete native context exceeds');
});
it('preserves every history and authority table after negative and positive assessments',()=>{
 const tables=['bot_decisions','bot_decision_events','bot_conversational_answers','bot_human_messages','bot_message_drafts','bot_composed_sms_authorities','bot_composed_sms_events','bot_composed_sms_associations'];const before=tables.map(t=>db.prepare('SELECT * FROM '+t).all());
 for(const interpretation of ['compose_and_send_direction','status_only','wording_edit_only','ambiguous'])s.review(owner,{...review(),interpretation});
 expect(tables.map(t=>db.prepare('SELECT * FROM '+t).all())).toEqual(before);
});
