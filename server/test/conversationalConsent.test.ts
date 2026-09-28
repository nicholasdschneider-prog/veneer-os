import Database from 'better-sqlite3';
import {beforeEach,afterEach,it,expect} from 'vitest';
import {fileURLToPath} from 'node:url';
import {migrate} from '../src/db/migrate.js';
import {createBotService,type Actor} from '../src/bots/service.js';
import {captureHumanMessage} from '../src/bots/humanMessages.js';
import type {UserRow} from '../src/db/db.js';
let db:Database.Database,s:ReturnType<typeof createBotService>,bot:Actor,human:Actor,id:string;
beforeEach(()=>{
 db=new Database(':memory:');migrate(db,fileURLToPath(new URL('../src/db/migrations',import.meta.url)));
 db.prepare("INSERT INTO users(id,email,display_name,role) VALUES(1,'one@test','Human','owner'),(2,'two@test','Other','member')").run();
 for(const c of ['sage','other'])db.prepare("INSERT INTO conversations(id,assistant_id,user_id,title,provider,native_session_id,visibility) VALUES(?,1,1,?,'codex',?,'team')").run(c,c,c);
 human={user:db.prepare('SELECT * FROM users WHERE id=1').get() as UserRow};bot={...human,conversationId:'sage'};
 s=createBotService(db);s.register(human,'sage','Sage',true);s.register(human,'other','Other',true);
 id=s.raise(bot,{source_key:'order',proposal_key:'timing',proposal:{question:'Place order 100121932?',recommendation:'SKU643922 x1, $30.90, October 5',consequence:'Ten days late',blocked_action:'Only Sage places this exact order after fresh checks',assignee_id:1,evidence:[]}}).id;
 db.prepare("INSERT INTO bot_message_threads(id,conversation_id,anchor,source_text) VALUES('thread','sage','result','Order 100121932 unplaced $30.90 October 5. Unrelated Piper SKU2021124075 is $6.80.')").run();
});
afterEach(()=>db.close());
function reply(text='Place. I authorize you too. We’re in catchup mode.',actor=1,botId:string|null=null,key='reply'){
 db.prepare("INSERT INTO bot_message_replies(id,thread_id,actor_id,actor_conversation_id,text,request_key,created_at) VALUES(?,'thread',?,?,?,?,?)").run(key,actor,botId,text,key,'2099-01-01T00:00:00Z');return key;
}
function inspect(source=reply()){return s.inspectConversationalDecision(bot,id,1,'result_reply',source);}
function record(source:string,hash:string,action:'approve'|'defer'='approve'){return s.recordConversationalDecision(bot,id,1,'result_reply',source,hash,action,true);}
it('inspects full human and mixed-result context without answering, then records exactly once and reconciles read-only',()=>{
 const source=reply(),a=inspect(source);expect(a.source?.text).toContain('catchup');expect(JSON.stringify(a.context)).toContain('Piper');
 expect(db.prepare('SELECT count(*) n FROM bot_conversational_answers').get()).toEqual({n:0});
 expect(record(source,a.inspection_hash!)).toMatchObject({state:'decided',version:1,answer:{action:'approve',actor_id:1}});
 expect(record(source,a.inspection_hash!)).toMatchObject({state:'decided'});
 expect(inspect(source).recorded).toMatchObject({decision_id:id,version:1,action:'approve'});
 expect(db.prepare('SELECT count(*) n FROM conversation_wakeups').get()).toEqual({n:1});
 expect(()=>record(source,a.inspection_hash!,'defer')).toThrow('Conflicting');
});
it('refuses human callers, other bots, nonhuman sources and unauthorized humans',()=>{
 const source=reply();expect(()=>s.inspectConversationalDecision(human,id,1,'result_reply',source)).toThrow('owning bot');
 expect(()=>s.inspectConversationalDecision({...human,conversationId:'other'},id,1,'result_reply',source)).toThrow('owning bot');
 expect(()=>inspect(reply('yes',1,'sage','bot'))).toThrow('Authenticated');
 expect(()=>inspect(reply('yes',2,null,'other-human'))).toThrow('approver');
});
it('rejects stale/superseded context and changes to order/executor or human access',()=>{
 const source=reply(),a=inspect(source);
 s.reply(human,id,'correction','Do not place it');
 expect(()=>record(source,a.inspection_hash!)).toThrow();
 db.prepare("UPDATE users SET status='disabled' WHERE id=1").run();
 expect(()=>record(source,a.inspection_hash!)).toThrow();
});
it('rejects newer same-thread human messages even if their words say approve',()=>{
 const source=reply(),a=inspect(source);reply('Approve unrelated Piper price',1,null,'new');
 expect(()=>record(source,a.inspection_hash!)).toThrow('newer human');
});
it('cannot apply an instruction to a proposal that did not exist when it was written',()=>{
 db.prepare("INSERT INTO bot_message_replies(id,thread_id,actor_id,text,request_key,created_at) VALUES('old','thread',1,'yes','old','2000-01-01')").run();
 expect(()=>inspect('old')).toThrow('No unchanged proposal');
});
it('binds direct submissions to a server-captured proposal and refuses legacy text IDs',()=>{
 const source=captureHumanMessage(db,'sage',1,'Place the exact October 5 order.');
 const a=s.inspectConversationalDecision(bot,id,1,'direct_message',source);
 expect(a.proposal.blocked_action).toContain('Sage');
 expect(()=>s.inspectConversationalDecision(bot,id,1,'direct_message','transcript-id')).toThrow('legacy');
 expect(s.recordConversationalDecision(bot,id,1,'direct_message',source,a.inspection_hash!,'approve',true)).toMatchObject({state:'decided'});
 expect(()=>db.prepare("UPDATE bot_human_messages SET text='different'").run()).toThrow('immutable');
});
it('invalidates inspection on a new direct correction and on a revised proposal',()=>{
 const source=captureHumanMessage(db,'sage',1,'Approve exact order');
 const a=s.inspectConversationalDecision(bot,id,1,'direct_message',source);
 captureHumanMessage(db,'sage',1,'Wait. Change quantity to two.');
 expect(()=>s.recordConversationalDecision(bot,id,1,'direct_message',source,a.inspection_hash!,'approve',true)).toThrow('newer direct');
 const current=s.view(bot,s.read(bot,id));s.revise(bot,id,1,'revise',{...current.proposal,blocked_action:'Other executor places two units'});
 expect(()=>s.inspectConversationalDecision(bot,id,1,'direct_message',source)).toThrow('Proposal changed');
 expect(()=>s.inspectConversationalDecision(bot,id,2,'direct_message',source)).toThrow('not unchanged');
});
it('does not classify quotations, questions or conditional text automatically',()=>{
 const source=reply('The customer said “approve.” Could we place it if the price changes?');
 const a=inspect(source);expect(a.instructions).toContain('semantic intent');
 expect(s.view(bot,s.read(bot,id))).toMatchObject({state:'needs_input',answer:null});
 expect(()=>s.recordConversationalDecision(bot,id,1,'result_reply',source,a.inspection_hash!,'approve',false)).toThrow('Full source');
});
it('refuses hash tampering, reuse for another decision and revoked replay',()=>{
 const source=reply(),a=inspect(source);
 expect(()=>record(source,'0'.repeat(64))).toThrow('changed');record(source,a.inspection_hash!);
 const p=s.view(bot,s.read(bot,id)).proposal;
 const second=s.raise(bot,{source_key:'second',proposal_key:'second',proposal:p});
 expect(()=>s.inspectConversationalDecision(bot,second.id,1,'result_reply',source)).toThrow('already used');
 db.prepare("UPDATE bot_registrations SET active=0 WHERE conversation_id='sage'").run();
 expect(()=>record(source,a.inspection_hash!)).toThrow('inactive');
});
it('rejects a same-second correction in another result thread',()=>{
 const source=reply(),a=inspect(source);
 db.prepare("INSERT INTO bot_message_threads(id,conversation_id,anchor,source_text) VALUES('second','sage','other','Other result')").run();
 db.prepare("INSERT INTO bot_message_replies(id,thread_id,actor_id,text,request_key,created_at) VALUES('correction','second',1,'Wait','correction','2099-01-01T00:00:00Z')").run();
 expect(()=>record(source,a.inspection_hash!)).toThrow('Newer human context');
});
it('rejects executor changes after inspection without recording an answer',()=>{
 const source=reply(),a=inspect(source),p=s.view(bot,s.read(bot,id)).proposal;
 s.revise(bot,id,1,'executor-change',{...p,blocked_action:'Other bot places the order'});
 expect(()=>record(source,a.inspection_hash!)).toThrow('Proposal changed');
 expect(db.prepare('SELECT count(*) n FROM bot_conversational_answers').get()).toEqual({n:0});
});
it('reconciles direct consent after its own shared-queue claim and rejects earlier handling changes',()=>{
 db.prepare("INSERT INTO shared_bot_queues VALUES('sage')").run();
 const source=captureHumanMessage(db,'sage',1,'Approve the exact order');
 const a=s.inspectConversationalDecision(bot,id,1,'direct_message',source);
 const apply=()=>s.recordConversationalDecision(bot,id,1,'direct_message',source,a.inspection_hash!,'approve',true);
 expect(apply()).toMatchObject({state:'decided'});
 expect(apply()).toMatchObject({state:'decided'});
 expect(s.inspectConversationalDecision(bot,id,1,'direct_message',source).recorded).toMatchObject({action:'approve'});
 expect(db.prepare('SELECT count(*) n FROM conversation_wakeups').get()).toEqual({n:1});
});
it('rejects a changed handling revision before recording direct consent',()=>{
 db.prepare("INSERT INTO shared_bot_queues VALUES('sage')").run();
 const source=captureHumanMessage(db,'sage',1,'Approve exact order');
 s.handle(human,id,1,'claim','claim',0);
 expect(()=>s.inspectConversationalDecision(bot,id,1,'direct_message',source)).toThrow('Handling changed');
});
it('refuses same-second historical proposal timing when event precision cannot establish order',()=>{
 const created=(db.prepare("SELECT created_at FROM bot_decision_events WHERE decision_id=? AND kind='raised'").get(id) as {created_at:string}).created_at;
 db.prepare("INSERT INTO bot_message_replies(id,thread_id,actor_id,text,request_key,created_at) VALUES('same-second','thread',1,'Approve','same-second',?)").run(created.replace(' ','T')+'.900Z');
 expect(()=>inspect('same-second')).toThrow('No unchanged proposal');
});
