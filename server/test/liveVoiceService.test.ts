import { EventEmitter } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { AppContext } from '../src/context.js';
import { migrate } from '../src/db/migrate.js';
const fakes = vi.hoisted(() => ({ fork: vi.fn(), createRoom: vi.fn(), deleteRoom: vi.fn() }));
vi.mock('node:child_process', () => ({ fork: fakes.fork }));
vi.mock('livekit-server-sdk', () => ({
  RoomServiceClient: class { createRoom = fakes.createRoom; deleteRoom = fakes.deleteRoom; },
  AccessToken: class { addGrant() {} async toJwt() { return 'test-scoped-token'; } },
  SipClient: class { async listSipInboundTrunk() { return []; } async createSipInboundTrunk() { return { sipTrunkId: 'trunk-1', numbers: [] }; } async createSipDispatchRule() { return { sipDispatchRuleId: 'rule-1' }; } async deleteSipTrunk() { return {}; } async deleteSipDispatchRule() { return {}; } },
}));
import { LiveVoiceService } from '../src/voice/service.js';
import { VoiceWorkspace } from '../src/voice/workspace.js';
import { callVoiceSchema } from '../src/voice/voices.js';
let db: Database.Database;
let service: LiveVoiceService;
let secrets: Record<string,string>;
let manager: { snapshot: ReturnType<typeof vi.fn>; statusOf: ReturnType<typeof vi.fn>; steerMessage: ReturnType<typeof vi.fn> };
let child: EventEmitter & { send: ReturnType<typeof vi.fn>; kill: ReturnType<typeof vi.fn>; connected: boolean; exitCode: number | null };
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks();
  db = new Database(':memory:'); migrate(db,path.join(path.dirname(fileURLToPath(import.meta.url)),'../src/db/migrations'));
  db.prepare("INSERT INTO users(id,email,display_name,role) VALUES(1,'test@example.com','Test','owner')").run();
  secrets = { LIVEKIT_URL:'wss://voice-test.livekit.cloud', LIVEKIT_API_KEY:'test-key', LIVEKIT_API_SECRET:'test-secret', OPENAI_API_KEY:'test-openai' };
  child = Object.assign(new EventEmitter(), { send:vi.fn(),kill:vi.fn(),connected:true,exitCode:null });
  fakes.fork.mockReturnValue(child); fakes.createRoom.mockResolvedValue({}); fakes.deleteRoom.mockResolvedValue({});
  manager = {snapshot:vi.fn().mockResolvedValue([]),statusOf:vi.fn().mockResolvedValue('idle'),steerMessage:vi.fn().mockResolvedValue({ok:true,messageId:1,disposition:'running'})};
  service = new LiveVoiceService({db,manager,doppler:{get:(name:string)=>secrets[name]??null,refresh:async()=>({})}} as unknown as AppContext);
});
afterEach(() => { service.close(); db.close(); vi.useRealTimers(); });
describe('live voice lifecycle', () => {
  it.each([false, true])('uses Archer’s assigned voice for browser and incoming phone calls (phone=%s)', async phoneCall => {
    const archer = 'f4131f81-27c5-4332-902a-a0d9873dfeb9';
    db.prepare("INSERT INTO conversations(id,assistant_id,user_id,title,provider,native_session_id) VALUES(?,1,1,'Archer','codex','archer')").run(archer);
    // Renaming must not affect the exact identity assignment.
    db.prepare("INSERT INTO bot_registrations(conversation_id,name,registered_by) VALUES(?,'Renamed assistant',1)").run(archer);
    db.prepare("INSERT INTO bot_decisions(id,conversation_id,source_key,proposal_key,proposal_json,assignee_id) VALUES('q',?,'q','q',?,1)").run(archer, JSON.stringify({question:'Review this email?',recommendation:'Review',consequence:'Review only',blocked_action:'Review',blocks_scope:'task',deadline:null,evidence:[]}));
    Object.assign(secrets, { TWILIO_VOICE_ACCOUNT_SID:'ACtest', TWILIO_VOICE_API_KEY_SID:'SKtest', TWILIO_VOICE_API_KEY_SECRET:'s', TWILIO_VOICE_FROM_NUMBER:'+15550001111', LIVEKIT_SIP_URI:'sip:test1.sip.livekit.cloud' });
    const store = new Map<string,string>();
    const phone = { place: vi.fn().mockResolvedValue('CA1'), status: vi.fn().mockResolvedValue({status:'ringing',answeredBy:null}), hangUp: vi.fn().mockResolvedValue(undefined) };
    service.close();
    service = new LiveVoiceService({db,manager,doppler:{get:(name:string)=>secrets[name]??null,refresh:async()=>({})},secrets:{getApiKeyOverride:(k:string)=>store.get(k)??null,setApiKeyOverride:(k:string,v:string)=>void store.set(k,v)}} as unknown as AppContext,phone);
    db.prepare("INSERT INTO bot_phone_calls(id,user_id,started_ms) VALUES('voice-test',1,?)").run(Date.now());
    await service.start(1,{botConversationId:archer,...(phoneCall ? {decisionId:'q',incoming:true,phone:{to:'+15745550100',logId:'voice-test'}} : {})});
    const start = child.send.mock.calls.map(a=>a[0]).find(m=>m.type==='start');
    expect(start).toMatchObject({mode:'bot',voice:'cedar'});
    expect(callVoiceSchema.parse(start.voice)).toBe('cedar');
    if (phoneCall) expect(start).toMatchObject({phone:true});
    else expect(start.participantIdentity).toBe('user-1');
  });

  it('keeps other identities and coordinator/hotline calls on Marin and rejects unsupported IPC voices', async () => {
    db.prepare("INSERT INTO conversations(id,assistant_id,user_id,title,provider,native_session_id) VALUES('other',1,1,'Archer','codex','other')").run();
    for (const options of [{botConversationId:'other'}, {}, {hotline:true}]) {
      child.send.mockClear();
      const call = await service.start(1,options);
      expect(child.send.mock.calls.map(a=>a[0]).find(m=>m.type==='start').voice).toBe('marin');
      service.end(1,call.id);
    }
    expect(callVoiceSchema.safeParse('unsupported').success).toBe(false);
    expect(callVoiceSchema.safeParse({id:'custom'}).success).toBe(false);
  });

  it('keeps approved work queued after hangup and never approves an unanswered discussion on end', async () => {
    db.prepare("INSERT INTO conversations(id,assistant_id,user_id,title,provider,native_session_id) VALUES('ticket',1,1,'Ticket owner','codex','ticket')").run();
    db.prepare("INSERT INTO bot_registrations(conversation_id,name,registered_by) VALUES('ticket','Case owner',1)").run();
    for (const id of ['approved','discussed']) db.prepare("INSERT INTO bot_decisions(id,conversation_id,source_key,proposal_key,proposal_json,assignee_id) VALUES(?,'ticket',?,?,?,1)").run(id,id,id,JSON.stringify({question:'Send this reply?',recommendation:'Request a label photo',consequence:'One email',blocked_action:'EXACT DRAFT: Please send the label.',blocks_scope:'task',deadline:null,evidence:[]}));
    const call = await service.start(1,{botConversationId:'ticket',decisionId:'approved'});
    child.emit('message',{type:'tool',id:'approve',name:'answer_decision',args:{decisionId:'approved',version:1,action:'approve',text:'Yes, send that reply'}});
    child.emit('message',{type:'tool',id:'discuss',name:'discuss_decision',args:{decisionId:'discussed',text:'Could we ask for another photo?'}});
    service.end(1,call.id);
    await vi.advanceTimersByTimeAsync(1);
    expect(db.prepare("SELECT state FROM bot_decisions WHERE id='approved'").get()).toEqual({state:'decided'});
    expect(db.prepare("SELECT state,answer_json FROM bot_decisions WHERE id='discussed'").get()).toEqual({state:'needs_input',answer_json:null});
    expect(db.prepare("SELECT count(*) AS n FROM conversation_wakeups WHERE conversation_id='ticket' AND reason LIKE 'VeneerBots answer.%'").get()).toEqual({n:1});
    expect(db.prepare("SELECT count(*) AS n FROM bot_decision_events WHERE decision_id='approved' AND kind='answered'").get()).toEqual({n:1});
  });

  it('finishes an accepted instruction dispatch after its caller hangs up without replaying it', async () => {
    db.prepare("INSERT INTO conversations(id,assistant_id,user_id,title,provider,native_session_id) VALUES('ticket',1,1,'Ticket owner','codex','ticket')").run();
    let deliver!: (value: unknown) => void;
    manager.steerMessage.mockImplementation(() => new Promise(resolve => { deliver=resolve; }));
    const call = await service.start(1,{botConversationId:'ticket'});
    child.emit('message',{type:'tool',id:'followup',name:'send_message',args:{instructionId:'followup',text:'Investigate the missing parcel'}});
    service.end(1,call.id);
    deliver({messageId:17,disposition:'queued'});
    await vi.advanceTimersByTimeAsync(1);
    expect(manager.steerMessage).toHaveBeenCalledTimes(1);
    const row = db.prepare("SELECT result_json FROM voice_dispatches WHERE instruction_id='followup'").get() as {result_json:string};
    expect(JSON.parse(row.result_json)).toMatchObject({ok:true,messageId:17,disposition:'queued'});
    expect(db.prepare("SELECT count(*) AS n FROM voice_entries WHERE session_id=? AND role='decision'").get(call.id)).toEqual({n:1});
  });
  it('speaks as the bot in first person and never as a third-party voice line', async () => {
    db.prepare("INSERT INTO conversations(id,assistant_id,user_id,title,provider,native_session_id) VALUES('sage',1,1,'Sage','codex','sage')").run();
    db.prepare("INSERT INTO bot_registrations(conversation_id,name,registered_by) VALUES('sage','Sage',1)").run();
    await service.start(1,{botConversationId:'sage'});
    const start = child.send.mock.calls.map(a=>a[0]).find(m=>m.type==='start');
    expect(start.instructions).toContain('You ARE Sage');
    expect(start.instructions).toContain('never say "I\'ll let Sage know"');
    expect(start.instructions).toContain('call send_message immediately');
    expect(start.instructions).not.toContain('voice line for');
    expect(start.instructions).not.toContain("Sage's voice line");
  });
  it('asks its one question plainly on a call the bot placed, stops calling on request, and hangs up itself', async () => {
    db.prepare("INSERT INTO conversations(id,assistant_id,user_id,title,provider,native_session_id) VALUES('sage',1,1,'Sage','codex','sage')").run();
    db.prepare("INSERT INTO bot_registrations(conversation_id,name,registered_by) VALUES('sage','Sage',1)").run();
    db.prepare("INSERT INTO bot_decisions(id,conversation_id,source_key,proposal_key,proposal_json,assignee_id) VALUES('q','sage','q','q',?,1)").run(JSON.stringify({question:'Ship the order today?',recommendation:'Yes',consequence:'One shipment',blocked_action:'Shipment',blocks_scope:'task',deadline:null,evidence:[]}));
    // An ordinary call on the same question keeps the saved greeting and has no hangup tools.
    const plain = await service.start(1,{botConversationId:'sage',decisionId:'q'});
    const ordinary = child.send.mock.calls.map(a=>a[0]).find(m=>m.type==='start');
    expect(ordinary.opening).toBeUndefined(); expect(ordinary.instructions).not.toContain('YOU PLACED THIS CALL');
    expect(service.status(1)).toMatchObject({incoming:false});
    service.end(1,plain.id); child.send.mockClear();
    const call = await service.start(1,{botConversationId:'sage',decisionId:'q',incoming:true});
    const start = child.send.mock.calls.map(a=>a[0]).find(m=>m.type==='start');
    expect(start.opening).toContain("say it's Sage"); expect(start.opening).toContain('No recap'); expect(start.opening).toContain('never a fixed template');
    expect(start.opening).toContain('a short hello to Test'); expect(start.opening).toContain('leave out order numbers');
    // Conversational, with a light read-back only where something could be misheard.
    expect(start.instructions).toContain('Talk like a colleague on a quick call, not a script');
    expect(start.instructions).toContain('Never re-ask the whole question when only one piece is missing');
    expect(start.instructions).toContain('say it back once, short and natural');
    expect(start.instructions).toContain('plain yes or no'); expect(start.instructions).toContain('do not recite the value again');
    expect(start.instructions).toContain('never pick the nearest option');
    expect(start.instructions).not.toContain('Recording an answer takes two caller turns');
    expect(start.instructions).toContain('YOU PLACED THIS CALL'); expect(start.instructions).toContain('decision q');
    expect(service.status(1)).toMatchObject({incoming:true,decisionId:'q'});
    child.emit('message',{type:'tool',id:'stop',name:'stop_calling',args:{}});
    await vi.advanceTimersByTimeAsync(1);
    expect(child.send.mock.calls.map(a=>a[0]).find(m=>m.id==='stop').result).toEqual({ok:true,stopped:true});
    expect(db.prepare("SELECT state FROM bot_call_rings WHERE user_id=1 AND decision_id='q'").get()).toEqual({state:'stopped'});
    expect(db.prepare("SELECT state,answer_json FROM bot_decisions WHERE id='q'").get()).toEqual({state:'needs_input',answer_json:null});
    child.emit('message',{type:'closed',reason:'user_initiated'});
    child.emit('message',{type:'tool',id:'bye',name:'end_call',args:{}});
    await vi.advanceTimersByTimeAsync(1);
    expect(service.status(1)).toBeNull();
    expect(db.prepare('SELECT outcome,end_reason FROM voice_sessions WHERE id=?').get(call.id)).toEqual({outcome:'ended',end_reason:'agent_ended/worker_user_initiated'});
  });
  it('never records an offered option the caller did not state on a call the bot placed', async () => {
    db.prepare("INSERT INTO conversations(id,assistant_id,user_id,title,provider,native_session_id) VALUES('ship',1,1,'Ship','codex','ship')").run();
    db.prepare("INSERT INTO bot_registrations(conversation_id,name,registered_by) VALUES('ship','Shipper',1)").run();
    db.prepare("INSERT INTO bot_decisions(id,conversation_id,source_key,proposal_key,proposal_json,assignee_id) VALUES('w','ship','w','w',?,1)").run(JSON.stringify({question:'Do both knobs pack in 10 by 4 by 4 inches at 24 oz, or 12 by 6 by 4 at 32 oz?',recommendation:'24 oz',consequence:'One label',blocked_action:'Label',blocks_scope:'task',deadline:null,evidence:[],assignee_id:1,
      choices:[{id:'a',label:'10×4×4 in, 24 oz',action:'approve',answer:'One package 10x4x4in24oz',recommended:true},{id:'b',label:'12×6×4 in, 32 oz',action:'approve',answer:'One package 12x6x4in32oz'}]}));
    await service.start(1,{botConversationId:'ship',decisionId:'w',incoming:true});
    const tool = async (id:string,name:string,args:Record<string,unknown>) => { child.emit('message',{type:'tool',id,name,args}); await vi.advanceTimersByTimeAsync(1); return child.send.mock.calls.map(a=>a[0]).find(m=>m.id===id).result; };
    const say = (turn:number,text:string) => { child.emit('message',{type:'caller_turn',turn}); child.emit('message',{type:'caller_final',turn,text}); };
    // Nothing said yet: no answer can be recorded.
    expect((await tool('t0','answer_choice',{decisionId:'w',version:1,choiceId:'a',text:'24 oz',callerQuote:'yes'})).error).toMatch(/No fresh matching caller answer/);
    say(1,'10 by 4 by 4, a polymailer, only like 8 ounces all in.');
    say(2,'Yes.');
    // The caller said 8, which no option offers: the nearest option is refused.
    expect((await tool('t1','answer_choice',{decisionId:'w',version:1,choiceId:'a',text:'24 oz',callerQuote:'Yes.'})).error).toMatch(/caller said 8, which is not in any offered option/);
    expect(db.prepare("SELECT state FROM bot_decisions WHERE id='w'").get()).toEqual({state:'needs_input'});
    say(3,'Yes, 8 ounces.');
    const custom = await tool('t2','answer_custom',{decisionId:'w',version:1,text:'10 by 4 by 4 polymailer, about 8 oz total',callerQuote:'Yes, 8 ounces.'});
    expect(custom).toMatchObject({ok:true,recorded:expect.stringContaining('about 8 oz total')});
    const answer = JSON.parse((db.prepare("SELECT answer_json FROM bot_decisions WHERE id='w'").get() as {answer_json:string}).answer_json);
    expect(answer).toMatchObject({action:'custom',choice_id:'custom'});
    expect(answer.answer).toContain('8 oz'); expect(answer.answer).toContain('only like 8 ounces all in'); expect(answer.answer).not.toContain('24oz');
  });
  it('records an offered option on a placed call when the caller states and confirms it', async () => {
    db.prepare("INSERT INTO conversations(id,assistant_id,user_id,title,provider,native_session_id) VALUES('ship',1,1,'Ship','codex','ship')").run();
    db.prepare("INSERT INTO bot_registrations(conversation_id,name,registered_by) VALUES('ship','Shipper',1)").run();
    db.prepare("INSERT INTO bot_decisions(id,conversation_id,source_key,proposal_key,proposal_json,assignee_id) VALUES('g','ship','g','g',?,1)").run(JSON.stringify({question:'Is the glass 18 pounds or 28 pounds packed?',recommendation:'18',consequence:'One label',blocked_action:'Label',blocks_scope:'task',deadline:null,evidence:[],assignee_id:1,
      choices:[{id:'18',label:'18 lb',action:'approve',answer:'18lb total',recommended:true},{id:'28',label:'28 lb',action:'approve',answer:'28lb total'}]}));
    await service.start(1,{botConversationId:'ship',decisionId:'g',incoming:true});
    child.emit('message',{type:'caller_turn',turn:1}); child.emit('message',{type:'caller_final',turn:1,text:'It is 28 pounds.'});
    child.emit('message',{type:'caller_turn',turn:2}); child.emit('message',{type:'caller_final',turn:2,text:"Yes, that's right."});
    child.emit('message',{type:'tool',id:'ok',name:'answer_choice',args:{decisionId:'g',version:1,choiceId:'28',text:'28 lb confirmed',callerQuote:"Yes, that's right."}});
    await vi.advanceTimersByTimeAsync(1);
    expect(child.send.mock.calls.map(a=>a[0]).find(m=>m.id==='ok').result).toMatchObject({ok:true,recorded:'28lb total'});
    const answer = JSON.parse((db.prepare("SELECT answer_json FROM bot_decisions WHERE id='g'").get() as {answer_json:string}).answer_json);
    expect(answer).toMatchObject({action:'approve',choice_id:'28'}); expect(answer.text).toContain('It is 28 pounds.');
    // A replayed quote cannot record a second answer.
    child.emit('message',{type:'tool',id:'again',name:'answer_choice',args:{decisionId:'g',version:1,choiceId:'18',text:'18',callerQuote:"Yes, that's right."}});
    await vi.advanceTimersByTimeAsync(1);
    expect(child.send.mock.calls.map(a=>a[0]).find(m=>m.id==='again').result.error).toBeTruthy();
  });
  it('phones the person, bridges them into the room, and hangs up on voicemail without speaking', async () => {
    db.prepare("INSERT INTO conversations(id,assistant_id,user_id,title,provider,native_session_id) VALUES('sage',1,1,'Sage','codex','sage')").run();
    db.prepare("INSERT INTO bot_registrations(conversation_id,name,registered_by) VALUES('sage','Sage',1)").run();
    Object.assign(secrets, { TWILIO_VOICE_ACCOUNT_SID:'ACtest', TWILIO_VOICE_API_KEY_SID:'SKtest', TWILIO_VOICE_API_KEY_SECRET:'s', TWILIO_VOICE_FROM_NUMBER:'+15550001111', LIVEKIT_SIP_URI:'sip:test1.sip.livekit.cloud' });
    const store = new Map<string,string>();
    const phone = { place: vi.fn().mockResolvedValue('CA1'), status: vi.fn().mockResolvedValue({ status:'ringing', answeredBy:null }), hangUp: vi.fn().mockResolvedValue(undefined) };
    service.close();
    service = new LiveVoiceService({db,manager,doppler:{get:(name:string)=>secrets[name]??null,refresh:async()=>({})},
      secrets:{getApiKeyOverride:(k:string)=>store.get(k)??null,setApiKeyOverride:(k:string,v:string)=>void store.set(k,v)}} as unknown as AppContext, phone);
    const log = (id:string) => { db.prepare("INSERT INTO bot_phone_calls(id,user_id,started_ms) VALUES(?,1,?)").run(id,Date.now()); return id; };
    const call = await service.start(1,{botConversationId:'sage',phone:{to:'+15745550100',logId:log('p1')}});
    await vi.advanceTimersByTimeAsync(1);
    const start = child.send.mock.calls.map(a=>a[0]).find(m=>m.type==='start');
    child.emit('message',{type:'ready'});
    expect(start.phone).toBe(true); expect(start.participantIdentity).toBeUndefined();
    expect(start.instructions).toContain('THIS IS A PHONE CALL'); expect(start.instructions).toContain('never leave a message');
    expect(start.instructions).toContain('do not start over from the top'); expect(start.instructions).toContain('not a form');
    expect(call.token).toBe('');
    const [to, uri, sipUser, sipPassword] = phone.place.mock.calls[0]!;
    expect(to).toBe('+15745550100'); expect(uri).toMatch(/^sip:\d{18}@test1\.sip\.livekit\.cloud;transport=tcp$/); expect(sipUser).toBe('veneer'); expect(String(sipPassword).length).toBeGreaterThan(20);
    expect(fakes.createRoom.mock.calls.at(-1)![0].name).toBe(`veneer-voice-phone_${String(uri).slice(4,22)}`);
    expect(store.get('bot-call-sip')).toContain('trunk-1');
    expect(db.prepare("SELECT provider_sid,status,voice_session_id FROM bot_phone_calls WHERE id='p1'").get()).toEqual({provider_sid:'CA1',status:'queued',voice_session_id:call.id});
    // No browser heartbeat is expected on a phone call.
    await vi.advanceTimersByTimeAsync(95_000); expect(service.status(1)).toMatchObject({phone:true});
    phone.status.mockResolvedValue({ status:'in-progress', answeredBy:'machine_end_beep' });
    await vi.advanceTimersByTimeAsync(3000);
    expect(service.status(1)).toBeNull(); expect(phone.hangUp).toHaveBeenCalledWith('CA1');
    expect(db.prepare('SELECT end_reason FROM voice_sessions WHERE id=?').get(call.id)).toEqual({end_reason:'phone_voicemail'});
    expect(db.prepare("SELECT status,answered_by,ended_ms IS NOT NULL AS ended FROM bot_phone_calls WHERE id='p1'").get()).toEqual({status:'in-progress',answered_by:'machine_end_beep',ended:1});
    // A person hanging up is a normal end, and the model's voicemail tool ends the call too.
    phone.status.mockResolvedValue({ status:'in-progress', answeredBy:'human' });
    const second = await service.start(1,{botConversationId:'sage',phone:{to:'+15745550100',logId:log('p2')}});
    await vi.advanceTimersByTimeAsync(1);
    child.emit('message',{type:'joined'}); child.emit('message',{type:'closed',reason:'participant_disconnected'});
    expect(db.prepare('SELECT outcome,end_reason,connected_ms IS NOT NULL AS connected FROM voice_sessions WHERE id=?').get(second.id)).toEqual({outcome:'ended',end_reason:'phone_hangup/worker_participant_disconnected',connected:1});
    const third = await service.start(1,{botConversationId:'sage',phone:{to:'+15745550100',logId:log('p3')}});
    child.emit('message',{type:'tool',id:'vm',name:'voicemail',args:{}}); await vi.advanceTimersByTimeAsync(1);
    expect(db.prepare('SELECT end_reason FROM voice_sessions WHERE id=?').get(third.id)).toEqual({end_reason:'phone_voicemail'});
    // A call that cannot be placed ends cleanly.
    phone.place.mockRejectedValueOnce(new Error('refused'));
    const fourth = await service.start(1,{botConversationId:'sage',phone:{to:'+15745550100',logId:log('p4')}});
    await vi.advanceTimersByTimeAsync(1);
    expect(service.status(1)).toBeNull();
    expect(db.prepare('SELECT outcome,end_reason FROM voice_sessions WHERE id=?').get(fourth.id)).toEqual({outcome:'failed',end_reason:'phone_not_placed'});
    expect(db.prepare("SELECT status FROM bot_phone_calls WHERE id='p4'").get()).toEqual({status:'not_placed'});
  });
  it('greets a person by first name but never by an account label', async () => {
    const { callerFirstName } = await import('../src/voice/service.js');
    expect(callerFirstName('Nicholas Schneider')).toBe('Nicholas'); expect(callerFirstName('Ali')).toBe('Ali');
    expect(callerFirstName('accounting')).toBeNull(); expect(callerFirstName('')).toBeNull(); expect(callerFirstName(null)).toBeNull();
  });
  it('hands the saved transcript to the bot once after every bot call, marking relayed items', async () => {
    db.prepare("INSERT INTO conversations(id,assistant_id,user_id,title,provider,native_session_id) VALUES('sage',1,1,'Sage','codex','sage')").run();
    db.prepare("INSERT INTO bot_registrations(conversation_id,name,registered_by) VALUES('sage','Sage',1)").run();
    const call = await service.start(1,{botConversationId:'sage'});
    child.emit('message',{type:'transcript',role:'user',text:'Order 100121413, 83 by 5 by 3, 8 pounds, spot one.'});
    child.emit('message',{type:'transcript',role:'assistant',text:'Got it, I will queue it.'});
    child.emit('message',{type:'tool',id:'relay',name:'send_message',args:{instructionId:'relay-1',text:'Order 100121489, 48 by 5 by 3, 3.1 pounds, spot two.'}});
    await vi.advanceTimersByTimeAsync(1);
    child.emit('message',{type:'transcript',role:'user',text:'Order 100121489, 48 by 5 by 3, 3.1 pounds, spot two.'});
    expect(manager.steerMessage).toHaveBeenCalledTimes(1);
    service.end(1,call.id);
    await vi.advanceTimersByTimeAsync(1);
    expect(manager.steerMessage).toHaveBeenCalledTimes(2);
    const [id,text,actor] = manager.steerMessage.mock.calls[1]!;
    expect(id).toBe('sage'); expect(actor).toBe(1);
    expect(text).toContain('[Voice call transcript]');
    expect(text).toContain('(ended)');
    expect(text).toContain('Caller: Order 100121413, 83 by 5 by 3, 8 pounds, spot one.');
    expect(text).toContain('Voice line: Got it, I will queue it.');
    expect(text).toContain('[Already relayed or recorded during the call] Instruction delivered to Sage: Order 100121489');
    expect(text).toContain('1 item(s) were relayed during the call');
    // Idempotent: a second handoff for the same session is refused.
    const again = await new VoiceWorkspace({db,manager} as unknown as AppContext, 1, 'sage').transcriptHandoff(call.id,'ended');
    expect(again).toMatchObject({ok:false,skipped:'already_posted'});
    expect(manager.steerMessage).toHaveBeenCalledTimes(2);
    expect(db.prepare("SELECT count(*) AS n FROM voice_dispatches WHERE conversation_id='sage' AND instruction_id LIKE 'transcript-%'").get()).toEqual({n:1});
  });
  it('hands off after an interrupted call but not for coordinator calls or calls without caller turns', async () => {
    db.prepare("INSERT INTO conversations(id,assistant_id,user_id,title,provider,native_session_id) VALUES('sage',1,1,'Sage','codex','sage')").run();
    const silent = await service.start(1,{botConversationId:'sage'});
    child.emit('message',{type:'transcript',role:'assistant',text:'Hello, what can I help you with?'});
    service.end(1,silent.id);
    await vi.advanceTimersByTimeAsync(1);
    expect(manager.steerMessage).not.toHaveBeenCalled();
    await service.start(1);
    child.emit('message',{type:'transcript',role:'user',text:'Henry, what is pending?'});
    service.end(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(manager.steerMessage).not.toHaveBeenCalled();
    const dropped = await service.start(1,{botConversationId:'sage'});
    child.emit('message',{type:'transcript',role:'user',text:'Order 100121340, 82 by 5 by 3, 5.5 pounds, spot three.'});
    await vi.advanceTimersByTimeAsync(95_000); // heartbeat lost: the phone dropped
    expect(db.prepare('SELECT outcome FROM voice_sessions WHERE id=?').get(dropped.id)).toEqual({outcome:'interrupted'});
    expect(manager.steerMessage).toHaveBeenCalledTimes(1);
    expect(manager.steerMessage.mock.calls[0]![1]).toContain('(interrupted)');
    expect(manager.steerMessage.mock.calls[0]![1]).toContain('Caller: Order 100121340');
  });
  it('survives transient conversation check failures and only interrupts after sustained failure', async () => {
    db.prepare("INSERT INTO conversations(id,assistant_id,user_id,title,provider,native_session_id) VALUES('sage',1,1,'Sage','codex','sage')").run();
    const warn = vi.spyOn(console,'warn').mockImplementation(() => {});
    const call = await service.start(1,{botConversationId:'sage'});
    child.emit('message',{type:'ready'});
    manager.snapshot.mockRejectedValue(new Error('runner ipc timeout'));
    for (let i=0;i<5;i++) { await vi.advanceTimersByTimeAsync(1000); service.heartbeat(1,call.id); }
    expect(service.status(1)).toMatchObject({id:call.id,state:'listening'});
    manager.snapshot.mockResolvedValue([]);
    await vi.advanceTimersByTimeAsync(2000);
    manager.snapshot.mockRejectedValue(new Error('runner ipc timeout'));
    for (let i=0;i<12;i++) { await vi.advanceTimersByTimeAsync(1000); service.heartbeat(1,call.id); }
    expect(service.status(1)).toBeNull();
    expect(db.prepare('SELECT outcome FROM voice_sessions WHERE id=?').get(call.id)).toEqual({outcome:'interrupted'});
    expect(warn.mock.calls.some(c => String(c[0]).includes('interrupted after'))).toBe(true);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('runner ipc timeout');
    warn.mockRestore();
  });
  it('saves style for the authenticated caller and reloads it across calls without dispatching bot work', async () => {
    await service.start(1);
    const request = async (id: string, args: unknown) => {
      child.emit('message', { type: 'tool', id, name: 'voice_preferences', args });
      await vi.advanceTimersByTimeAsync(1);
      return child.send.mock.calls.map(a => a[0]).find(m => m.id === id)?.result;
    };
    expect(await request('save', { action: 'update', preferences: { length: 'concise', greeting: 'brief' } })).toMatchObject({ ok: true, preferences: { length: 'concise', greeting: 'brief' } });
    expect(await request('foreign', { action: 'update', userId: 2, preferences: { length: 'detailed' } })).toHaveProperty('error');
    service.end(1);
    for (const thread of ['first-style-thread','second-style-thread']) {
      db.prepare("INSERT INTO conversations(id,assistant_id,user_id,title,provider,native_session_id) VALUES(?,1,1,'Voice style','codex',?)").run(thread,thread);
      manager.snapshot.mockResolvedValue([{type:'text_final',markdown:'Already completed export. Reference 719362.'}]);
      await service.start(1,{botConversationId:thread});
      const startup = child.send.mock.calls.map(a => a[0]).filter(m => m.type === 'start').at(-1);
      expect(startup.preferences).toEqual({ length:'concise', greeting:'brief' });
      expect(startup.instructions).toContain('Already completed export. Reference 719362.');
      expect(startup.instructions).not.toContain('Use them immediately for greetings');
      service.end(1);
    }
    await service.start(1); // Coordinator uses the same persisted personal style.
    expect(child.send.mock.calls.map(a => a[0]).filter(m => m.type === 'start').at(-1).preferences).toEqual({length:'concise',greeting:'brief'});
    expect(await request('reset-style', { action: 'reset' })).toMatchObject({ ok: true, preferences: {} });
    expect(manager.steerMessage).not.toHaveBeenCalled();
  });

  it('persists real connected duration, bounds restart interruption, and ignores foreign end attempts', async () => {
    const call=await service.start(1);
    expect(service.connected(2,call.id)).toBe(false);
    await vi.advanceTimersByTimeAsync(3000);
    expect(service.connected(1,call.id)).toBe(true);
    const connected=Date.now();
    await vi.advanceTimersByTimeAsync(12000);
    service.heartbeat(1,call.id);
    service.end(2,call.id);
    expect(db.prepare('SELECT ended_ms FROM voice_sessions WHERE id=?').get(call.id)).toEqual({ended_ms:null});
    service.end(1,call.id);service.end(1,call.id);
    expect(db.prepare('SELECT connected_ms,ended_ms,outcome FROM voice_sessions WHERE id=?').get(call.id)).toEqual({connected_ms:connected,ended_ms:connected+12000,outcome:'ended'});
    db.prepare("INSERT INTO voice_sessions(id,user_id,started_ms,connected_ms,last_seen_ms) VALUES('interrupted',1,1,2,5002)").run();
    service.close();
    service=new LiveVoiceService({db,manager,doppler:{get:()=>null}} as unknown as AppContext);
    expect(db.prepare("SELECT ended_ms,outcome FROM voice_sessions WHERE id='interrupted'").get()).toEqual({ended_ms:5002,outcome:'interrupted'});
  });
  it('bounds large bot context and preserves an older selected decision in startup and notices', async () => {
    db.prepare("INSERT INTO conversations(id,assistant_id,user_id,title,provider,native_session_id) VALUES('large',1,1,'Large bot','codex','large')").run();
    db.prepare("INSERT INTO bot_registrations(conversation_id,name,registered_by) VALUES('large','Grant',1)").run();
    for (let i=0;i<45;i++) {
      db.prepare("INSERT INTO bot_decisions(id,conversation_id,source_key,proposal_key,proposal_json,assignee_id,created_at,updated_at) VALUES(?,'large',?,?,?,1,?,?)")
        .run('d'+i,'s'+i,'p'+i,JSON.stringify({question:i===0?'Selected reference 719362':'Question '.repeat(1000),
          recommendation:'Recommendation '.repeat(1000),consequence:'Consequence '.repeat(1000),
          blocked_action:'Constraint '.repeat(1000)+'FINAL CONSTRAINT',blocks_scope:'task',deadline:null,evidence:[]}),
          new Date(1700000000000+i*1000).toISOString(),new Date(1700000000000+i*1000).toISOString());
    }
    await service.start(1,{botConversationId:'large',decisionId:'d0'});
    const start = child.send.mock.calls.map(a=>a[0]).find(m=>m.type==='start');
    expect(start.instructions.length).toBeLessThan(18000);
    const data = JSON.parse(start.instructions.slice(start.instructions.indexOf('{"history":')));
    expect(data.focusedDecision).toMatchObject({decisionId:'d0',version:1,canAnswer:true,question:'Selected reference 719362',coverage:{nextOffset:1500}});
    expect(data.decisions).toHaveLength(10);
    expect(data.decisionCoverage).toEqual({total:45,nextOffset:10});
    child.emit('message',{type:'ready'});
    child.emit('message',{type:'tool',id:'page',name:'decisions',args:{offset:40}});
    child.emit('message',{type:'tool',id:'detail',name:'read_decision',args:{decisionId:'d0',offset:10000}});
    await vi.advanceTimersByTimeAsync(1);
    expect(child.send).toHaveBeenCalledWith(expect.objectContaining({id:'page',result:expect.objectContaining({total:45,nextOffset:null})}));
    expect(child.send).toHaveBeenCalledWith(expect.objectContaining({id:'detail',result:expect.objectContaining({blockedAction:expect.stringContaining('FINAL CONSTRAINT')})}));
    manager.snapshot.mockResolvedValue([{type:'text_final',markdown:'Actual completed work'}]);
    await vi.advanceTimersByTimeAsync(5000);
    const notice = child.send.mock.calls.map(a=>a[0]).find(m=>m.type==='notice');
    expect(JSON.stringify(notice).length).toBeLessThan(18000);
    expect(notice.context.focusedDecision.decisionId).toBe('d0');
    expect(manager.steerMessage).not.toHaveBeenCalled();
  });
  it('reports only approved error categories, never worker diagnostics', async () => {
    await service.start(1);
    child.emit('message',{type:'failure',code:'context_limit',message:'private-provider-body'});
    expect(service.status(1)?.error).toContain('context');
    child.emit('message',{type:'failure',code:'private-provider-body'});
    expect(JSON.stringify(service.status(1))).not.toContain('private-provider-body');
    expect(service.status(1)?.error).not.toContain('credentials');
  });

  it('fails closed on missing credentials or unsafe room endpoints', async () => {
    delete secrets.OPENAI_API_KEY;
    expect(service.configuration()).toEqual({ready:false,missing:['OPENAI_API_KEY'],invalidUrl:false});
    await expect(service.start(1)).rejects.toThrow('incomplete');
    expect(fakes.createRoom).not.toHaveBeenCalled();
    secrets.OPENAI_API_KEY='test';
    for (const url of ['http://localhost:3100','wss://example.com','wss://fake.livekit.cloud@evil.example','wss://fake.livekit.cloud/?secret=x']) {
      secrets.LIVEKIT_URL=url; expect(service.configuration().ready).toBe(false);
    }
  });
  it('scopes calls to one user, refuses overlap and keeps credentials out of status', async () => {
    const call = await service.start(1);
    expect(call.url).toBe(secrets.LIVEKIT_URL);
    expect(service.status(2)).toBeNull();
    expect(service.heartbeat(2,call.id)).toBeNull();
    await expect(service.start(1)).rejects.toThrow('already active');
    expect(JSON.stringify(service.status(1))).not.toContain('test-secret');
    service.end(1,'wrong-id'); expect(child.kill).not.toHaveBeenCalled();
    service.end(1,call.id); expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(fakes.deleteRoom).toHaveBeenCalled(); expect(service.status(1)).toBeNull();
  });
  it('loads existing work before starting audio, even without blockers or decisions', async () => {
    db.prepare("INSERT INTO conversations(id,assistant_id,user_id,title,provider,native_session_id) VALUES('thread',1,1,'Live voice work','codex','s1')").run();
    db.prepare("INSERT INTO voice_entries(user_id,session_id,role,text,bot_conversation_id) VALUES(1,'old','assistant','We have a clean slate.','thread')").run();
    let resolveSnapshot!: (value: unknown[]) => void;
    manager.snapshot.mockReturnValue(new Promise(resolve => { resolveSnapshot = resolve; }));
    const starting = service.start(1,{botConversationId:'thread'});
    await vi.advanceTimersByTimeAsync(1);
    expect(fakes.createRoom).not.toHaveBeenCalled();
    resolveSnapshot([{type:'text_final',turnId:'old-work',markdown:'Deployed floating voice panels. Reference 913824.'}]);
    await starting;
    const start = child.send.mock.calls.map(args => args[0]).find(m => m.type === 'start');
    const context = JSON.parse(start.instructions.slice(start.instructions.indexOf('{"history":')));
    expect(context).toMatchObject({blockers:[],decisions:[],currentConversation:{conversationId:'thread',status:'idle',messages:[{role:'assistant',text:'Deployed floating voice panels. Reference 913824.'}]}});
    expect(start.instructions).toContain('current thread evidence takes precedence');
    expect(manager.steerMessage).not.toHaveBeenCalled();
  });
  it('does not open a contextless call when the thread cannot be loaded', async () => {
    db.prepare("INSERT INTO conversations(id,assistant_id,user_id,title,provider,native_session_id) VALUES('thread',1,1,'Support','codex','s1')").run();
    manager.snapshot.mockRejectedValue(new Error('Runner unavailable'));
    await expect(service.start(1,{botConversationId:'thread'})).rejects.toThrow('Could not load the conversation context');
    expect(fakes.createRoom).not.toHaveBeenCalled();
    expect(fakes.fork).not.toHaveBeenCalled();
  });
  it('keeps a normal thread call alive through task dispatch and reports real replies', async () => {
    db.prepare("INSERT INTO conversations(id,assistant_id,user_id,title,provider,native_session_id) VALUES('thread',1,1,'Support','codex','s1')").run();
    const call = await service.start(1,{botConversationId:'thread'});
    expect(child.send).toHaveBeenCalledWith(expect.objectContaining({type:'start',mode:'bot',agentName:'Assistant'}));
    child.emit('message',{type:'ready'});
    child.emit('message',{type:'tool',id:'ipc-1',name:'send_message',args:{text:'Review order',instructionId:'task-1'}});
    await vi.advanceTimersByTimeAsync(1);
    expect(manager.steerMessage).toHaveBeenCalledWith('thread','[Voice call] Review order',1);
    expect(service.status(1)?.id).toBe(call.id);
    expect(child.send).toHaveBeenCalledWith(expect.objectContaining({type:'result',id:'ipc-1',result:expect.objectContaining({disposition:'running'})}));
    child.emit('message',{type:'tool',id:'ipc-2',name:'send_message',args:{text:'Review order',instructionId:'task-1'}});
    await vi.advanceTimersByTimeAsync(1);
    expect(manager.steerMessage).toHaveBeenCalledTimes(1);
    manager.snapshot.mockResolvedValue([{type:'text_final',turnId:'t1',markdown:'Verified order result'}]);
    await vi.advanceTimersByTimeAsync(1000);
    const first = child.send.mock.calls.map(a=>a[0]).find(m=>m.type==='notice');
    expect(first).toMatchObject({type:'notice',kind:'update',noticeId:expect.any(String),context:expect.objectContaining({currentConversation:expect.objectContaining({messages:[{role:'assistant',text:'Verified order result'}]}),newReplies:[{index:0,text:'Verified order result'}]})});
    // The cursor waits for the worker's acknowledgment: until then the same cursor is re-sent, no sooner than the ack wait.
    child.send.mockClear();
    await vi.advanceTimersByTimeAsync(2000);
    expect(child.send.mock.calls.map(a=>a[0]).filter(m=>m.type==='notice')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2000);
    const resent = child.send.mock.calls.map(a=>a[0]).find(m=>m.type==='notice');
    expect(resent.context.newReplies).toEqual([{index:0,text:'Verified order result'}]);
    expect(resent.noticeId).not.toBe(first.noticeId);
    // A failed insert is re-sent at once on the next tick.
    child.send.mockClear();
    child.emit('message',{type:'notice_ack',noticeId:resent.noticeId,applied:false});
    await vi.advanceTimersByTimeAsync(1000);
    const retried = child.send.mock.calls.map(a=>a[0]).find(m=>m.type==='notice');
    expect(retried.context.newReplies).toEqual([{index:0,text:'Verified order result'}]);
    child.emit('message',{type:'notice_ack',noticeId:retried.noticeId,applied:true});
    child.send.mockClear();
    await vi.advanceTimersByTimeAsync(4000);
    expect(child.send.mock.calls.map(a=>a[0]).filter(m=>m.type==='notice')).toHaveLength(0);
    // A second reply is handed over on its own, so the call hears only what is new.
    manager.snapshot.mockResolvedValue([{type:'text_final',turnId:'t1',markdown:'Verified order result'},{type:'text_final',turnId:'t2',markdown:'Best match: SKU 2021124055'}]);
    await vi.advanceTimersByTimeAsync(1000);
    const second = child.send.mock.calls.map(a=>a[0]).find(m=>m.type==='notice');
    expect(second.context.newReplies).toEqual([{index:1,text:'Best match: SKU 2021124055'}]);
    child.emit('message',{type:'notice_ack',noticeId:second.noticeId,applied:true});
    // A status change without a new reply carries no replies to remember.
    child.send.mockClear();
    manager.statusOf.mockResolvedValue('working');
    await vi.advanceTimersByTimeAsync(1000);
    expect(child.send.mock.calls.map(a=>a[0]).find(m=>m.type==='notice')?.context.newReplies).toEqual([]);
    expect(service.status(1)?.id).toBe(call.id);
    db.prepare("UPDATE users SET status='disabled' WHERE id=1").run();
    await vi.advanceTimersByTimeAsync(5000);
    expect(service.status(1)).toBeNull();
  });
  it('polls context in every voice state and takes one snapshot per tick', async () => {
    db.prepare("INSERT INTO conversations(id,assistant_id,user_id,title,provider,native_session_id) VALUES('thread',1,1,'Support','codex','s1')").run();
    await service.start(1,{botConversationId:'thread'});
    child.emit('message',{type:'ready'});
    child.emit('message',{type:'state',state:'speaking'});
    manager.snapshot.mockClear();
    await vi.advanceTimersByTimeAsync(1000);
    expect(manager.snapshot).toHaveBeenCalledTimes(1); // quiet tick
    // Blank sanitized replies are skipped by count and delta alike, so indexes stay aligned.
    manager.snapshot.mockResolvedValue([{type:'text_final',turnId:'t0',markdown:'   '},{type:'text_final',turnId:'t1',markdown:'Found it: SKU 2021124055'}]);
    manager.snapshot.mockClear();
    await vi.advanceTimersByTimeAsync(1000);
    expect(manager.snapshot).toHaveBeenCalledTimes(1); // changed tick: count, delta and page from the same read
    const notice = child.send.mock.calls.map(a=>a[0]).find(m=>m.type==='notice');
    expect(notice.context.newReplies).toEqual([{index:0,text:'Found it: SKU 2021124055'}]);
    expect(notice.context.currentConversation.messages).toEqual([{role:'assistant',text:'Found it: SKU 2021124055'}]);
    child.emit('message',{type:'notice_ack',noticeId:notice.noticeId,applied:true});
    // After bounded history attempts, fallback still needs a retention ack.
    child.send.mockClear();
    manager.snapshot.mockResolvedValue([{type:'text_final',turnId:'t0',markdown:'   '},{type:'text_final',turnId:'t1',markdown:'Found it: SKU 2021124055'},{type:'text_final',turnId:'t2',markdown:'Bin BIN-018-260821'}]);
    await vi.advanceTimersByTimeAsync(1000 + 5 * 3000);
    const notices = child.send.mock.calls.map(a=>a[0]).filter(m=>m.type==='notice');
    expect(notices.length).toBeGreaterThanOrEqual(5);
    expect(notices.slice(0,-1).every(n=>!n.fallback && n.context.newReplies[0].index===1)).toBe(true);
    expect(notices.at(-1)).toMatchObject({fallback:true,context:expect.objectContaining({newReplies:[{index:1,text:'Bin BIN-018-260821'}]})});
    child.send.mockClear();
    await vi.advanceTimersByTimeAsync(4000);
    const fallbackRetry = child.send.mock.calls.map(a=>a[0]).find(m=>m.type==='notice');
    expect(fallbackRetry).toMatchObject({fallback:true,context:expect.objectContaining({newReplies:[{index:1,text:'Bin BIN-018-260821'}]})});
    child.emit('message',{type:'notice_ack',noticeId:fallbackRetry.noticeId,applied:false,retained:true});
    child.send.mockClear();
    await vi.advanceTimersByTimeAsync(4000);
    expect(child.send.mock.calls.map(a=>a[0]).filter(m=>m.type==='notice')).toHaveLength(0);
  });
  it('preserves the fallback cursor after an asynchronous IPC failure and ignores stale acknowledgments', async () => {
    db.prepare("INSERT INTO conversations(id,assistant_id,user_id,title,provider,native_session_id) VALUES('thread',1,1,'Support','codex','s1')").run();
    await service.start(1,{botConversationId:'thread'});
    child.emit('message',{type:'ready'});
    manager.snapshot.mockResolvedValue([{type:'text_final',turnId:'t1',markdown:'Four on hand'}]);
    child.send.mockClear();
    child.send.mockImplementation((message, callback) => {
      if (message.type==='notice' && message.fallback) callback(new Error('IPC closed'));
    });
    await vi.advanceTimersByTimeAsync(16000);
    const notices = child.send.mock.calls.map(a=>a[0]).filter(m=>m.type==='notice');
    const failed = notices.at(-1);
    expect(failed.fallback).toBe(true);
    child.send.mockImplementation(() => {});
    child.send.mockClear();
    await vi.advanceTimersByTimeAsync(1000);
    const retry = child.send.mock.calls.map(a=>a[0]).find(m=>m.type==='notice');
    expect(retry.context.newReplies).toEqual([{index:0,text:'Four on hand'}]);
    expect(retry.fallback).toBe(true);
    child.emit('message',{type:'notice_ack',noticeId:failed.noticeId,applied:false,retained:true});
    child.send.mockClear();
    await vi.advanceTimersByTimeAsync(3000);
    const next = child.send.mock.calls.map(a=>a[0]).find(m=>m.type==='notice');
    expect(next.context.newReplies).toEqual([{index:0,text:'Four on hand'}]);
    child.emit('message',{type:'notice_ack',noticeId:next.noticeId,applied:false,retained:true});
    child.send.mockClear();
    await vi.advanceTimersByTimeAsync(4000);
    expect(child.send.mock.calls.map(a=>a[0]).filter(m=>m.type==='notice')).toHaveLength(0);
  });
  it('sends no notice when access is revoked while the snapshot is pending', async () => {
    db.prepare("INSERT INTO conversations(id,assistant_id,user_id,title,provider,native_session_id) VALUES('thread',1,1,'Support','codex','s1')").run();
    await service.start(1,{botConversationId:'thread'});
    child.emit('message',{type:'ready'});
    child.send.mockClear();
    manager.snapshot.mockImplementation(async () => { db.prepare("UPDATE users SET status='disabled' WHERE id=1").run(); return [{type:'text_final',turnId:'t1',markdown:'Private result'}]; });
    await vi.advanceTimersByTimeAsync(1000);
    expect(child.send.mock.calls.map(a=>a[0]).filter(m=>m.type==='notice')).toHaveLength(0);
    expect(JSON.stringify(child.send.mock.calls)).not.toContain('Private result');
  });
  it('logs voice tool failures by name, with the reason only for read-only tools', async () => {
    db.prepare("INSERT INTO conversations(id,assistant_id,user_id,title,provider,native_session_id) VALUES('thread',1,1,'Support','codex','s1')").run();
    const call = await service.start(1,{botConversationId:'thread'});
    child.emit('message',{type:'ready'});
    const warn = vi.spyOn(console,'warn').mockImplementation(() => {});
    manager.snapshot.mockRejectedValue(new Error('Runner unavailable'));
    child.emit('message',{type:'tool',id:'rc',name:'read_chat',args:{}});
    await vi.advanceTimersByTimeAsync(1);
    expect(child.send.mock.calls.map(a=>a[0]).find(m=>m.id==='rc').result.error).toBe('Runner unavailable');
    expect(warn).toHaveBeenCalledWith(`[voice] tool read_chat failed for call ${call.id}: Runner unavailable`);
    manager.steerMessage.mockRejectedValue(new Error('Rejected: SECRET CALLER WORDS'));
    child.emit('message',{type:'tool',id:'sm',name:'send_message',args:{text:'SECRET CALLER WORDS',instructionId:'i1'}});
    await vi.advanceTimersByTimeAsync(1);
    expect(warn).toHaveBeenCalledWith(`[voice] tool send_message failed for call ${call.id}: error`);
    expect(warn.mock.calls.flat().join('\n')).not.toContain('SECRET CALLER WORDS');
    warn.mockRestore();
  });
  it('notifies a call about a decision discussion reply even when chat and run status do not change', async () => {
    db.prepare("INSERT INTO conversations(id,assistant_id,user_id,title,provider,native_session_id) VALUES('thread',1,1,'Grant','codex','s1')").run();
    db.prepare("INSERT INTO bot_registrations(conversation_id,name,registered_by) VALUES('thread','Grant',1)").run();
    db.prepare("INSERT INTO bot_decisions(id,conversation_id,source_key,proposal_key,proposal_json,assignee_id) VALUES('d','thread','s','p',?,1)").run(JSON.stringify({ question: 'Check order?', recommendation: 'Check facts', consequence: 'No action', blocked_action: 'Read only', blocks_scope: 'task', deadline: null, evidence: [] }));
    await service.start(1, { botConversationId: 'thread', decisionId: 'd' });
    child.emit('message', { type: 'ready' });
    await vi.advanceTimersByTimeAsync(1000);
    child.send.mockClear();
    db.prepare("INSERT INTO bot_decision_events(id,decision_id,version,kind,actor_id,actor_conversation_id,payload_json,request_key) VALUES('reply','d',1,'message',1,'thread','{}','reply')").run();
    db.prepare("INSERT INTO bot_decision_threads(id,decision_id,actor_id,actor_conversation_id,text) VALUES('reply','d',1,'thread','Verified: package weight is unavailable.')").run();
    await vi.advanceTimersByTimeAsync(1000);
    expect(child.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'notice', context: expect.objectContaining({ focusedDecision: expect.objectContaining({ discussion: [expect.objectContaining({ text: 'Verified: package weight is unavailable.' })] }) }) }), expect.any(Function));
  });
  it('reaps an abandoned phone connection even if its worker stays alive', async () => {
    await service.start(1); child.emit('message',{type:'ready'});
    vi.advanceTimersByTime(111_000);
    expect(service.status(1)).toBeNull(); expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });
  it('times out a stuck startup and reports worker failures without raw diagnostics', async () => {
    await service.start(1); vi.advanceTimersByTime(60_000);
    expect(service.status(1)).toBeNull();
    await service.start(1); child.emit('error',new Error('raw-secret-diagnostic'));
    expect(service.status(1)?.state).toBe('failed');
    expect(JSON.stringify(service.status(1))).not.toContain('raw-secret-diagnostic');
  });
  it('cleans up remote rooms when worker startup fails and permits retry', async () => {
    fakes.fork.mockImplementationOnce(() => { throw new Error('cannot fork'); });
    await expect(service.start(1)).rejects.toThrow('Could not start');
    expect(fakes.deleteRoom).toHaveBeenCalled();
    await expect(service.start(1)).resolves.toHaveProperty('id');
  });
});

