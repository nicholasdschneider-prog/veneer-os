import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { migrate } from '../src/db/migrate.js';
import { bindWebWatchdog, observeWeb, recordWebSample, type WebSample } from '../src/ops/webWatchdog.js';
import { createConversationWakeupScheduler } from '../src/scheduled/wakeups.js';

it('observes an isolated loopback peer, handles failure and keeps response bodies out of samples', async () => {
  let status=200;
  const peer=http.createServer((_req,res)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify({ok:status===200,web_pid:123,event_loop_delay_ms:22,unrelated:'fixture-only'}));});
  await new Promise<void>(resolve=>peer.listen(0,'127.0.0.1',resolve));
  const port=(peer.address() as AddressInfo).port;
  try {
    expect(await observeWeb(port)).toMatchObject({ok:true,code:'ok',pid:123,eventLoop:22});
    status=503;const sample=await observeWeb(port);
    expect(sample).toMatchObject({ok:false,code:'http_error'});expect(JSON.stringify(sample)).not.toContain('fixture-only');
    const failed=(async()=>{throw new Error('fixture network failure');}) as typeof fetch;
    expect(await observeWeb(port,failed)).toMatchObject({ok:false,code:'unreachable'});
    expect(await observeWeb(port,async()=>new Response('null'))).toMatchObject({ok:false,code:'unreachable'});
    const slow=((_url,init)=>new Promise((_resolve,reject)=>init!.signal!.addEventListener('abort',()=>reject(init!.signal!.reason)))) as typeof fetch;
    expect(await observeWeb(port,slow)).toMatchObject({ok:false,code:'timeout'});
  } finally { await new Promise<void>(resolve=>peer.close(()=>resolve())); }
});

it('durably alerts once, delivers through the native runner and reports measured recovery', () => {
  const db=new Database(':memory:');
  try {
    db.pragma('foreign_keys=ON'); migrate(db,fileURLToPath(new URL('../src/db/migrations',import.meta.url)));
    db.prepare("INSERT INTO users(id,email,display_name,role) VALUES(1,'owner@test','Owner','owner')").run();
    const assistant=(db.prepare("SELECT id FROM assistants WHERE slug='platform-dev'").get() as {id:number}).id;
    db.prepare("INSERT INTO conversations(id,assistant_id,user_id,title,provider,native_session_id) VALUES('repair',?,1,'Repair','codex','synthetic')").run(assistant);
    bindWebWatchdog(db,'repair',1);
    let at=1000000;
    const sample=(bad:boolean, extra:Partial<WebSample>={})=>recordWebSample(db,{at:at+=30000,pid:123,latency:bad?3000:3,cpu:bad?95:15,eventLoop:bad?400:20,ok:!bad,code:bad?'timeout':'ok',...extra});
    expect(sample(true).notification).toBeNull(); expect(sample(true).notification).toBeNull(); expect(sample(true).notification).toBe('stalled');
    for(let i=0;i<5;i++) expect(sample(true).notification).toBeNull();
    expect((db.prepare('SELECT count(*) n FROM conversation_wakeups').get() as {n:number}).n).toBe(1);
    const delivered:string[]=[];
    const scheduler=createConversationWakeupScheduler({db,manager:{deliverWakeup:(_c,text)=>{delivered.push(text);return {disposition:'started'} as never;}},now:()=>new Date(at+1000)});
    scheduler.tick(); expect(delivered).toHaveLength(1); expect(delivered[0]).toContain('health=timeout');
    expect((db.prepare("SELECT status FROM conversation_wakeups").get() as {status:string}).status).toBe('delivered');
    expect(sample(false).notification).toBeNull(); expect(sample(false).notification).toBeNull(); expect(sample(false).notification).toBe('recovered');
    expect((db.prepare('SELECT count(*) n FROM conversation_wakeups').get() as {n:number}).n).toBe(2);
    // Recovery never permits an immediate repeated alert storm.
    for(let i=0;i<4;i++) expect(sample(true).notification).toBeNull();
    db.prepare("UPDATE conversations SET archived=1 WHERE id='repair'").run();
    expect(()=>bindWebWatchdog(db,'repair',1)).toThrow();
    for(let i=0;i<150;i++) sample(true);
    expect((db.prepare('SELECT count(*) n FROM web_watchdog_samples').get() as {n:number}).n).toBe(120);
    expect((db.prepare('SELECT count(*) n FROM conversation_wakeups').get() as {n:number}).n).toBe(2);
  } finally {db.close();}
});

it('rejects foreign ownership and requires independent consecutive observations', () => {
  const db=new Database(':memory:');
  try {
    migrate(db,fileURLToPath(new URL('../src/db/migrations',import.meta.url)));
    expect(()=>bindWebWatchdog(db,'missing',1)).toThrow();
    const s:WebSample={at:1000000,pid:null,latency:3000,cpu:null,eventLoop:null,ok:false,code:'timeout'};
    recordWebSample(db,s); recordWebSample(db,{...s,at:s.at+1});
    expect((db.prepare('SELECT bad_samples FROM web_watchdog_state').get() as {bad_samples:number}).bad_samples).toBe(1);
    recordWebSample(db,{...s,at:s.at+200000});
    expect((db.prepare('SELECT bad_samples FROM web_watchdog_state').get() as {bad_samples:number}).bad_samples).toBe(1);
  } finally {db.close();}
});
