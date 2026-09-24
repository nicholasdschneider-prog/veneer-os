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
}));
import { LiveVoiceService } from '../src/voice/service.js';
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
    await vi.advanceTimersByTimeAsync(5000);
    expect(child.send).toHaveBeenCalledWith(expect.objectContaining({type:'notice',kind:'update',context:expect.objectContaining({currentConversation:expect.objectContaining({messages:[{role:'assistant',text:'Verified order result'}]})})}));
    expect(service.status(1)?.id).toBe(call.id);
    db.prepare("UPDATE users SET status='disabled' WHERE id=1").run();
    await vi.advanceTimersByTimeAsync(5000);
    expect(service.status(1)).toBeNull();
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
    expect(child.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'notice', context: expect.objectContaining({ focusedDecision: expect.objectContaining({ discussion: [expect.objectContaining({ text: 'Verified: package weight is unavailable.' })] }) }) }));
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
