import {it,expect} from 'vitest';
import Database from 'better-sqlite3';
import {EventEmitter} from 'node:events';
import {createServer} from 'node:http';
import {fileURLToPath} from 'node:url';
import {WebSocket} from 'ws';
import {migrate} from '../src/db/migrate.js';
import {attachWebSocket} from '../src/channels/webSocket.js';
import type {AppContext} from '../src/context.js';
it('buffers snapshot races by runner watermark and authorizes each older page after revocation',async()=>{
 const db=new Database(':memory:');migrate(db,fileURLToPath(new URL('../src/db/migrations',import.meta.url)));
 db.exec("INSERT INTO users(id,email,display_name,role) VALUES(1,'owner@fixture.test','Owner','owner'),(2,'viewer@fixture.test','Viewer','member'); INSERT INTO conversations(id,assistant_id,user_id,title,provider,native_session_id,visibility) VALUES('chat',1,1,'Fixture','claude','fixture','team')");
 const bus=new EventEmitter(),token='11111111-1111-4111-8111-111111111111';let release:((value:unknown)=>void)|undefined,calls=0;
 const initial=new Promise(resolve=>release=resolve);
 const ctx={db,resolveIdentity:async()=>({email:'viewer@fixture.test'}),manager:{bus,historyPage:async(_id:string,t?:string)=>{calls++;return t?{events:[],history:{token,before:0,hasOlder:false,total:2,nextSequence:2,streamRevision:10,oversized:[]}}:initial;},statusOf:async()=>'idle',activityOf:async()=>null,queueSnapshot:async()=>({revision:0,messages:[],failedTurn:null}),listWakeups:async()=>[]}} as unknown as AppContext;
 const server=createServer();attachWebSocket(server,ctx);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 const socket=new WebSocket(`ws://127.0.0.1:${(server.address() as {port:number}).port}/ws`),frames:Record<string,unknown>[]=[];socket.on('message',data=>frames.push(JSON.parse(String(data))));
 try{
 await new Promise<void>((r,j)=>{socket.once('open',r);socket.once('error',j);});
 socket.send(JSON.stringify({kind:'subscribe',conversationId:'chat'}));await new Promise(r=>setTimeout(r,20));
 bus.emit('event','chat',{type:'notice',message:'already in snapshot',streamRevision:9});bus.emit('event','chat',{type:'notice',message:'later event',streamRevision:11});
 release!({events:[],history:{token,before:1,hasOlder:true,total:2,nextSequence:2,streamRevision:10,oversized:[]}});
 await new Promise(r=>setTimeout(r,20));expect(frames.map(f=>f.kind)).toEqual(['snapshot','event']);expect(frames[1]?.event).toMatchObject({message:'later event'});
 socket.send(JSON.stringify({kind:'history',conversationId:'chat',token,before:1}));await new Promise(r=>setTimeout(r,20));expect(frames.at(-1)?.kind).toBe('history');
 db.exec("UPDATE conversations SET visibility='private' WHERE id='chat'");
 socket.send(JSON.stringify({kind:'history',conversationId:'chat',token,before:1}));await new Promise(r=>setTimeout(r,20));expect(frames.at(-1)?.kind).toBe('error');expect(calls).toBe(2);
 }finally{socket.close();await new Promise<void>(r=>server.close(()=>r()));db.close();}
});
