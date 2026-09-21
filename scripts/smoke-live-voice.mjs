// Opt-in, metered media check. Run: NODE_ENV=production node --import tsx scripts/smoke-live-voice.mjs --live
// Uses the configured vault, an in-memory database, and a deterministic provider
// fixture behind the real conversation manager. Never touches customer tickets.
import { randomInt } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { initializeLogger } from '@livekit/agents';
import { Room, RoomEvent, AudioStream, AudioSource, AudioFrame, LocalAudioTrack, TrackPublishOptions, TrackSource } from '@livekit/rtc-node';
import { migrate } from '../server/src/db/migrate.ts';
import { createDopplerTokenStore, DopplerRuntime } from '../server/src/secrets/doppler.ts';
import { loadEnvFile } from '../server/src/envFile.ts';
import { loadConfig } from '../server/src/config.ts';
import { createConversationManager } from '../server/src/runtime/conversationManager.ts';
import { LiveVoiceService } from '../server/src/voice/service.ts';
if (!process.argv.includes('--live')) throw new Error('Pass --live to authorize a metered LiveKit/OpenAI smoke call.');
initializeLogger({ pretty: false, level: 'silent' });
loadEnvFile();
const doppler = new DopplerRuntime(createDopplerTokenStore(loadConfig().dataDir));
const db = new Database(':memory:');
migrate(db, path.resolve('server/src/db/migrations'));
db.prepare("INSERT INTO users(id,email,display_name,role) VALUES(1,'voice-smoke@example.invalid','Voice smoke','member')").run();
db.prepare("INSERT INTO conversations(id,assistant_id,user_id,title,provider,native_session_id) VALUES('voice-smoke',1,1,'Voice verification fixture','codex','voice-smoke')").run();
const conversation = db.prepare("SELECT * FROM conversations WHERE id='voice-smoke'").get();
const recap = process.argv.includes('--recap');
const events = [];
const reference = String(randomInt(100000, 999999));
if (recap) events.push({type:'text_final',turnId:'prior-work',markdown:`Completed the onboarding checklist export. Delivery reference ${reference}. The export is saved and ready for staff.`,at:new Date().toISOString()});
let dispatches = 0;
const manager = createConversationManager({ db, adapters: { codex: {
  id: 'codex', mintSessionId: () => 'voice-smoke', readTranscript: async () => events,
  runTurn(spec, onEvent) {
    dispatches++;
    let finish;
    const done = new Promise(resolve => { finish = resolve; });
    const timer = setTimeout(() => {
      const event = { type: 'text_final', turnId: spec.turnId, markdown: `Verification complete. Reference number ${reference}. This is a verification fixture; no customer ticket was changed.`, at: new Date().toISOString() };
      events.push(event); onEvent(event); finish();
    }, 8000);
    return { done, kill: () => { clearTimeout(timer); finish(); }, respondToApproval: () => false };
  },
} }, resolveWorkspace: () => ({ workspaceDir: tmpdir(), assistantSlug: 'assistant', elevated: false }), log: { warn() {}, error() {} } });
const ctx = { db, doppler, manager: {
  snapshot: async () => manager.snapshot(conversation), statusOf: async () => manager.statusOf(conversation.id),
  steerMessage: async (id, text, actor) => ({ ok: true, ...await manager.steerMessage(conversation, text, undefined, actor) }),
} };
const service = new LiveVoiceService(ctx);
const room = new Room();
const source = new AudioSource(24000, 1);
const directory = mkdtempSync(path.join(tmpdir(), 'veneer-voice-smoke-'));
let samples = 0;
let heartbeat;
let silence;
let success = false;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
room.on(RoomEvent.TrackSubscribed, track => {
  void (async () => { for await (const frame of new AudioStream(track)) samples += frame.samplesPerChannel; })().catch(() => {});
});
try {
  const wav = path.join(directory, 'instruction.wav');
  execFileSync('/usr/bin/say', ['-o', wav, '--file-format=WAVE', '--data-format=LEI16@24000', recap ? 'Give me the TLDR on what you already completed in this thread, including the delivery reference number. Do not start any new work.' : 'Please ask the agent to run the verification and tell me the reference number it returns. Send that instruction now.'], { stdio: 'ignore' });
  const buffer = readFileSync(wav);
  let pcm;
  for (let offset = 12; offset + 8 <= buffer.length;) {
    const size = buffer.readUInt32LE(offset + 4);
    if (buffer.toString('ascii', offset, offset + 4) === 'data') { pcm = buffer.subarray(offset + 8, offset + 8 + size); break; }
    offset += 8 + size + (size % 2);
  }
  if (!pcm) throw new Error('Audio fixture unavailable');
  const call = await service.start(1, { botConversationId: conversation.id });
  heartbeat = setInterval(() => service.heartbeat(1, call.id), 10000);
  await room.connect(call.url, call.token);
  const track = LocalAudioTrack.createAudioTrack('smoke-microphone', source);
  const options = new TrackPublishOptions(); options.source = TrackSource.SOURCE_MICROPHONE;
  await room.localParticipant.publishTrack(track, options);
  const deadline = Date.now() + 75000;
  while (samples === 0 && Date.now() < deadline && service.status(1)?.state !== 'failed') await delay(500);
  if (!samples) throw new Error('No remote audio');
  // Real PCM speech travels through LiveKit to OpenAI, not a text-channel shortcut.
  for (let offset = 0; offset < pcm.length; offset += 960) {
    const data = new Int16Array(480);
    for (let i = 0; i < 480 && offset + i * 2 + 1 < pcm.length; i++) data[i] = pcm.readInt16LE(offset + i * 2);
    await source.captureFrame(new AudioFrame(data, 24000, 1, 480));
  }
  await source.waitForPlayout();
  silence = setInterval(() => { void source.captureFrame(AudioFrame.create(24000, 1, 480)).catch(() => {}); }, 20);
  let workingDuringCall = false;
  while (Date.now() < deadline) {
    workingDuringCall ||= dispatches > 0 && manager.statusOf(conversation.id) === 'working' && service.status(1)?.state !== 'failed';
    const rows = db.prepare('SELECT role,text FROM voice_entries').all();
    const lastUser = rows.findLastIndex(row => row.role === 'user');
    const relayedResult = lastUser >= 0 && rows.slice(lastUser + 1).some(row => row.role === 'assistant' && row.text.includes(reference));
    if ((recap ? dispatches === 0 : workingDuringCall && events.length) && relayedResult && rows.some(row => row.role === 'user')) { success = true; break; }
    if (service.status(1)?.state === 'failed') break;
    await delay(500);
  }
  console.log(JSON.stringify({ passed: success, mode: recap ? 'startup-recap' : 'dispatch', receivedAudio: samples > 0, transcribedSpeech: db.prepare("SELECT count(*) AS n FROM voice_entries WHERE role='user'").get().n > 0, dispatches, workingDuringCall, fixtureCompleted: events.length > 0 }));
} catch {
  console.log(JSON.stringify({ passed: false, error: 'Live media smoke failed. Check service configuration, credit, connectivity, and worker status. No credentials or provider diagnostics are printed.' }));
} finally {
  clearInterval(silence); clearInterval(heartbeat); service.close();
  await source.close(); await room.disconnect();
  rmSync(directory, { recursive: true, force: true });
  // Leave time for isolated child shutdown before closing the fixture database.
  await delay(1000); db.close();
}
process.exit(success ? 0 : 1);
