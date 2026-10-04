import Database from 'better-sqlite3';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { migrate } from '../src/db/migrate.js';
import { createBotService, proposalSchema } from '../src/bots/service.js';
import { botCalls, inCallWindow, normalizePhone, startPhoneCall, tickBotCalls, PAUSE_MS, PHONE_CALLS_PER_HOUR, RETRY_MS, RING_MS } from '../src/bots/botCalls.js';
import { unofferedNumbers } from '../src/voice/hotlineConsent.js';
import { bridgeTwiml, sipHost, twilioProvider } from '../src/voice/phone.js';
import { sendCallPush } from '../src/botWorkflows/notifications.js';
import type { UserRow } from '../src/db/db.js';
import type { AppContext } from '../src/context.js';

describe('bot calls',()=>{
 let started:{userId:number;options:unknown}[]=[];let startFails=false;
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
  started=[];const secrets:Record<string,string>={TWILIO_VOICE_ACCOUNT_SID:'ACtest',TWILIO_VOICE_API_KEY_SID:'SKtest',TWILIO_VOICE_API_KEY_SECRET:'secret',TWILIO_VOICE_FROM_NUMBER:'+15550001111'};
  ctx={db,doppler:{get:(n:string)=>secrets[n]??null},liveVoice:{status:()=>onCall?{id:'call'}:null,start:async(userId:number,options:unknown)=>{started.push({userId,options});if(startFails)throw new Error('x');return {};}}} as unknown as AppContext;startFails=false;
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
  expect(tickBotCalls(ctx).pushes).toEqual([]);expect(calls.poll(false).ring).toBeNull();
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
  const {pushes,phones}=tickBotCalls(ctx);expect(pushes).toMatchObject([{userId:1,ring:{decisionId:a.id,botName:'Bot a'}}]);expect(phones).toEqual([]);
  expect(tickBotCalls(ctx).pushes).toEqual([]);
  vi.advanceTimersByTime(RING_MS+1000);expect(tickBotCalls(ctx).pushes).toEqual([]);
  expect(botCalls(ctx,user).ring(a.id)).toMatchObject({decisionId:a.id,remainingMs:RING_MS});
  expect(db.prepare('SELECT state,attempts FROM bot_call_rings WHERE decision_id=?').get(a.id)).toEqual({state:'ringing',attempts:1});
  // Someone who just touched Veneer sees the ring in the app instead.
  botCalls(ctx,user).decline(a.id);vi.advanceTimersByTime(RETRY_MS);botCalls(ctx,user).poll(true);expect(tickBotCalls(ctx).pushes).toEqual([]);
  const sent:string[]=[];const store=new Map([['bot-push-device-d',JSON.stringify({endpoint:'https://web.push.apple.com/x',keys:{p256dh:'A'.repeat(87),auth:'B'.repeat(22)}})],['bot-push-vapid',JSON.stringify({publicKey:'p',privateKey:'k'})]]);
  db.prepare("INSERT INTO bot_push_devices(id,user_id,endpoint_hash) VALUES('d',1,'h')").run();
  const pushCtx={db,secrets:{getApiKeyOverride:(k:string)=>store.get(k)??null,setApiKeyOverride:()=>{},clearApiKeyOverride:()=>{}}} as unknown as AppContext;
  await sendCallPush(pushCtx,1,{decisionId:a.id,botName:'Bot a'},(async(_s:unknown,payload:string)=>{sent.push(payload);}) as never);
  expect(JSON.parse(sent[0]!)).toEqual({kind:'call',caller:'Bot a',href:`#/answer-call/${a.id}`,tag:'veneer-bot-call'});
 });
 it('phones a person who is away, only inside their hours, and rings in the app when they are using Veneer',async()=>{
  const a=raise('a','a1');enable('a');const calls=botCalls(ctx,user);
  expect(normalizePhone('(574) 555-0100')).toBe('+15745550100');expect(normalizePhone('1-574-555-0100')).toBe('+15745550100');expect(normalizePhone('555-0100')).toBeNull();
  expect(()=>calls.update({phoneEnabled:true})).toThrow(/Add your phone number/);expect(()=>calls.update({phone:'12'})).toThrow(/area code/);
  expect(calls.update({phone:'(574) 555-0100',phoneEnabled:true})).toMatchObject({phone:'+15745550100',phoneEnabled:true,phoneAvailable:true});
  // Using Veneer right now: the ring stays in the app and nothing is phoned or pushed.
  expect(calls.poll(true).ring?.decisionId).toBe(a.id);expect(tickBotCalls(ctx)).toEqual({pushes:[],phones:[]});
  calls.decline(a.id);vi.advanceTimersByTime(RETRY_MS);
  const tick=tickBotCalls(ctx);expect(tick.pushes).toEqual([]);
  expect(tick.phones).toMatchObject([{userId:1,to:'+15745550100',conversationId:'a',decisionId:a.id}]);
  expect(db.prepare('SELECT state FROM bot_call_rings WHERE decision_id=?').get(a.id)).toEqual({state:'answered'});
  expect(await startPhoneCall(ctx,tick.phones[0]!)).toBe(true);
  expect(started).toEqual([{userId:1,options:{botConversationId:'a',decisionId:a.id,incoming:true,phone:{to:'+15745550100',logId:tick.phones[0]!.logId}}}]);
  // No second call while that one is reserved; it is tried again after the usual gap.
  expect(tickBotCalls(ctx).phones).toEqual([]);vi.advanceTimersByTime(RETRY_MS);expect(tickBotCalls(ctx).phones).toHaveLength(1);
  // Outside the hours the phone stays quiet even though a retry is due.
  vi.setSystemTime(new Date('2026-10-03T03:00:00Z'));expect(tickBotCalls(ctx)).toEqual({pushes:[],phones:[]});
  calls.update({phone:''});expect(calls.settings()).toMatchObject({phone:null,phoneEnabled:false});
 });
 it('caps phone calls per hour, records a call that cannot start, and offers a test call',async()=>{
  enable('a');const calls=botCalls(ctx,user);calls.update({phone:'+15745550100'});
  startFails=true;const test=calls.testPhone();expect(test).toMatchObject({to:'+15745550100',conversationId:'a',decisionId:null});
  expect(await startPhoneCall(ctx,test)).toBe(false);
  expect(db.prepare('SELECT status FROM bot_phone_calls WHERE id=?').get(test.logId)).toEqual({status:'not_started'});
  for(let i=1;i<PHONE_CALLS_PER_HOUR;i++)calls.testPhone();
  expect(()=>calls.testPhone()).toThrow(/enough calls/);
  onCall=true;vi.advanceTimersByTime(3600_001);expect(()=>calls.testPhone()).toThrow(/already on a call/);
 });
 it('only treats a number said with a unit as a stated value',()=>{
  const proposal=JSON.stringify({question:'18 lb or 28 lb in 36 by 20 by 7 inches?'});
  expect(unofferedNumbers(['After 30 seconds.','Yes, that is right.'],proposal)).toEqual([]);
  expect(unofferedNumbers(['It is 18 pounds.'],proposal)).toEqual([]);
  expect(unofferedNumbers(['only like 8 ounces all in'],proposal)).toEqual(['8']);
  expect(unofferedNumbers(['more like $45'],proposal)).toEqual(['45']);
  expect(unofferedNumbers(['it is 40 by 20 by 7'],proposal)).toEqual(['40']);
 });
 it('bridges through the phone provider with the calls-only key and never leaves a webhook',async()=>{
  expect(sipHost('wss://veneer-abc123.livekit.cloud')).toBe('abc123.sip.livekit.cloud');
  const twiml=bridgeTwiml('sip:123@abc.sip.livekit.cloud','veneer','p&w','+15550001111');
  expect(twiml).toContain('<Sip username="veneer" password="p&amp;w">sip:123@abc.sip.livekit.cloud</Sip>');expect(twiml).toContain('timeLimit="300"');
  const calls:{url:string;method:string;body:string;auth:string}[]=[];
  const fetcher=(async(url:string,init:RequestInit)=>{calls.push({url,method:init.method!,body:String(init.body??''),auth:new Headers(init.headers).get('authorization')!});
   return new Response(JSON.stringify(url.endsWith('Calls.json')?{sid:'CA1'}:{status:'in-progress',answered_by:'human'}),{status:200});}) as unknown as typeof fetch;
  const provider=twilioProvider(ctx.doppler,fetcher);
  expect(await provider.place('+15745550100','sip:123@abc.sip.livekit.cloud','veneer','pw')).toBe('CA1');
  const form=new URLSearchParams(calls[0]!.body);
  expect(calls[0]).toMatchObject({url:'https://api.twilio.com/2010-04-01/Accounts/ACtest/Calls.json',method:'POST',auth:`Basic ${Buffer.from('SKtest:secret').toString('base64')}`});
  expect(Object.fromEntries(form)).toMatchObject({To:'+15745550100',From:'+15550001111',Timeout:'25',TimeLimit:'300',AsyncAmd:'true'});
  expect(form.has('Url')).toBe(false);expect(form.has('StatusCallback')).toBe(false);
  expect(await provider.status('CA1')).toEqual({status:'in-progress',answeredBy:'human'});
  await provider.hangUp('CA1');expect(calls[2]).toMatchObject({method:'POST',body:'Status=completed'});
 });
});
