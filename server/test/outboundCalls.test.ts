import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';
import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import type { AppContext } from '../src/context.js';
import type { UserRow } from '../src/db/db.js';
import { ARCHER_CHAT,requestOutboundCall } from '../src/bots/outboundCalls.js';
import { NICK_PHONE,NICK_ACCOUNTS,NICK_ZONE,prepareReminder, type Meeting } from '../src/calendarReminders/service.js';
import { reminderPhoneAdapter } from '../src/calendarReminders/phone.js';
import { markPhoneDispatch,markPhoneAccepted,reservePhone,releaseEndedPhone } from '../src/voice/phoneReservation.js';
import { connectorReminderReader,connectorPins,discoverReminderBindings, type ConnectorExecute } from '../src/calendarReminders/connectorReader.js';
import { startCalendarReminderWorker } from '../src/calendarReminders/worker.js';
import { callBotTool } from '../src/mcp/botTools.js';

let db:Database.Database;let ctx:AppContext;let user:UserRow;
beforeEach(()=>{
  vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-07T13:00:00-04:00'));
  db=new Database(':memory:');migrate(db,fileURLToPath(new URL('../src/db/migrations',import.meta.url)));
  db.prepare("INSERT INTO users(id,email,display_name,role) VALUES(1,?,'Nick','owner')").run(NICK_ACCOUNTS[0]);user=db.prepare('SELECT * FROM users WHERE id=1').get() as UserRow;
  db.prepare("INSERT INTO conversations(id,assistant_id,user_id,title,provider,native_session_id) VALUES(?,1,1,'Archer','codex','synthetic')").run(ARCHER_CHAT);
  db.prepare("INSERT INTO bot_registrations(conversation_id,name,registered_by) VALUES(?,'Archer',1)").run(ARCHER_CHAT);
  db.prepare("INSERT INTO bot_call_settings(user_id,phone,phone_enabled,window_start,window_end) VALUES(1,?,1,'08:00','18:00')").run(NICK_PHONE);
  db.prepare('INSERT INTO bot_call_bots(user_id,conversation_id,enabled) VALUES(1,?,1)').run(ARCHER_CHAT);
  db.prepare('INSERT INTO bot_outbound_policy VALUES(1,?,1)').run(ARCHER_CHAT);
  const values:Record<string,string>={TWILIO_VOICE_ACCOUNT_SID:'ACfixture',TWILIO_VOICE_API_KEY_SID:'SKfixture',TWILIO_VOICE_API_KEY_SECRET:'synthetic',TWILIO_VOICE_FROM_NUMBER:'+15550001111',LIVEKIT_SIP_URI:'sip:test.sip.livekit.cloud'};
  ctx={db,doppler:{get:(n:string)=>values[n]??null},liveVoice:{status:()=>null,start:vi.fn(async(_userId,options)=>{
    await options.beforePhoneDispatch?.();markPhoneDispatch(db,options.phone.logId);
    db.prepare("UPDATE bot_phone_calls SET provider_sid='CAfixture',status='queued' WHERE id=?").run(options.phone.logId);markPhoneAccepted(db,options.phone.logId);return {id:'synthetic-session'};
  })}} as unknown as AppContext;
});
afterEach(()=>{db.close();vi.useRealTimers();});
const input={request_key:'request-original',purpose_key:'original-human-task-123',reason:'Discuss current calendar planning'};
describe('calendar bridge into existing Archer calls',()=>{
  function prepared(){
    const bindings=NICK_ACCOUNTS.map((account,i)=>({account,sourceId:String(i+1),calendarIds:[`calendar-${i+1}`]}));
    const value=prepareReminder(db,user,{ownerEmail:user.email,phone:NICK_PHONE,timezone:NICK_ZONE,leadMinutes:20,enabled:false,policy:'actual-phone-even-when-present;one-attempt;no-redial;all-hours;timed-confirmed-meetings-only',bindings,verifiedAliases:[]});
    db.prepare('UPDATE calendar_phone_settings SET enabled=1').run();
    db.prepare("INSERT INTO calendar_phone_attempts VALUES('original-occurrence',1,'original-key',?,'UNKNOWN','reserved',?,?,NULL)").run(value.manifestHash,Date.now(),Date.now());
    db.prepare("INSERT INTO calendar_phone_lock VALUES(1,'original-occurrence')").run();
    const meeting:Meeting={account:NICK_ACCOUNTS[0],sourceId:'1',calendarId:'calendar-1',id:'synthetic',iCalUID:'synthetic-uid',startMs:Date.now()+1200000,endMs:Date.now()+3600000,originalStartMs:null,recurring:false,status:'confirmed',eligible:true,title:'Synthetic meeting'};
    return {to:NICK_PHONE,meeting,attemptId:'original-occurrence',beforeDispatch:vi.fn(async()=>{})};
  }
  it('uses the same Archer voice path and actual phone outside ordinary hours under the calendar policy',async()=>{
    vi.setSystemTime(new Date('2026-10-07T23:00:00-04:00'));const call=prepared();
    expect(await reminderPhoneAdapter(ctx,user).place(call)).toEqual({providerId:'CAfixture'});expect(call.beforeDispatch).toHaveBeenCalledOnce();
    expect(ctx.liveVoice!.start).toHaveBeenCalledWith(1,expect.objectContaining({botConversationId:ARCHER_CHAT,outboundReason:expect.stringContaining('questions or new instructions'),phone:expect.objectContaining({to:NICK_PHONE})}));
    expect(db.prepare('SELECT count(*) AS n FROM bot_decisions').get()).toEqual({n:0});
  });
  it('honors a pause during final source read without dialing or clearing the original UNKNOWN occurrence',async()=>{
    const call=prepared();call.beforeDispatch=vi.fn(async()=>{db.prepare('UPDATE calendar_phone_settings SET enabled=0').run();});
    await expect(reminderPhoneAdapter(ctx,user).place(call)).rejects.toThrow();
    expect(db.prepare('SELECT count(*) AS n FROM phone_call_locks').get()).toEqual({n:0});
    expect(db.prepare("SELECT state FROM calendar_phone_attempts WHERE id='original-occurrence'").get()).toEqual({state:'UNKNOWN'});
    expect(db.prepare('SELECT provider_sid FROM bot_phone_calls').get()).toEqual({provider_sid:null});
  });
});
describe('original Archer non-decision calls',()=>{
  it('uses the existing voice start, original chat and configured phone with no fake decision',async()=>{
    expect(await requestOutboundCall(ctx,user,ARCHER_CHAT,input)).toMatchObject({state:'STARTED',providerAcceptanceOnly:true});
    expect(ctx.liveVoice!.start).toHaveBeenCalledWith(1,expect.objectContaining({botConversationId:ARCHER_CHAT,outboundReason:input.reason,phone:expect.objectContaining({to:NICK_PHONE})}));
    expect(db.prepare('SELECT count(*) AS n FROM bot_decisions').get()).toEqual({n:0});
    expect(db.prepare('SELECT phase FROM phone_call_locks').get()).toEqual({phase:'ACCEPTED'});
    expect(await requestOutboundCall(ctx,user,ARCHER_CHAT,input)).toMatchObject({state:'STARTED',execute:false,replayed:false});expect(ctx.liveVoice!.start).toHaveBeenCalledTimes(1);
  });
  it.each(['other-bot','human','different-phone','disabled','dnd','owner-revoked'] as const)('denies %s before reservation',async mode=>{
    if(mode==='different-phone')db.prepare('UPDATE bot_call_settings SET phone=?').run('+15550009999');
    if(mode==='disabled')db.prepare('UPDATE bot_outbound_policy SET enabled=0').run();
    if(mode==='dnd')db.prepare('UPDATE bot_call_settings SET dnd=1').run();
    if(mode==='owner-revoked')db.prepare("UPDATE users SET role='member'").run();
    await expect(requestOutboundCall(ctx,user,mode==='other-bot'?'other':mode==='human'?undefined:ARCHER_CHAT,input)).rejects.toThrow();
    expect(ctx.liveVoice!.start).not.toHaveBeenCalled();expect(db.prepare('SELECT count(*) AS n FROM bot_phone_calls').get()).toEqual({n:0});
  });
  it('retains UNKNOWN and forbids another key, another purpose or process-local retry',async()=>{
    ctx.liveVoice!.start=vi.fn(async(_id,options)=>{markPhoneDispatch(db,options.phone!.logId);throw new Error('synthetic provider timeout');});
    expect(await requestOutboundCall(ctx,user,ARCHER_CHAT,input)).toMatchObject({state:'UNKNOWN',retryAllowed:false});
    expect(await requestOutboundCall(ctx,user,ARCHER_CHAT,input)).toMatchObject({state:'UNKNOWN',replayed:false});
    await expect(requestOutboundCall(ctx,user,ARCHER_CHAT,{...input,request_key:'replacement'})).rejects.toThrow();
    await expect(requestOutboundCall(ctx,user,ARCHER_CHAT,{...input,request_key:'different',purpose_key:'different'})).rejects.toThrow();
    expect(ctx.liveVoice!.start).toHaveBeenCalledTimes(1);expect(db.prepare('SELECT phase FROM phone_call_locks').get()).toEqual({phase:'UNKNOWN'});
  });
  it('one shared reservation excludes decision/test/generic calls until exact terminal proof',async()=>{
    await requestOutboundCall(ctx,user,ARCHER_CHAT,input);
    expect(()=>reservePhone(db,user.id,NICK_PHONE,null)).toThrow();
    const {id}=db.prepare('SELECT id FROM bot_phone_calls').get() as {id:string};
    releaseEndedPhone(db,id,'wrong-provider');expect(()=>reservePhone(db,user.id,NICK_PHONE,null)).toThrow();
    releaseEndedPhone(db,id,'CAfixture');expect(reservePhone(db,user.id,NICK_PHONE,null)).toBeTypeOf('string');
  });
  it('MCP targets a dedicated route with no recipient or decision field',async()=>{
    const api=vi.fn(async()=>({state:'UNKNOWN',execute:false}));await callBotTool({name:'request_bot_call',args:input,callApi:api});
    expect(api).toHaveBeenCalledWith('/api/bots/outbound-calls',{method:'POST',body:JSON.stringify(input)});
  });
  it('disabled reminder worker does not read any connector or place a call and stops cleanly',async()=>{
    const stop=startCalendarReminderWorker(ctx);await vi.advanceTimersByTimeAsync(90_000);stop();await vi.advanceTimersByTimeAsync(90_000);
    expect(ctx.liveVoice!.start).not.toHaveBeenCalled();
  });
});

