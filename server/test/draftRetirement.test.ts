import express from 'express';
import {createCommunicationRouter} from '../src/bots/communicationRoutes.js';
import type {AppContext} from '../src/context.js';
import Database from 'better-sqlite3';
import {beforeEach,afterEach,it,expect} from 'vitest';
import {fileURLToPath} from 'node:url';
import {migrate} from '../src/db/migrate.js';
import {communicationService,communicationWakeAllowed,communicationWakeCancelled} from '../src/bots/communication.js';
import type {Actor} from '../src/bots/service.js';
import type {UserRow,ConversationWakeupRow} from '../src/db/db.js';
let db:Database.Database,s:ReturnType<typeof communicationService>,human:Actor,bot:Actor;
const payload={channel:'email' as const,account:'fixture',recipients:['fixture@example.test'],subject:'Fixture',body:'Which model?',customer:'Fixture',ticket:'FIXTURE',attachments:[],context:''};
const request=(v:number)=>({expected_version:v,request_key:'retire-once',reason:'Answered independently',evidence:'Independent fixture receipt, not delivery of this draft'});
function draft(queued=true){const d=s.saveDraft(bot,'tess','fixture',payload);return queued?s.mutateDraft(human,d.id,d.version,'send'):d;}
beforeEach(()=>{
 db=new Database(':memory:');db.pragma('foreign_keys=ON');migrate(db,fileURLToPath(new URL('../src/db/migrations',import.meta.url)));
 db.prepare("INSERT INTO users(id,email,display_name,role) VALUES(1,'owner@example.test','Owner','owner'),(2,'other@example.test','Other','owner')").run();
 db.prepare("INSERT INTO business_teams(id,name,owner_id) VALUES('team','Fixture',1),('other','Other',2)").run();
 for(const [id,business,user] of [['tess','team',1],['foreign','other',2],['unnamed','team',1]] as const){db.prepare("INSERT INTO conversations(id,assistant_id,user_id,title,provider,native_session_id,visibility,business_team_id) VALUES(?,1,?,?,'claude',?,'team',?)").run(id,user,id,id,business);db.prepare('INSERT INTO bot_registrations(conversation_id,name,active,registered_by) VALUES(?,?,1,?)').run(id,id,user);}
 human={user:db.prepare('SELECT * FROM users WHERE id=1').get() as UserRow};bot={...human,conversationId:'tess'};s=communicationService(db);
});
afterEach(()=>db.close());

it('retires queued work preserving original authority/payload and separate immutable audit',()=>{
 const d=draft();const r=s.retire(bot,d.id,request(d.version));expect(r.state).toBe('discarded');expect(r.authorized_by).toBe(d.authorized_by);expect(r.payload).toEqual(d.payload);expect(r.receipt).toBe(null);expect(r.claim_key).toBe(null);expect(r.retirement).toBeTruthy();expect(r.version).toBe(d.version+1);
 expect(s.retire(bot,d.id,request(d.version)).version).toBe(r.version);
 expect(()=>s.retire(bot,d.id,{...request(d.version),evidence:'changed'})).toThrow('conflicts');
 expect(()=>s.retire(bot,d.id,{...request(d.version),request_key:'other'})).toThrow('already retired');
 expect(()=>db.prepare('DELETE FROM bot_message_retirements').run()).toThrow('immutable');expect(()=>db.prepare("UPDATE bot_message_retirements SET reason='changed'").run()).toThrow('immutable');
 expect(db.prepare('SELECT count(*) n FROM bot_message_delivery_proofs').get()).toEqual({n:0});
});
it('retires unapproved drafts without adding send authority',()=>{
 const d=draft(false);expect(s.retire(bot,d.id,request(d.version)).authorized_by).toBe(null);expect(()=>s.claim(bot,d.id,'no-send')).toThrow();
});
it.each(['human','foreign','unnamed','inactive','archived','disabled'] as const)('denies %s retirement',kind=>{
 const d=draft();let a=bot;
 if(kind==='human')a=human;if(kind==='foreign')a={user:db.prepare('SELECT * FROM users WHERE id=2').get() as UserRow,conversationId:'foreign'};
 if(kind==='unnamed')a={...bot,conversationId:'unnamed'};
 if(kind==='inactive')db.prepare("UPDATE bot_registrations SET active=0 WHERE conversation_id='tess'").run();
 if(kind==='archived')db.prepare("UPDATE conversations SET archived=1 WHERE id='tess'").run();
 if(kind==='disabled')db.prepare("UPDATE users SET status='disabled' WHERE id=1").run();
 expect(()=>s.retire(a,d.id,request(d.version))).toThrow();expect(db.prepare('SELECT state FROM bot_message_drafts WHERE id=?').get(d.id)).toEqual({state:'queued'});
});
it.each(['sending','sent','uncertain','failed','discarded'])('rejects %s and preserves receipt',state=>{
 const d=draft();db.prepare('UPDATE bot_message_drafts SET state=?,receipt=? WHERE id=?').run(state,'existing evidence',d.id);expect(()=>s.retire(bot,d.id,request(d.version))).toThrow();expect(s.readDraft(human,d.id).receipt).toBe('existing evidence');
});
it('rejects stale versions and inconsistent preexisting claim keys',()=>{
 const d=draft();expect(()=>s.retire(bot,d.id,request(d.version-1))).toThrow('version');db.prepare("UPDATE bot_message_drafts SET claim_key='old' WHERE id=?").run(d.id);expect(()=>s.retire(bot,d.id,request(d.version))).toThrow('unclaimed');
});
it('retirement wins: later claim and stale wake cannot execute or falsify failure',()=>{
 const d=draft();const w=db.prepare('SELECT * FROM conversation_wakeups WHERE wake_key=?').get('message-draft:'+d.id) as ConversationWakeupRow;
 expect(communicationWakeAllowed(db,w)).toBe(true);s.retire(bot,d.id,request(d.version));expect(()=>s.claim(bot,d.id,'late')).toThrow();expect(communicationWakeAllowed(db,w)).toBe(false);communicationWakeCancelled(db,w);expect(s.readDraft(human,d.id).state).toBe('discarded');expect(s.readDraft(human,d.id).receipt).toBe(null);
});
it('claim wins: retirement cannot retract a claimed or uncertain send',()=>{
 const d=draft();expect(s.claim(bot,d.id,'claim').execute).toBe(true);expect(()=>s.retire(bot,d.id,request(d.version))).toThrow('unclaimed');s.receipt(bot,d.id,'claim','uncertain','Fixture timeout');expect(()=>s.retire(bot,d.id,request(d.version))).toThrow();expect(db.prepare('SELECT count(*) n FROM bot_message_retirements').get()).toEqual({n:0});
});

it('serializes simultaneous HTTP claim and retirement without double transition',async()=>{
 const d=draft(),app=express();app.use(express.json());app.use((req,_res,next)=>{req.user=bot.user;req.agentConversationId='tess';next();});app.use(createCommunicationRouter({db} as AppContext));
 const server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));
 const address=server.address() as {port:number};const base=`http://127.0.0.1:${address.port}/drafts/${d.id}`;
 try{const responses=await Promise.all([fetch(base+'/retire',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(request(d.version))}),fetch(base+'/claim',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({claim_key:'race'})})]);
 expect(responses.filter(r=>r.status===200)).toHaveLength(1);expect(responses.filter(r=>r.status===409)).toHaveLength(1);
 const row=s.readDraft(human,d.id);expect(['discarded','sending']).toContain(row.state);expect(row.state==='discarded'?row.claim_key===null:row.claim_key==='race').toBe(true);
 }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
