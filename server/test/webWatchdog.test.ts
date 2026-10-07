import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';
import { expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { migrate } from '../src/db/migrate.js';
import { bindWebWatchdog, freshWebLoopDelay, observeWeb, recordWebSample, watchdogPersistenceFailure, type WebSample } from '../src/ops/webWatchdog.js';
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

function enrollFixture(db: Database.Database) {
  db.pragma('foreign_keys=ON');
  migrate(db,fileURLToPath(new URL('../src/db/migrations',import.meta.url)));
  db.prepare("INSERT INTO users(id,email,display_name,role) VALUES(1,'owner@test','Owner','owner')").run();
  const assistant=(db.prepare("SELECT id FROM assistants WHERE slug='platform-dev'").get() as {id:number}).id;
  db.prepare("INSERT INTO conversations(id,assistant_id,user_id,title,provider,native_session_id) VALUES('repair',?,1,'Repair','codex','synthetic')").run(assistant);
  bindWebWatchdog(db,'repair',1);
}

it('keeps an incident open across missing, stale or unattributed metrics and retains bad evidence', () => {
  const db=new Database(':memory:');
  try {
    enrollFixture(db);
    let at=1000000;
    const sample=(extra:Partial<WebSample>={})=>recordWebSample(db,{at:at+=30000,pid:123,latency:3,cpu:15,eventLoop:20,ok:true,code:'ok',...extra});
    sample({eventLoop:400,cpu:null}); sample({eventLoop:400,cpu:null});
    expect(sample({eventLoop:400,cpu:null}).notification).toBe('stalled');
    const incident=(db.prepare('SELECT incident FROM web_watchdog_state').get() as {incident:string}).incident;
    const unknowns:Partial<WebSample>[]=[{cpu:null},{eventLoop:null},{pid:null},{cpu:NaN},{eventLoop:-1},
      {eventLoop:freshWebLoopDelay({pid:123,at:at-90000,delayMs:20},123,at)},
      {eventLoop:freshWebLoopDelay({pid:456,at,delayMs:20},123,at)}];
    for(const unknown of unknowns) {
      sample(); sample();
      for(let i=0;i<3;i++) expect(sample(unknown).notification).toBeNull();
      expect(db.prepare('SELECT incident,good_samples,bad_samples FROM web_watchdog_state').get())
        .toMatchObject({incident,good_samples:0,bad_samples:0});
    }
    expect((db.prepare('SELECT count(*) n FROM conversation_wakeups').get() as {n:number}).n).toBe(1);
    sample(); sample(); expect(sample().notification).toBe('recovered');
  } finally {db.close();}
});

it('rejects stale, future, mismatched and malformed loop telemetry', () => {
  expect(freshWebLoopDelay({pid:123,at:1000,delayMs:25},123,2000)).toBe(25);
  for(const telemetry of [null,{}, {pid:456,at:1000,delayMs:25}, {pid:123,at:2001,delayMs:25},
    {pid:123,at:2000-90000,delayMs:25}, {pid:123,at:NaN,delayMs:25},
    {pid:123,at:1000,delayMs:NaN}, {pid:123,at:1000,delayMs:-1}]) {
    expect(freshWebLoopDelay(telemetry,123,2000)).toBeNull();
  }
});

it('reserves the WAL write lock before reading and leaves no partial evidence under contention', () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'watchdog-contention-'));
  const db=new Database(path.join(dir,'fixture.db'));
  let other:Database.Database | undefined;
  try {
    db.pragma('journal_mode=WAL'); db.pragma('busy_timeout=20'); enrollFixture(db);
    other=new Database(path.join(dir,'fixture.db')); other.pragma('busy_timeout=0');
    const sample:WebSample={at:1000000,pid:123,latency:3,cpu:15,eventLoop:20,ok:true,code:'ok'};
    const before=db.prepare('SELECT * FROM web_watchdog_state').get();
    other.exec('BEGIN IMMEDIATE');
    expect(()=>recordWebSample(db,sample)).toThrow(expect.objectContaining({code:'SQLITE_BUSY'}));
    expect(db.prepare('SELECT * FROM web_watchdog_state').get()).toEqual(before);
    expect(db.prepare('SELECT count(*) n FROM web_watchdog_samples').get()).toEqual({n:0});
    expect(db.prepare('SELECT count(*) n FROM conversation_wakeups').get()).toEqual({n:0});
    other.exec('ROLLBACK');
    // Interleave a competing writer exactly when the transaction first reads
    // its state. A deferred transaction would let it commit and lose its upgrade.
    const prepare=db.prepare.bind(db);
    let competingCode:unknown;
    const spy=vi.spyOn(db,'prepare').mockImplementation((sql:string)=>{
      const statement=prepare(sql);
      if(sql==='SELECT * FROM web_watchdog_state WHERE singleton=1') {
        const get=statement.get.bind(statement);
        statement.get=(...params:unknown[])=>{
          const state=get(...params);
          try {other!.prepare('UPDATE web_watchdog_state SET good_samples=999').run();}
          catch(error) {competingCode=(error as {code:string}).code;}
          return state;
        };
      }
      return statement;
    });
    try {
      bindWebWatchdog(db,'repair',1);
      expect(competingCode).toBe('SQLITE_BUSY');
      competingCode=undefined;
      expect(recordWebSample(db,sample).notification).toBeNull();
    }
    finally {spy.mockRestore();}
    expect(competingCode).toBe('SQLITE_BUSY');
    expect(db.prepare('SELECT good_samples FROM web_watchdog_state').get()).toEqual({good_samples:1});
    expect(db.prepare('SELECT count(*) n FROM web_watchdog_samples').get()).toEqual({n:1});
    recordWebSample(db,sample);
    expect(db.prepare('SELECT count(*) n FROM web_watchdog_samples').get()).toEqual({n:1});
    // Failure at the notification write rolls the sample and incident back too.
    recordWebSample(db,{...sample,at:1030000,ok:false});
    recordWebSample(db,{...sample,at:1060000,ok:false});
    const snapshot=db.prepare('SELECT * FROM web_watchdog_state').get();
    db.exec("CREATE TRIGGER refuse_wake BEFORE INSERT ON conversation_wakeups BEGIN SELECT RAISE(ABORT,'fixture'); END");
    expect(()=>recordWebSample(db,{...sample,at:1090000,ok:false})).toThrow();
    expect(db.prepare('SELECT * FROM web_watchdog_state').get()).toEqual(snapshot);
    expect(db.prepare('SELECT count(*) n FROM web_watchdog_samples').get()).toEqual({n:3});
    expect(db.prepare('SELECT count(*) n FROM conversation_wakeups').get()).toEqual({n:0});
  } finally {other?.close();db.close();fs.rmSync(dir,{recursive:true,force:true});}
});

