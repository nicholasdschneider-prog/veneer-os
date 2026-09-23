import Database from 'better-sqlite3';
import {beforeEach,afterEach,it,expect} from 'vitest';
import {fileURLToPath} from 'node:url';
import {migrate} from '../src/db/migrate.js';
import {routinePolicyService} from '../src/bots/routinePolicies.js';
import {communicationService} from '../src/bots/communication.js';
import type {Actor} from '../src/bots/service.js';
import type {UserRow} from '../src/db/db.js';
let db:Database.Database,s:ReturnType<typeof routinePolicyService>,human:Actor,bot:Actor;
const input=()=>({business_id:'team',policy_key:'routine',expected_version:0,request_key:'once',source_reference:'Fixture owner-reviewed source',policy_text:'Fixture narrowly bounded routine policy. Only missing information without any remedy promise. Preserve every financial gate and human hold.',executor_ids:['tess'],categories:['missing_information']});
const scope=()=>({canonical_case:'case-uuid',executor_conversation_id:'tess',payload:{channel:'email',account:'fixture',recipients:['fixture@example.test'],subject:'Question',body:'Which model?',customer:'Fixture',ticket:'TICKET',attachments:[],context:''}});
beforeEach(()=>{
 db=new Database(':memory:');db.pragma('foreign_keys=ON');migrate(db,fileURLToPath(new URL('../src/db/migrations',import.meta.url)));
 db.prepare("INSERT INTO users(id,email,display_name,role) VALUES(1,'owner@example.test','Owner','owner'),(2,'other@example.test','Other','owner')").run();
 db.prepare("INSERT INTO business_teams(id,name,owner_id) VALUES('team','Fixture',1),('other','Other',2)").run();
 for(const [id,business,user] of [['tess','team',1],['foreign','other',2],['unnamed','team',1]] as const){db.prepare("INSERT INTO conversations(id,assistant_id,user_id,title,provider,native_session_id,visibility,business_team_id) VALUES(?,1,?,?,'claude',?,'team',?)").run(id,user,id,id,business);db.prepare('INSERT INTO bot_registrations(conversation_id,name,active,registered_by) VALUES(?,?,1,?)').run(id,id,user);}
 human={user:db.prepare('SELECT * FROM users WHERE id=1').get() as UserRow};bot={...human,conversationId:'tess'};s=routinePolicyService(db);
});
afterEach(()=>db.close());
it('records current owner immutably, replays enrollment once and rejects conflicts',()=>{
 const p=s.enroll(human,input());expect(p.issuer_id).toBe(1);expect(p.status).toBe('enrolled_setup_required');expect(p.enabled_categories).toEqual([]);expect(s.enroll(human,input()).id).toBe(p.id);
 expect(()=>s.enroll(human,{...input(),policy_text:input().policy_text+' changed'})).toThrow('conflict');
 expect(()=>s.enroll(human,{...input(),request_key:'other'})).toThrow('version changed');
 expect(()=>db.prepare('UPDATE bot_routine_policies SET issuer_id=2').run()).toThrow('immutable');expect(()=>db.prepare('DELETE FROM bot_routine_policies').run()).toThrow('immutable');
});
it('denies bot enrollment, foreign business and foreign executors',()=>{
 expect(()=>s.enroll(bot,input())).toThrow('human');expect(()=>s.enroll(human,{...input(),business_id:'other'})).toThrow('owner');expect(()=>s.enroll(human,{...input(),executor_ids:['foreign']})).toThrow();
 expect(()=>s.enroll(human,{...input(),categories:['refund']})).toThrow();expect(()=>s.enroll(human,{...input(),eligible:true})).toThrow();
});
it('supersedes and revokes without modifying enrollment or widening manager authority',()=>{
 const first=s.enroll(human,input());const second=s.enroll(human,{...input(),expected_version:1,request_key:'v2'});
 expect(s.list(bot,'team').find(p=>p.id===first.id)?.status).toBe('superseded');
 expect(()=>s.revoke(bot,second.id,'stop')).toThrow();expect(s.revoke(human,second.id,'stop').status).toBe('revoked');expect(s.revoke(human,second.id,'stop').status).toBe('revoked');
 expect(()=>s.revoke(human,second.id,'changed')).toThrow();expect(()=>db.prepare('DELETE FROM bot_routine_policy_revocations').run()).toThrow('immutable');
});
it('fails closed with exact fingerprint, no fabricated per-case approval or queued draft',()=>{
 const p=s.enroll(human,input());const inspect=(value=scope())=>s.inspect(bot,{policy_id:p.id,category:'missing_information',scope:value});
 const result=inspect();expect(result.ready).toBe(false);expect(result.execute).toBe(false);expect(result.missing_proof.join(' ')).toContain('eligibility verifier');
 for(const changed of [{...scope(),canonical_case:'other'},{...scope(),payload:{...scope().payload,body:'Refund $100'}},{...scope(),payload:{...scope().payload,recipients:['else@example.test']}}]){const r=inspect(changed);expect(r.ready).toBe(false);expect(r.scope_hash).not.toBe(result.scope_hash);}
 expect(()=>s.inspect(bot,{policy_id:p.id,category:'missing_information',scope:scope(),eligible:true})).toThrow();
 expect(db.prepare('SELECT count(*) n FROM bot_message_drafts').get()).toEqual({n:0});expect(db.prepare('SELECT count(*) n FROM bot_decision_events').get()).toEqual({n:0});
 const d=communicationService(db).saveDraft(bot,'tess','unapproved',scope().payload as never);
 expect(()=>communicationService(db).claim(bot,d.id,'no-authority')).toThrow();
});
it('denies foreign/unnamed identities and categories; inactive actors cannot reuse cached identity',()=>{
 const p=s.enroll(human,input());expect(s.list({...human,conversationId:'unnamed'},'team')).toEqual([]);
 expect(()=>s.inspect({...human,conversationId:'unnamed'},{policy_id:p.id,category:'missing_information',scope:scope()})).toThrow();
 expect(()=>s.inspect(bot,{policy_id:p.id,category:'factual_tracking',scope:scope()})).toThrow('outside');
 db.prepare("UPDATE users SET status='disabled' WHERE id=1").run();expect(()=>s.list(bot,'team')).toThrow();expect(()=>s.enroll(human,input())).toThrow();
});
it('revoked executor and issuer, missing source/lease or unknown effects can never enable execution',()=>{
 const p=s.enroll(human,input());const args={policy_id:p.id,category:'missing_information',scope:scope()};
 s.revoke(human,p.id,'source access removed');expect(s.inspect(bot,args).missing_proof).toContain('Policy is revoked');
 db.prepare("UPDATE bot_registrations SET active=0 WHERE conversation_id='tess'").run();expect(()=>s.inspect(bot,args)).toThrow();
});
