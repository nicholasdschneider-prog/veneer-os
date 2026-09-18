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
let child: EventEmitter & { send: ReturnType<typeof vi.fn>; kill: ReturnType<typeof vi.fn>; connected: boolean; exitCode: number | null };
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks();
  db = new Database(':memory:'); migrate(db,path.join(path.dirname(fileURLToPath(import.meta.url)),'../src/db/migrations'));
  db.prepare("INSERT INTO users(id,email,display_name,role) VALUES(1,'test@example.com','Test','owner')").run();
  secrets = { LIVEKIT_URL:'wss://voice-test.livekit.cloud', LIVEKIT_API_KEY:'test-key', LIVEKIT_API_SECRET:'test-secret', OPENAI_API_KEY:'test-openai' };
  child = Object.assign(new EventEmitter(), { send:vi.fn(),kill:vi.fn(),connected:true,exitCode:null });
  fakes.fork.mockReturnValue(child); fakes.createRoom.mockResolvedValue({}); fakes.deleteRoom.mockResolvedValue({});
  service = new LiveVoiceService({db,doppler:{get:(name:string)=>secrets[name]??null,refresh:async()=>({})}} as unknown as AppContext);
});
afterEach(() => { service.close(); db.close(); vi.useRealTimers(); });
describe('live voice lifecycle', () => {
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