it('routes the hotline through selected owners and keeps its transcript out of unrelated bots',async()=>{
  for(const id of ['atlas','robin']) {
    db.prepare("INSERT INTO conversations(id,assistant_id,user_id,title,provider,native_session_id) VALUES(?,1,1,?,'codex',?)").run(id,id,id);
    db.prepare('INSERT INTO bot_registrations(conversation_id,name,registered_by) VALUES(?,?,1)').run(id,id);
    const proposal={question:'Use draft?',recommendation:'Use draft.',consequence:'Fixture only.',assignee_id:1,team:'',deadline:null,evidence:[],blocks_scope:'task',blocked_action:'Internal fixture',choices:[{id:'use',label:'Use draft',action:'approve',answer:'use'},{id:'hold',label:'Hold',action:'defer'}]};
    db.prepare('INSERT INTO bot_decisions(id,conversation_id,source_key,proposal_key,proposal_json,assignee_id) VALUES(?,?,?,?,?,1)').run(id,id,id,id,JSON.stringify(proposal));
  }
  const call=await service.start(1,{hotline:true});
  const start=child.send.mock.calls.find(c=>c[0].type==='start')![0];expect(start.mode).toBe('hotline');expect(start.instructions).toContain('not any of the individual bots');
  const tool=async(id:string,name:string,args:Record<string,unknown>)=>{child.emit('message',{type:'tool',id,name,args});await vi.advanceTimersByTimeAsync(1);return child.send.mock.calls.find(c=>c[0].type==='result'&&c[0].id===id)![0].result;};
  expect(await tool('wrong','answer_choice',{decisionId:'robin',version:1,choiceId:'use',text:'Use draft'})).toMatchObject({error:expect.stringContaining('Select')});
  child.emit('message',{type:'caller_turn',turn:1});child.emit('message',{type:'caller_final',turn:1,text:'Use draft'});
  expect(await tool('right','answer_choice',{decisionId:'atlas',version:1,choiceId:'use',text:'Use draft',callerQuote:'Use draft'})).toMatchObject({ok:true});
  expect(await tool('read-receipt','read_decision',{decisionId:'atlas'})).toMatchObject({state:'decided'});
  expect(await tool('next','navigate_question',{action:'next'})).toMatchObject({decisionId:'robin'});
  expect(await tool('recycled','answer_choice',{decisionId:'robin',version:1,choiceId:'use',text:'Use draft',callerQuote:'Use draft'})).toMatchObject({error:expect.stringContaining('fresh')});
  expect(await tool('show','navigate_question',{action:'show'})).toMatchObject({decisionId:'robin'});
  expect(db.prepare('SELECT show_evidence FROM question_line_state WHERE user_id=1').get()).toEqual({show_evidence:1});
  expect(await tool('blocked','send_message',{text:'Do unrelated work',instructionId:'unrelated'})).toMatchObject({error:expect.any(String)});
  child.emit('message',{type:'transcript',role:'user',text:'Unconfirmed discussion from multiple bots.'});
  service.end(1,call.id);await vi.advanceTimersByTimeAsync(1);
  expect(manager.steerMessage).not.toHaveBeenCalled();
  expect(db.prepare("SELECT state FROM bot_decisions WHERE id='robin'").get()).toEqual({state:'needs_input'});
});
