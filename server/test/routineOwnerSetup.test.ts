import Database from 'better-sqlite3';
import {beforeEach,afterEach,it,expect} from 'vitest';
import {fileURLToPath} from 'node:url';
import {migrate} from '../src/db/migrate.js';
import {routineOwnerSetup, type RoutineSetupPacket} from '../src/bots/routineOwnerSetup.js';
import {preparedRoutineRegistration} from '../src/bots/preparedRoutineRegistration.js';
import {routinePolicyService} from '../src/bots/routinePolicies.js';
import type {Actor} from '../src/bots/service.js';
import type {UserRow} from '../src/db/db.js';
let db:Database.Database,owner:Actor,s:ReturnType<typeof routineOwnerSetup>,packet:RoutineSetupPacket;
const identity={clientId:'fixture-client',audience:'fixture-audience'};
beforeEach(()=>{
 db=new Database(':memory:');db.pragma('foreign_keys=ON');migrate(db,fileURLToPath(new URL('../src/db/migrations',import.meta.url)));
 db.prepare("INSERT INTO users(id,email,display_name,role) VALUES(1,'owner@fixture.test','Owner','owner'),(2,'member@fixture.test','Member','member')").run();
 db.prepare("INSERT INTO business_teams(id,name,owner_id) VALUES('team','Fixture',1)").run();
 db.prepare("INSERT INTO conversations(id,assistant_id,user_id,title,provider,native_session_id,visibility,business_team_id) VALUES('bot',1,1,'Fixture','claude','fixture','team','team')").run();
 db.prepare("INSERT INTO bot_registrations(conversation_id,name,registered_by) VALUES('bot','Fixture',1)").run();
 owner={user:db.prepare('SELECT * FROM users WHERE id=1').get() as UserRow};
 packet={...preparedRoutineRegistration,business_id:'team',client_id:identity.clientId,audience:identity.audience,source:{executor_id:'bot',principal_id:'own-principal',adapter_digest:'a'.repeat(64),registration_reference:'Fixture reviewed source registration',deployment_receipt:'Fixture deployment',principal_receipt:'Fixture own current principal',runtime_receipt:'Fixture runtime connection'}};
 s=routineOwnerSetup(db,identity,packet);
});
afterEach(()=>db.close());
it('enrolls exact photo-only policy and trust atomically and reconciles a lost response read-only',()=>{
 const review=s.status(owner);expect(review.status).toBe('ready');
 expect(db.prepare('SELECT count(*) n FROM bot_routine_policies').get()).toEqual({n:0});
 s.confirm(owner,{review_hash:review.review_hash,confirm:true});
 const current=s.status(owner);expect(current.status).toBe('registered');expect(current.receipt?.owner_id).toBe(1);
 expect(s.confirm(owner,{review_hash:review.review_hash,confirm:true})).toEqual(current);
 const policies=routinePolicyService(db).list(owner,'team');expect(policies).toHaveLength(1);
 expect(policies[0]!.snapshot.missing_information_fields).toEqual(['product_label_photo']);
 expect(db.prepare('SELECT count(*) n FROM routine_source_trust').get()).toEqual({n:1});
 for(const table of ['routine_source_proofs','routine_draft_authorizations','bot_message_drafts','routine_delivery_readbacks'])expect(db.prepare(`SELECT count(*) n FROM ${table}`).get()).toEqual({n:0});
});
it('rejects bot, nonowner, changed owner and inactive human',()=>{
 expect(()=>s.status({...owner,conversationId:'bot'})).toThrow('business owner');
 expect(()=>s.status({user:db.prepare('SELECT * FROM users WHERE id=2').get() as UserRow})).toThrow('business owner');
 db.prepare("UPDATE users SET status='disabled' WHERE id=1").run();expect(()=>s.status(owner)).toThrow('business owner');
 db.prepare("UPDATE users SET status='active' WHERE id=1").run();db.prepare('UPDATE business_teams SET owner_id=2').run();expect(()=>s.status(owner)).toThrow('business owner');
});
it('keeps incomplete source and changed connection/executor blocked without partial enrollment',()=>{
 for(const service of [routineOwnerSetup(db,null,packet),routineOwnerSetup(db,{...identity,clientId:'other'},packet),routineOwnerSetup(db,identity,{...packet,source:null})]){
  const review=service.status(owner);expect(review.status).toBe('blocked');expect(()=>service.confirm(owner,{review_hash:review.review_hash,confirm:true})).toThrow('blocked');
 }
 db.prepare('UPDATE bot_registrations SET active=0').run();expect(s.status(owner).status).toBe('blocked');
 expect(db.prepare('SELECT count(*) n FROM bot_routine_policies').get()).toEqual({n:0});
});
it('rejects stale review, injected payload and revoked trust',()=>{
 const review=s.status(owner);expect(()=>s.confirm(owner,{review_hash:'old',confirm:true})).toThrow('changed');
 expect(()=>s.confirm(owner,{review_hash:review.review_hash,confirm:true,executor_id:'other'})).toThrow();
 const registered=s.confirm(owner,{review_hash:review.review_hash,confirm:true});
 db.prepare("INSERT INTO routine_source_revocations(trust_id,actor_id,reason) VALUES(?,1,'stop')").run(registered.receipt!.trust_id);
 expect(s.status(owner).status).toBe('revoked');expect(()=>s.confirm(owner,{review_hash:review.review_hash,confirm:true})).toThrow('revoked');
});
it('rolls back policy creation if trust persistence fails',()=>{
 db.exec("CREATE TRIGGER fixture_trust_failure BEFORE INSERT ON routine_source_trust BEGIN SELECT RAISE(ABORT,'fixture failure'); END;");
 expect(()=>s.confirm(owner,{review_hash:s.status(owner).review_hash,confirm:true})).toThrow('fixture failure');
 expect(db.prepare('SELECT count(*) n FROM bot_routine_policies').get()).toEqual({n:0});
});
it('does not create overlapping policies or reuse changed prepared registration',()=>{
 const review=s.status(owner);s.confirm(owner,{review_hash:review.review_hash,confirm:true});
 expect(()=>routineOwnerSetup(db,identity,{...packet,policy_text:packet.policy_text+' Changed.'}).status(owner)).toThrow('conflicting');
 routinePolicyService(db).enroll(owner,{business_id:'team',policy_key:'other',expected_version:0,request_key:'other',source_reference:'fixture',policy_text:packet.policy_text,executor_ids:['bot'],categories:['missing_information']});
 expect(()=>s.status(owner)).toThrow('reconciliation');
});
it('does not reactivate superseded or revoked policy',()=>{
 const review=s.status(owner);const registered=s.confirm(owner,{review_hash:review.review_hash,confirm:true});
 routinePolicyService(db).revoke(owner,registered.receipt!.policy_id,'stop');
 expect(s.status(owner).status).toBe('revoked');expect(()=>s.confirm(owner,{review_hash:review.review_hash,confirm:true})).toThrow('revoked');
});

it('rejects an existing broader policy under the prepared key without narrowing it silently',()=>{
 routinePolicyService(db).enroll(owner,{business_id:'team',policy_key:packet.policy_key,expected_version:0,request_key:packet.policy_request_key,source_reference:packet.source_reference,policy_text:packet.policy_text,executor_ids:['bot'],categories:['missing_information']});
 expect(()=>s.status(owner)).toThrow('conflicting');
 expect(db.prepare('SELECT count(*) n FROM routine_source_trust').get()).toEqual({n:0});
});
