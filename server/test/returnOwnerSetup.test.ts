import Database from 'better-sqlite3';
import {beforeEach,afterEach,it,expect} from 'vitest';
import {fileURLToPath} from 'node:url';
import {migrate} from '../src/db/migrate.js';
import {returnOwnerSetup} from '../src/bots/returnOwnerSetup.js';
import {preparedReturnPayload as p,preparedReturnManifest as manifest} from '../src/bots/preparedReturnRegistration.js';
import {canonicalSha256} from '../src/bots/canonical.js';
import type {Actor} from '../src/bots/service.js';
import type {UserRow} from '../src/db/db.js';
let db:Database.Database,owner:Actor,s:ReturnType<typeof returnOwnerSetup>;
const config={returnVerifierCfAud:p.audience,returnVerifierClientId:p.client_id};
beforeEach(()=>{
 db=new Database(':memory:');db.pragma('foreign_keys=ON');migrate(db,fileURLToPath(new URL('../src/db/migrations',import.meta.url)));
 db.prepare("INSERT INTO users(id,email,display_name,role) VALUES(1,'owner@fixture.test','Owner','owner'),(2,'member@fixture.test','Member','member')").run();
 db.prepare("INSERT INTO business_teams(id,name,owner_id) VALUES(?,'Fixture',1)").run(p.business_id);
 db.prepare("INSERT INTO conversations(id,assistant_id,user_id,title,provider,native_session_id,visibility,business_team_id) VALUES(?,1,1,'Fixture','claude','fixture','team',?)").run(p.executor_id,p.business_id);
 db.prepare("INSERT INTO bot_registrations(conversation_id,name,registered_by) VALUES(?,'Fixture',1)").run(p.executor_id);
 owner={user:db.prepare('SELECT * FROM users WHERE id=1').get() as UserRow};s=returnOwnerSetup(db,config);
});
afterEach(()=>db.close());
it('pins original package and reconciles lost response without another registration or effect',()=>{
 expect(p.request_key).toBe('source-registration-v1:'+canonicalSha256(manifest));
 const review=s.status(owner);expect(review.status).toBe('ready');
 expect(db.prepare('SELECT count(*) n FROM return_bridge_trust').get()).toEqual({n:0});
 s.confirm(owner,{review_hash:review.review_hash,confirm:true}); // lost first response
 const result=s.status(owner);expect(result.status).toBe('registered');expect(result.receipt?.owner_id).toBe(1);
 expect(s.confirm(owner,{review_hash:review.review_hash,confirm:true})).toEqual(result);
 expect(db.prepare('SELECT count(*) n FROM return_bridge_trust').get()).toEqual({n:1});
 for(const table of ['return_bridge_mappings','return_bridge_claims','return_bridge_acknowledgments']) expect(db.prepare(`SELECT count(*) n FROM ${table}`).get()).toEqual({n:0});
 expect(()=>db.prepare("UPDATE return_bridge_trust SET account_id='other'").run()).toThrow('Immutable');
});
it('rejects bots, nonowners, revoked identity/executor and configuration drift',()=>{
 expect(()=>s.status({...owner,conversationId:p.executor_id})).toThrow('business owner');
 expect(()=>s.status({user:db.prepare('SELECT * FROM users WHERE id=2').get() as UserRow})).toThrow('business owner');
 expect(()=>returnOwnerSetup(db,{}).status(owner)).toThrow('configuration changed');
 db.prepare('UPDATE bot_registrations SET active=0').run();expect(()=>s.status(owner)).toThrow('registration');
 db.prepare('UPDATE bot_registrations SET active=1').run();
 db.prepare("UPDATE users SET status='disabled' WHERE id=1").run();expect(()=>s.status(owner)).toThrow('business owner');
});
it('rejects stale reviews, injected scope, revoked registration and changed ownership',()=>{
 const review=s.status(owner);
 expect(()=>s.confirm(owner,{review_hash:'stale',confirm:true})).toThrow('changed');
 expect(()=>s.confirm(owner,{review_hash:review.review_hash,confirm:true,account_id:'other'})).toThrow();
 const registered=s.confirm(owner,{review_hash:review.review_hash,confirm:true});
 db.prepare("INSERT INTO return_bridge_revocations(trust_id,actor_id,reason) VALUES(?,1,'fixture')").run(registered.receipt!.trust_id);
 expect(s.status(owner).status).toBe('revoked');expect(()=>s.confirm(owner,{review_hash:review.review_hash,confirm:true})).toThrow('revoked');
 db.prepare('UPDATE business_teams SET owner_id=2').run();expect(()=>s.status(owner)).toThrow('business owner');
});
it('fails closed for alternate-key or conflicting payload registration',()=>{
 db.prepare('INSERT INTO return_bridge_trust(id,business_id,owner_id,executor_id,client_id,audience,account_id,principal_id,source_origin,request_key) VALUES(?,?,1,?,?,?,?,?,?,?)').run('other',p.business_id,p.executor_id,p.client_id,p.audience,p.account_id,p.principal_id,p.source_origin,'different-key');
 expect(()=>s.status(owner)).toThrow('conflicting');expect(()=>s.confirm(owner,{review_hash:'x',confirm:true})).toThrow('conflicting');
});
