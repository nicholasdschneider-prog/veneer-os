import express from 'express';
import type { AddressInfo } from 'node:net';
import type { AppContext } from '../src/context.js';
import type { UserRow } from '../src/db/db.js';
import { createVeneerBrowserRouter } from '../src/routes/veneerBrowser.js';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { activeLoginGrants, authorizeLoginSecret, guardedLoginScript, LoginGrantSchema } from '../src/veneerBrowser/loginGrants.js';

let db: Database.Database;
beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys=ON');
  migrate(db,path.join(path.dirname(fileURLToPath(import.meta.url)),'../src/db/migrations'));
  db.exec(`INSERT INTO users(id,email,display_name,role) VALUES(1,'owner@test','Owner','owner'),(3,'member@test','Member','member');
    INSERT INTO projects(id,slug,name) VALUES('p','p','Project');
    INSERT INTO business_teams(id,name,owner_id) VALUES('t','Team',1);
    INSERT INTO business_team_members(team_id,user_id,role) VALUES('t',3,'member');
    INSERT INTO conversations(id,assistant_id,user_id,project_id,business_team_id,provider,native_session_id,visibility) VALUES('c',1,1,'p','t','codex','native','team');
    INSERT INTO bot_registrations(conversation_id,name,registered_by,active) VALUES('c','Bot',1,1);
    INSERT INTO business_bot_members(conversation_id,team_id,role) VALUES('c','t','bot');
    INSERT INTO veneer_browser_profiles(id,client_scope,project_id,name,created_by,owner_user_id) VALUES('profile','client','p','Accounting',1,1);
    INSERT INTO veneer_browser_conversation_profiles(conversation_id,client_scope,project_id,profile_id) VALUES('c','client','p','profile');
    INSERT INTO browser_login_grants(conversation_id,project_id,profile_id,granted_by,secret_project,secret_config,secret_name,kind,origins_json,allow_save)
      VALUES('c','p','profile',1,'ervp','prd','PASSWORD','password','["https://accounts.shopify.com"]',1);`);
});
afterEach(() => db.close());

describe('scoped browser login grants', () => {
  it('requires exact secret and current membership, bot, profile and grant owner', () => {
    expect(authorizeLoginSecret(db,3,'c',{project:'ervp',config:'prd',secret_name:'PASSWORD'},'password').profile_id).toBe('profile');
    expect(() => authorizeLoginSecret(db,3,'c',{project:'main',config:'prd',secret_name:'PASSWORD'},'password')).toThrow();
    expect(() => authorizeLoginSecret(db,3,'c',{project:'ervp',config:'prd',secret_name:'PASSWORD'},'totp')).toThrow();
    for (const [change,restore] of [
      ["UPDATE users SET status='disabled' WHERE id=3","UPDATE users SET status='active' WHERE id=3"],
      ["UPDATE business_team_members SET role='viewer'","UPDATE business_team_members SET role='member'"],
      ["UPDATE bot_registrations SET active=0","UPDATE bot_registrations SET active=1"],
      ["UPDATE conversations SET visibility='private'","UPDATE conversations SET visibility='team'"],
      ["UPDATE browser_login_grants SET project_id='other'","UPDATE browser_login_grants SET project_id='p'"],
      ["UPDATE users SET status='disabled' WHERE id=1","UPDATE users SET status='active' WHERE id=1"],
    ]) {
      if (change.includes("project_id='other'")) db.exec("INSERT INTO projects(id,slug,name) VALUES('other','other','Other')");
      db.exec(change); expect(activeLoginGrants(db,3,'c')).toEqual([]); db.exec(restore);
    }
    db.exec('DELETE FROM browser_login_grants');
    expect(activeLoginGrants(db,3,'c')).toEqual([]);
  });

  it('restricts grant creation and revocation to the profile/chat owner and records an audit', async () => {
    const app=express(); app.use(express.json());
    app.use((req,_res,next)=>{req.user=db.prepare('SELECT * FROM users WHERE id=?').get(Number(req.headers['x-user']??1)) as UserRow;next();});
    app.use(createVeneerBrowserRouter({db} as AppContext));
    const server=app.listen(0,'127.0.0.1');
    await new Promise<void>(resolve=>server.once('listening',resolve));
    const url=`http://127.0.0.1:${(server.address() as AddressInfo).port}/conversations/c/login-grants`;
    const body={profileId:'profile',secretProject:'ervp',secretConfig:'prd',secretName:'PASSWORD',kind:'password',origins:['https://accounts.shopify.com'],allowSave:true};
    try {
      const denied=await fetch(url,{method:'PUT',headers:{'Content-Type':'application/json','x-user':'3'},body:JSON.stringify(body)});
      expect(denied.status).toBe(403);
      const accepted=await fetch(url,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
      expect(accepted.status).toBe(200);
      const {grantId}=await accepted.json() as {grantId:number};
      expect((await fetch(`${url}/${grantId}`,{method:'DELETE',headers:{'x-user':'3'}})).status).toBe(403);
      expect((await fetch(`${url}/${grantId}`,{method:'DELETE'})).status).toBe(200);
      expect(activeLoginGrants(db,3,'c')).toEqual([]);
      expect(db.prepare('SELECT actor_id,action FROM business_audit').all()).toEqual([{actor_id:1,action:'browser.login_granted'},{actor_id:1,action:'browser.login_revoked'}]);
    } finally {server.close();}
  });

  it('accepts exact HTTPS origins only', () => {
    const grant = {profileId:'profile',secretProject:'ervp',secretConfig:'prd',secretName:'PASSWORD',kind:'password',origins:['https://accounts.shopify.com']};
    expect(LoginGrantSchema.safeParse(grant).success).toBe(true);
    for (const bad of ['http://accounts.shopify.com','https://accounts.shopify.com/login','https://localhost','https://user:pass@example.com','*.shopify.com']) expect(LoginGrantSchema.safeParse({...grant,origins:[bad]}).success).toBe(false);
  });

  it('checks live origin, frame, input and form destination atomically before secret entry', () => {
    class Input { type='password'; disabled=false; readOnly=false; ownerDocument:unknown; form={action:'https://accounts.shopify.com/login'}; stored=''; getClientRects(){return [1]} dispatchEvent(){} set value(v:string){this.stored=v} }
    const field = new Input();
    const document = {querySelectorAll:()=>[field]}; field.ownerDocument=document;
    const window: {top?:unknown} = {}; window.top=window;
    const context = {window,document,location:{origin:'https://accounts.shopify.com',href:'https://accounts.shopify.com/login'},HTMLInputElement:Input,Event:class {},URL};
    const script=guardedLoginScript('input[type=password]','test-secret',[context.location.origin],'password');
    expect(vm.runInNewContext(script,context)).toBe('Login field filled');
    expect(field.stored).toBe('test-secret');field.stored='';
    context.location.origin='https://evil.example';expect(()=>vm.runInNewContext(script,context)).toThrow('origin');
    context.location.origin='https://accounts.shopify.com';window.top={};expect(()=>vm.runInNewContext(script,context)).toThrow('origin');
    window.top=window;field.form.action='https://evil.example/collect';expect(()=>vm.runInNewContext(script,context)).toThrow('destination');
    field.form.action='https://accounts.shopify.com/login';field.type='text';expect(()=>vm.runInNewContext(script,context)).toThrow('field type');
    expect(field.stored).toBe('');
    expect(()=>guardedLoginScript('@e1','test-secret',[],'password')).toThrow('CSS');
  });
});
