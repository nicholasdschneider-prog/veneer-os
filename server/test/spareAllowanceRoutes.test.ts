import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import Database from 'better-sqlite3';
import { afterAll,beforeAll,expect,it } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { createSpareAllowanceRouter } from '../src/spareAllowance/routes.js';
import type { AppContext } from '../src/context.js';
import type { UserRow } from '../src/db/db.js';
let db:Database.Database,server:Server,base:string;
const input={request_key:'gallery-v1',conversation_id:'piper',title:'Gallery',prompt:'Prepare accurate local drafts from verified dimensions',output:'Six gallery images',account_ids:['spare'],max_batches:2};
beforeAll(async()=>{
  db=new Database(':memory:');db.pragma('foreign_keys=ON');migrate(db,path.join(path.dirname(fileURLToPath(import.meta.url)),'../src/db/migrations'));
  db.prepare("INSERT INTO users(id,email,display_name,role) VALUES(1,'owner@example.com','Owner','owner'),(2,'member@example.com','Member','member')").run();
  db.prepare("INSERT INTO conversations(id,assistant_id,user_id,title,provider,model,native_session_id,channel) VALUES('piper',1,1,'Piper','codex','gpt-test','piper-native','web'),('other',1,1,'Other','codex','gpt-test','other-native','web')").run();
  const app=express();app.use(express.json());app.use((req,_res,next)=>{req.user=db.prepare('SELECT * FROM users WHERE id=?').get(Number(req.headers['x-user']??1)) as UserRow;req.agentConversationId=req.headers['x-chat'] as string|undefined;next();});
  app.use(createSpareAllowanceRouter({db,secrets:{listClaudeAccounts:()=>[]},codexAccounts:{list:()=>[{id:'spare',label:'Spare',connected:true}]}} as unknown as AppContext));
  await new Promise<void>(resolve=>{server=app.listen(0,'127.0.0.1',resolve);});base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(()=>{server.close();db.close();});
async function call(method:string,path:string,body?:unknown,headers:Record<string,string>={}) {
  const response=await fetch(base+path,{method,headers:{'Content-Type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body)});
  return {status:response.status,body:await response.json() as Record<string,any>};
}
it('rejects employee writes and scopes bot task preparation and reads to its own original chat',async()=>{
  expect((await call('POST','/tasks',input,{'x-user':'2'})).status).toBe(403);
  expect((await call('POST','/tasks',input,{'x-chat':'other'})).status).toBe(409);
  const created=await call('POST','/tasks',input,{'x-chat':'piper'});expect(created.status).toBe(200);
  const own=await call('GET','/',undefined,{'x-chat':'piper'});expect(own.body.tasks).toHaveLength(1);
  const other=await call('GET','/',undefined,{'x-chat':'other'});expect(other.body.tasks).toHaveLength(0);
  expect(other.body.conversations.every((c:{id:string})=>c.id==='other')).toBe(true);
});
it('deduplicates exact definitions and rejects key reuse or disconnected subscriptions',async()=>{
  const first=await call('POST','/tasks',input);const repeated=await call('POST','/tasks',input);
  expect(repeated.body.task.id).toBe(first.body.task.id);
  expect((await call('POST','/tasks',{...input,prompt:'Another task'})).status).toBe(409);
  expect((await call('POST','/tasks',{...input,request_key:'disconnected',account_ids:['missing']})).status).toBe(409);
});
it('allows human pause, keeps completed work terminal, and refuses automatic UNKNOWN replay',async()=>{
  const task=(await call('POST','/tasks',input)).body.task;
  expect((await call('PATCH',`/tasks/${task.id}`,{status:'paused'})).status).toBe(200);
  expect((await call('PATCH',`/tasks/${task.id}`,{status:'ready'})).status).toBe(200);
  db.prepare("UPDATE spare_allowance_tasks SET status='blocked' WHERE id=?").run(task.id);
  expect((await call('PATCH',`/tasks/${task.id}`,{status:'ready'})).status).toBe(409);
  expect((await call('PATCH',`/tasks/${task.id}`,{status:'completed'},{'x-chat':'piper'})).status).toBe(409);
  expect((await call('PATCH',`/tasks/${task.id}`,{status:'completed'})).status).toBe(200);
  expect((await call('PATCH',`/tasks/${task.id}`,{status:'ready'})).status).toBe(409);
  expect((await call('POST','/settings',{enabled:false},{'x-chat':'piper'})).status).toBe(409);
  expect((await call('POST','/settings',{enabled:false})).status).toBe(200);
});
it('requires exact optional execution identity for checkpoints, not a normal bot or a human',async()=>{
  const checkpoint={outcome:'completed',cursor:null,summary:'Saved gallery'};
  expect((await call('POST','/checkpoint',checkpoint)).status).toBe(409);
  expect((await call('POST','/checkpoint',checkpoint,{'x-chat':'piper'})).status).toBe(409);
});
