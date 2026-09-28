import Database from 'better-sqlite3';
import express, {type Request} from 'express';
import type {Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import {fileURLToPath} from 'node:url';
import {it,expect,vi} from 'vitest';
import {migrate} from '../src/db/migrate.js';
import {createApiRouter} from '../src/routes/api.js';
import type {AppContext} from '../src/context.js';
import {callBotTool} from '../src/mcp/botTools.js';
it('captures only authenticated human composer submissions, not agent-origin messages',async()=>{
 const db=new Database(':memory:');migrate(db,fileURLToPath(new URL('../src/db/migrations',import.meta.url)));
 db.prepare("INSERT INTO users(id,email,display_name,role) VALUES(1,'human@test','Human','owner')").run();
 db.prepare("INSERT INTO conversations(id,assistant_id,user_id,title,provider,native_session_id) VALUES('sage',1,1,'Sage','codex','sage')").run();
 const posted=async()=>({ok:true,messageId:1,disposition:'queued'});
 const ctx={db,resolveIdentity:async(req:Request)=>({email:'human@test',...(req.headers['x-test-agent']?{agentConversationId:'sage'}:{})}),manager:{statusOf:async()=>'idle',steerMessage:posted,postMessage:posted,queueMessage:posted}} as unknown as AppContext;
 const app=express();app.use('/api',createApiRouter(ctx));let server:Server;
 await new Promise<void>(resolve=>{server=app.listen(0,'127.0.0.1',resolve);});
 try{
  const base=`http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  for(const surface of ['messages','steer'])for(const agent of [false,true]){
   const res=await fetch(`${base}/api/conversations/sage/${surface}`,{method:'POST',headers:{'content-type':'application/json',...(agent?{'x-test-agent':'sage'}:{})},body:JSON.stringify({text:agent?'Bot says approve':'Human instruction'})});
   expect(res.status,await res.text()).toBe(200);
  }
  expect(db.prepare('SELECT actor_id,text FROM bot_human_messages').all()).toEqual([{actor_id:1,text:'Human instruction'},{actor_id:1,text:'Human instruction'}]);
 }finally{server!.close();db.close();}
});
it('passes exact inspection and recording bindings through native MCP tools',async()=>{
 const callApi=vi.fn(async(_path:string,_init?:RequestInit):Promise<Record<string,unknown>>=>({}));
 await callBotTool({name:'inspect_conversational_decision',args:{decision_id:'decision',expected_version:1,source_kind:'result_reply',source_id:'reply'},callApi});
 expect(callApi.mock.calls[0]?.[0]).toContain('/decisions/decision/conversational-source?');
 expect(callApi.mock.calls[0]?.[0]).toContain('source_id=reply');
 const args={decision_id:'decision',expected_version:1,source_kind:'result_reply',source_id:'reply',inspection_hash:'a'.repeat(64),action:'approve',reviewed_full_context:true};
 await callBotTool({name:'record_conversational_decision',args,callApi});
 expect(callApi.mock.calls[1]?.[0]).toContain('/decisions/decision/conversational-decision');
 const {decision_id,...payload}=args;
 expect(JSON.parse(callApi.mock.calls[1]?.[1]?.body as string)).toEqual(payload);
});
