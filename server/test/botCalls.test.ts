import Database from 'better-sqlite3';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { migrate } from '../src/db/migrate.js';
import { createBotService, proposalSchema } from '../src/bots/service.js';
import { botCalls, inCallWindow, tickBotCalls, PAUSE_MS, RETRY_MS, RING_MS } from '../src/bots/botCalls.js';
import { sendCallPush } from '../src/botWorkflows/notifications.js';
import type { UserRow } from '../src/db/db.js';
import type { AppContext } from '../src/context.js';

describe('bot calls',()=>{
 let db: Database.Database; let user:UserRow; let service:ReturnType<typeof createBotService>; let ctx:AppContext; let onCall=false;
 const raise=(bot:string,key:string)=>service.raise({user,conversationId:bot},{source_key:key,proposal_key:key,proposal:proposalSchema.parse({question:`Review ${key}?`,recommendation:'Use the internal draft.',consequence:'Internal test only.',assignee_id:1,blocked_action:'Internal fixture',choices:[{id:'use',label:'Use draft',action:'approve',answer:'draft',recommended:true},{id:'hold',label:'Hold',action:'defer'}]})});
 // 2026-10-02 14:00 UTC is 10:00 in New York: inside the default 08:00-18:00 window.
 const NOON=new Date('2026-10-02T14:00:00Z');
 beforeEach(()=>{
  vi.useFakeTimers();vi.setSystemTime(NOON);onCall=false;
  db=new Database(':memory:');db.pragma('foreign_keys=ON');migrate(db,fileURLToPath(new URL('../src/db/migrations',import.meta.url)));
  db.prepare("INSERT INTO users(id,email,display_name,role) VALUES(1,'owner@example.test','Owner','owner'),(2,'other@example.test','Other','member')").run();
  user=db.prepare('SELECT * FROM users WHERE id=1').get() as UserRow;
  service=createBotService(db);
  for(const bot of ['a','b']) {db.prepare("INSERT INTO conversations(id,assistant_id,user_id,title,provider,native_session_id,visibility) VALUES(?,1,1,?,'claude',?,'private')").run(bot,bot,bot);service.register({user},bot,`Bot ${bot}`,true);}
  ctx={db,liveVoice:{status:()=>onCall?{id:'call'}:null}} as unknown as AppContext;
 });
 afterEach(()=>{vi.useRealTimers();db.close();});
 const enable=(bot:string)=>botCalls(ctx,user).update({bot:{conversationId:bot,enabled:true}});

 it('rings nobody until the person turns a bot on, then rings only that bot',()=>{
  const a=raise('a','a1');raise('b','b1');const calls=botCalls(ctx,user);
  expect(calls.settings().bots.map(b=>b.enabled)).toEqual([false,false]);
  expect(calls.poll(true).ring).toBeNull();
  enable('a');
  expect(calls.poll(true).ring).toMatchObject({decisionId:a.id,conversationId:'a',botName:'Bot a',question:'Review a1?',remainingMs:RING_MS});
  expect(service.view({user},service.read({user},a.id)).answer).toBeNull();
 });
 it('keeps one ring at a time, marks it missed after 25 seconds and retries every 15 minutes without a cap',()=>{
  const a=raise('a','a1');enable('a');enable('b');const calls=botCalls(ctx,user);
  expect(calls.poll(false).ring?.decisionId).toBe(a.id);
  raise('b','b1');
  vi.advanceTimersByTime(10_000);expect(calls.poll(false).ring).toMatchObject({decisionId:a.id,remainingMs:RING_MS-10_000});
  vi.advanceTimersByTime(RING_MS);expect(calls.poll(false).ring).toBeNull();
  expect(db.prepare('SELECT state,attempts FROM bot_call_rings WHERE decision_id=?').get(a.id)).toEqual({state:'missed',attempts:1});
  // The other bot waits out the pause, then takes its turn.
  vi.advanceTimersByTime(PAUSE_MS-1000);expect(calls.poll(false).ring).toBeNull();
  vi.advanceTimersByTime(1000);expect(calls.poll(false).ring?.conversationId).toBe('b');
  calls.decline(calls.poll(false).ring!.decisionId);
  for(let attempt=2;attempt<=5;attempt++){
   vi.advanceTimersByTime(RETRY_MS);
   expect(calls.poll(false).ring?.decisionId).toBe(a.id);
   expect((db.prepare('SELECT attempts FROM bot_call_rings WHERE decision_id=?').get(a.id) as {attempts:number}).attempts).toBe(attempt);
   calls.decline(a.id);vi.advanceTimersByTime(PAUSE_MS);calls.decline(calls.poll(false).ring?.decisionId??a.id);
  }
 });
 it('respects do not disturb, calling hours and recent activity',()=>{
  raise('a','a1');enable('a');const calls=botCalls(ctx,user);
  calls.update({dnd:true});expect(calls.poll(true).ring).toBeNull();
  calls.update({dnd:false});
  vi.setSystemTime(new Date('2026-10-03T03:00:00Z')); // 23:00 in New York
  expect(inCallWindow({window_start:'08:00',window_end:'18:00',timezone:'America/New_York'},Date.now())).toBe(false);
  expect(tickBotCalls(ctx)).toEqual([]);expect(calls.poll(false).ring).toBeNull();
  // Using Veneer right now makes a call welcome outside the hours.
  expect(calls.poll(true).ring).not.toBeNull();
 });
 it('never rings during a live call and waits a pause after it',()=>{
  const a=raise('a','a1');enable('a');const calls=botCalls(ctx,user);
  onCall=true;expect(calls.poll(true).ring).toBeNull();
  onCall=false;db.prepare("INSERT INTO voice_sessions(id,user_id,conversation_id,started_ms,last_seen_ms,ended_ms,outcome) VALUES('s',1,'a',?,?,?,'ended')").run(Date.now()-5000,Date.now(),Date.now());
  expect(calls.poll(true).ring).toBeNull();
  vi.advanceTimersByTime(PAUSE_MS);expect(calls.poll(true).ring?.decisionId).toBe(a.id);
 });
 it('answering reserves the ring, and an unanswered question is tried again later',()=>{
  const a=raise('a','a1');enable('a');const calls=botCalls(ctx,user);
  calls.poll(true);expect(calls.answer(a.id)).toEqual({conversationId:'a',decisionId:a.id});
  onCall=true;expect(calls.poll(true).ring).toBeNull();
  onCall=false;vi.advanceTimersByTime(RETRY_MS-1000);expect(calls.poll(true).ring).toBeNull();
  vi.advanceTimersByTime(1000);expect(calls.poll(true).ring?.decisionId).toBe(a.id);
 });
 it('"I can’t do that now" keeps the card and never rings about it again',()=>{
  const a=raise('a','a1');enable('a');const calls=botCalls(ctx,user);
  calls.poll(true);calls.answer(a.id);expect(calls.stop(a.id)).toEqual({ok:true,stopped:true});
  vi.advanceTimersByTime(RETRY_MS*4);expect(calls.poll(true).ring).toBeNull();expect(calls.ring(a.id)).toBeNull();
  expect(()=>calls.answer(a.id)).toThrow(/no longer waiting/);
  expect(service.view({user},service.read({user},a.id)).state).toBe('needs_input');
 });
 it('stops ringing once the question is answered elsewhere',()=>{
  const a=raise('a','a1');enable('a');const calls=botCalls(ctx,user);
  expect(calls.poll(true).ring).not.toBeNull();
  service.choose({user},a.id,1,'answer','use','','this_case');
  expect(calls.poll(true).ring).toBeNull();expect(()=>calls.answer(a.id)).toThrow();
 });
 it('does not let a person turn on or be rung by a bot they cannot reach',()=>{
  raise('a','a1');const other=db.prepare('SELECT * FROM users WHERE id=2').get() as UserRow;
  expect(botCalls(ctx,other).settings().bots).toEqual([]);
  expect(()=>botCalls(ctx,other).update({bot:{conversationId:'a',enabled:true}})).toThrow();
  expect(botCalls(ctx,other).poll(true).ring).toBeNull();
 });
 it('pushes a ring once to someone who is not using Veneer, and a tapped notification rings again without another attempt',async()=>{
  const a=raise('a','a1');enable('a');
  const pushes=tickBotCalls(ctx);expect(pushes).toMatchObject([{userId:1,ring:{decisionId:a.id,botName:'Bot a'}}]);
  expect(tickBotCalls(ctx)).toEqual([]);
  vi.advanceTimersByTime(RING_MS+1000);expect(tickBotCalls(ctx)).toEqual([]);
  expect(botCalls(ctx,user).ring(a.id)).toMatchObject({decisionId:a.id,remainingMs:RING_MS});
  expect(db.prepare('SELECT state,attempts FROM bot_call_rings WHERE decision_id=?').get(a.id)).toEqual({state:'ringing',attempts:1});
  // Someone who just touched Veneer sees the ring in the app instead.
  botCalls(ctx,user).decline(a.id);vi.advanceTimersByTime(RETRY_MS);botCalls(ctx,user).poll(true);expect(tickBotCalls(ctx)).toEqual([]);
  const sent:string[]=[];const store=new Map([['bot-push-device-d',JSON.stringify({endpoint:'https://web.push.apple.com/x',keys:{p256dh:'A'.repeat(87),auth:'B'.repeat(22)}})],['bot-push-vapid',JSON.stringify({publicKey:'p',privateKey:'k'})]]);
  db.prepare("INSERT INTO bot_push_devices(id,user_id,endpoint_hash) VALUES('d',1,'h')").run();
  const pushCtx={db,secrets:{getApiKeyOverride:(k:string)=>store.get(k)??null,setApiKeyOverride:()=>{},clearApiKeyOverride:()=>{}}} as unknown as AppContext;
  await sendCallPush(pushCtx,1,{decisionId:a.id,botName:'Bot a'},(async(_s:unknown,payload:string)=>{sent.push(payload);}) as never);
  expect(JSON.parse(sent[0]!)).toEqual({kind:'call',caller:'Bot a',href:`#/answer-call/${a.id}`,tag:'veneer-bot-call'});
 });
});