describe('existing owner calendar connector reuse',()=>{
  const bindings=()=>NICK_ACCOUNTS.map((account,i)=>({account,sourceId:String(i+1),calendarIds:[`calendar-${i+1}`]}));
  const execute:ConnectorExecute=async(b,slug,args)=>{
    if(slug==='GOOGLECALENDAR_GET_CURRENT_USER')return {email:NICK_ACCOUNTS[Number(b.sourceId)-1],verified_email:true};
    if(slug==='GOOGLECALENDAR_LIST_CALENDARS')return {items:[{id:`calendar-${b.sourceId}`,accessRole:'owner'}]};
    const event={id:'synthetic-instance',iCalUID:'uid',status:'confirmed',recurringEventId:'series',originalStartTime:{dateTime:'2026-10-08T13:00:00-04:00'},start:{dateTime:'2026-10-08T14:00:00-04:00'},end:{dateTime:'2026-10-08T15:00:00-04:00'}};
    if(slug==='GOOGLECALENDAR_EVENTS_LIST'){expect(args.singleEvents).toBe(true);expect(args.showDeleted).toBe(true);return {items:[event]};}return event;
  };
  function install(){for(let i=1;i<=3;i++)db.prepare("INSERT INTO user_connectors(id,user_id,connector_slug,label,status,config_json,access_mode,access_version) VALUES(?,1,'googlecalendar',?,'connected',?,'read_only',1)").run(i,`Synthetic account ${i}`,JSON.stringify({sessionId:`existing-session-${i}`,connectedAccountId:`existing-account-${i}`}));}
  it('discovers actual account identities and calendar IDs through existing installs, never aliases from labels',async()=>{
    install();const result=await discoverReminderBindings(ctx,1,()=>execute);expect(result).toEqual(bindings());
    const pins=connectorPins(ctx,1,result);expect(pins).toHaveLength(3);expect(JSON.stringify(pins)).not.toContain('token');
  });
  it('requires all three existing accounts, actor access and unchanged native connection config',async()=>{
    install();const pins=connectorPins(ctx,1,bindings());
    db.prepare("UPDATE user_connectors SET status='error' WHERE id=2").run();expect(()=>connectorPins(ctx,1,bindings())).toThrow();
    await expect(discoverReminderBindings(ctx,1,()=>execute)).rejects.toThrow();
    expect(()=>connectorPins(ctx,2,[bindings()[0]!])).toThrow();expect(pins[0]!.connectedAccountId).toBe('existing-account-1');
  });
  it('maps only read tools, validates expanded original occurrence and does not write events',async()=>{
    const mock=vi.fn(execute);const source=connectorReminderReader(mock);const b=bindings()[0]!;
    const result=await source.list(b,Date.now(),Date.now()+86400_000);expect(result.complete).toBe(true);expect(result.meetings[0]).toMatchObject({recurring:true,originalStartMs:Date.parse('2026-10-08T13:00:00-04:00')});
    await source.get(b,result.meetings[0]!);expect(mock.mock.calls.every(c=>['GOOGLECALENDAR_GET_CURRENT_USER','GOOGLECALENDAR_LIST_CALENDARS','GOOGLECALENDAR_EVENTS_LIST','GOOGLECALENDAR_EVENTS_GET'].includes(c[1]))).toBe(true);
  });
});
