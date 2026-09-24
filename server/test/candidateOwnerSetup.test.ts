import Database from 'better-sqlite3';
import {beforeEach,afterEach,it,expect} from 'vitest';
import {fileURLToPath} from 'node:url';
import {migrate} from '../src/db/migrate.js';
import {candidateOwnerSetup} from '../src/bots/candidateOwnerSetup.js';
import {preparedCandidatePayload as p,preparedCandidateManifest as manifest} from '../src/bots/preparedCandidateRegistration.js';
import {canonicalSha256} from '../src/bots/canonical.js';
import type {Actor} from '../src/bots/service.js';
import type {UserRow} from '../src/db/db.js';
let db:Database.Database,owner:Actor,s:ReturnType<typeof candidateOwnerSetup>;
const config={autoshipCandidateCfAud:p.audience,autoshipCandidateClientId:p.client_id};
beforeEach(()=>{
 db=new Database(':memory:');db.pragma('foreign_keys=ON');migrate(db,fileURLToPath(new URL('../src/db/migrations',import.meta.url)));
 db.prepare("INSERT INTO users(id,email,display_name,role) VALUES(1,'owner@fixture.test','Owner','owner'),(2,'member@fixture.test','Member','member')").run();
 db.prepare("INSERT INTO business_teams(id,name,owner_id) VALUES(?,'Fixture',1)").run(p.business_id);
 db.prepare("INSERT INTO conversations(id,assistant_id,user_id,title,provider,native_session_id,visibility,business_team_id) VALUES(?,1,1,'Fixture','claude','fixture','team',?)").run(p.recipient_id,p.business_id);
 db.prepare("INSERT INTO bot_registrations(conversation_id,name,registered_by) VALUES(?,'Fixture',1)").run(p.recipient_id);
 owner={user:db.prepare('SELECT * FROM users WHERE id=1').get() as UserRow};s=candidateOwnerSetup(db,config);
});
afterEach(()=>db.close());
it('pins original package and reconciles lost response without another registration or effect',()=>{
 expect(p.request_key).toBe('orderops-candidate-registration-v1:b87535be8b1b666100ca0c06cf51a8e48411ffff5e2541e03f33f14c87adface');
 const review=s.status(owner);expect(review.status).toBe('ready');
 expect(db.prepare('SELECT count(*) n FROM autoship_candidate_sources').get()).toEqual({n:0});
 s.confirm(owner,{review_hash:review.review_hash,confirm:true}); // lost first response
 const result=s.status(owner);expect(result.status).toBe('registered');expect(result.receipt?.owner_id).toBe(1);
 expect(s.confirm(owner,{review_hash:review.review_hash,confirm:true})).toEqual(result);
 expect(db.prepare('SELECT count(*) n FROM autoship_candidate_sources').get()).toEqual({n:1});
 for(const table of ['autoship_candidate_events','autoship_candidate_starts','conversation_wakeups']) expect(db.prepare(`SELECT count(*) n FROM ${table}`).get()).toEqual({n:0});
 expect(()=>db.prepare("UPDATE autoship_candidate_sources SET account_id='other'").run()).toThrow('Immutable');
});
it('rejects bots, nonowners, revoked identity/executor and configuration drift',()=>{
 expect(()=>s.status({...owner,conversationId:p.recipient_id})).toThrow('business owner');
 expect(()=>s.status({user:db.prepare('SELECT * FROM users WHERE id=2').get() as UserRow})).toThrow('business owner');
 expect(()=>candidateOwnerSetup(db,{}).status(owner)).toThrow('configuration changed');
 db.prepare('UPDATE bot_registrations SET active=0').run();expect(()=>s.status(owner)).toThrow('registration');
 db.prepare('UPDATE bot_registrations SET active=1').run();
 db.prepare("UPDATE users SET status='disabled' WHERE id=1").run();expect(()=>s.status(owner)).toThrow('business owner');
});
it('rejects stale reviews, injected scope, revoked registration and changed ownership',()=>{
 const review=s.status(owner);
 expect(()=>s.confirm(owner,{review_hash:'stale',confirm:true})).toThrow('changed');
 expect(()=>s.confirm(owner,{review_hash:review.review_hash,confirm:true,account_id:'other'})).toThrow();
 const registered=s.confirm(owner,{review_hash:review.review_hash,confirm:true});
 db.prepare("INSERT INTO autoship_candidate_revocations(source_id,actor_id,reason) VALUES(?,1,'fixture')").run(registered.receipt!.source_id);
 expect(s.status(owner).status).toBe('revoked');expect(()=>s.confirm(owner,{review_hash:review.review_hash,confirm:true})).toThrow('revoked');
 db.prepare('UPDATE business_teams SET owner_id=2').run();expect(()=>s.status(owner)).toThrow('business owner');
});
it('fails closed for alternate-key or conflicting payload registration',()=>{
 db.prepare('INSERT INTO autoship_candidate_sources(id,business_id,owner_id,recipient_id,client_id,audience,account_id,source_origin,request_key) VALUES(?,?,1,?,?,?,?,?,?)').run('other',p.business_id,p.recipient_id,p.client_id,p.audience,p.account_id,p.source_origin,'different-key');
 expect(()=>s.status(owner)).toThrow('conflicting');expect(()=>s.confirm(owner,{review_hash:'x',confirm:true})).toThrow('conflicting');
});