it('retains only fixed persistence failure categories', () => {
  for(const code of ['SQLITE_BUSY','SQLITE_BUSY_SNAPSHOT']) expect(watchdogPersistenceFailure({code,message:'private fixture'})).toBe('busy');
  expect(watchdogPersistenceFailure({code:'SQLITE_LOCKED_SHAREDCACHE'})).toBe('locked');
  for(const error of [null,new Error('private fixture'),{code:'secret fixture code'},{code:42}]) expect(watchdogPersistenceFailure(error)).toBe('other');
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

it('bounds and sanitizes phase evidence attached to native incident wakes', () => {
  const db=new Database(':memory:');
  try {
    enrollFixture(db);
    for(let i=0;i<3;i++) {
      const at=1000000+i*30000;
      const operations=Array.from({length:50},()=>({at,phase:'routines',kind:'sync',ms:160,failure:'busy',private:'secret fixture'}));
      recordWebSample(db,{at,pid:123,latency:3000,cpu:25,eventLoop:400,ok:false,code:'timeout',operations:operations as never});
    }
    const {reason}=db.prepare('SELECT reason FROM conversation_wakeups').get() as {reason:string};
    expect(reason).not.toContain('secret fixture');
    expect(reason.match(/"phase":"routines"/g)).toHaveLength(6);
    expect(reason).toContain('not proof of the blocking cause');
    expect(reason).toContain('"failure":"busy"');
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
