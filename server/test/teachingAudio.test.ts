import Database from 'better-sqlite3';
import express from 'express';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { createSkillStore } from '../src/skills/store.js';
vi.mock('../src/skills/store.js', () => ({ createSkillStore: vi.fn(() => ({ create: vi.fn(() => ({ skill: { name: 'fixture' } })) })) }));
import { migrate } from '../src/db/migrate.js';
import { teachingAudioRouter } from '../src/botWorkflows/teachingAudio.js';
import { startTeaching, finishTeaching, saveTeaching, recordTeachingStep } from '../src/botWorkflows/teaching.js';
import type { AppContext } from '../src/context.js';
import type { UserRow } from '../src/db/db.js';
let db: Database.Database, ctx: AppContext, user: UserRow, id: string, server: Server, url: string;
const transcribe = vi.fn(async () => 'I choose this filter because only cleared payments belong in this report.');
const audio = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3]);
const key = '00000000-0000-4000-8000-000000000001';
beforeEach(async () => {
    db = new Database(':memory:');
    db.pragma('foreign_keys=ON');
    migrate(db, fileURLToPath(new URL('../src/db/migrations', import.meta.url)));
    db.prepare("INSERT INTO users(id,email,display_name,role) VALUES(1,'teacher@example.test','Teacher','owner'),(2,'other@example.test','Other','owner')").run();
    db.prepare("INSERT INTO projects(id,slug,name) VALUES('project','project','Fixture')").run();
    db.prepare("INSERT INTO conversations(id,assistant_id,user_id,title,provider,native_session_id,project_id) VALUES('clara',1,1,'Clara','claude','native','project')").run();
    db.prepare("INSERT INTO bot_registrations(conversation_id,name,registered_by) VALUES('clara','Clara',1)").run();
    user = db.prepare('SELECT * FROM users WHERE id=1').get() as UserRow;
    ctx = { db } as AppContext;
    id = startTeaching(ctx, user, 'clara', 'Accounting report', 'Explain filter decisions').id;
    transcribe.mockReset().mockResolvedValue('I choose this filter because only cleared payments belong in this report.');
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.user = db.prepare('SELECT * FROM users WHERE id=?').get(Number(req.header('x-user') ?? 1)) as UserRow; if (req.header('x-bot'))
        req.agentConversationId = req.header('x-bot'); next(); });
    app.use(teachingAudioRouter(ctx, transcribe));
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>(r => server.once('listening', r));
    url = `http://127.0.0.1:${(server.address() as {
        port: number;
    }).port}/teaching/${id}/audio`;
});
afterEach(async () => { await new Promise<void>(r => server.close(() => r())); db.close(); });
const post = (path: string, body?: unknown, headers: Record<string, string> = {}) => fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
const upload = (extra = '', bytes = audio, headers: Record<string, string> = {}) => fetch(`${url}?key=${key}&offset=10&duration=2000${extra}`, { method: 'POST', headers: { 'Content-Type': 'audio/webm', ...headers }, body: bytes });
it('persists audio, aligns narration with actions, and includes actual transcript in review', async () => {
    recordTeachingStep(ctx, 'clara', 1, { action: 'click', target: 'Cleared filter', url: 'https://example.test/reports' });
    const r = await upload();
    expect(r.status).toBe(200);
    const c = await r.json();
    expect((await fetch(`${url}/${c.id}`)).status).toBe(200);
    expect((await post(`${url}/${c.id}/transcribe`)).status).toBe(200);
    const result = finishTeaching(ctx, user, id);
    expect(result.draft).toContain('[0.0s] I choose this filter');
    expect(result.draft).toContain('does not grant action permissions');
    expect(JSON.parse(result.steps_json)[0].offset_ms).toBeGreaterThanOrEqual(0);
    expect(transcribe).toHaveBeenCalledWith(audio, 'audio/webm');
    ctx.config = { sourceDir: '/fixture', dataDir: '/fixture' } as AppContext['config'];
    saveTeaching(ctx, user, id, 'accounting-report', result.draft);
    const store = vi.mocked(createSkillStore).mock.results.at(-1)!.value;
    expect(store.create).toHaveBeenCalledWith('project:project', 'accounting-report', 'Explain filter decisions', expect.stringContaining('only cleared payments'));
    expect(db.prepare('SELECT state FROM bot_teaching_sessions WHERE id=?').get(id)).toEqual({ state: 'saved' });
});
it('deduplicates identical concurrent uploads and rejects changed or overlapping clips', async () => {
    const r = await Promise.all([upload(), upload()]);
    const cs = await Promise.all(r.map(x => x.json()));
    expect(cs[0].id).toBe(cs[1].id);
    expect((await upload('', Buffer.concat([audio, Buffer.from([9])]))).status).toBe(409);
    const overlap = await fetch(`${url}?key=00000000-0000-4000-8000-000000000002&offset=20&duration=1000`, { method: 'POST', headers: { 'Content-Type': 'audio/webm' }, body: audio });
    expect(overlap.status).toBe(409);
    expect(db.prepare('SELECT count(*) n FROM bot_teaching_audio').get()).toEqual({ n: 1 });
});
it('denies other teachers, bots, revoked access and archived conversations on every media route', async () => {
    const c = await (await upload()).json();
    for (const headers of [{ 'x-user': '2' }, { 'x-bot': 'clara' }]) {
        expect((await fetch(url, { headers })).status).toBeGreaterThanOrEqual(400);
        expect((await fetch(`${url}/${c.id}`, { headers })).status).toBeGreaterThanOrEqual(400);
        expect((await post(`${url}/${c.id}/transcribe`, undefined, headers)).status).toBeGreaterThanOrEqual(400);
        expect((await upload('', audio, headers)).status).toBeGreaterThanOrEqual(400);
    }
    db.prepare("UPDATE conversations SET archived=1 WHERE id='clara'").run();
    expect((await fetch(`${url}/${c.id}`)).status).toBe(404);
    db.prepare("UPDATE conversations SET archived=0 WHERE id='clara'").run();
    db.prepare("UPDATE users SET status='disabled' WHERE id=1").run();
    expect((await fetch(url)).status).toBe(403);
});
it('rejects wrong MIME, forged containers, excessive duration and oversized body', async () => {
    expect((await upload('', Buffer.from('not audio'))).status).toBe(400);
    expect((await upload('', audio, { 'Content-Type': 'text/plain' })).status).toBe(400);
    expect((await fetch(`${url}?key=${key}&offset=599999&duration=2`, { method: 'POST', headers: { 'Content-Type': 'audio/webm' }, body: audio })).status).toBe(400);
    expect((await upload('', Buffer.alloc(20000001))).status).toBe(413);
});
it('retains audio after transcription failure; accepts manual correction and prevents silent skill save', async () => {
    const c = await (await upload()).json();
    transcribe.mockRejectedValueOnce(Error('provider unavailable'));
    expect((await post(`${url}/${c.id}/transcribe`)).status).toBe(503);
    expect((await fetch(`${url}/${c.id}`)).status).toBe(200);
    const d = finishTeaching(ctx, user, id);
    expect(() => saveTeaching(ctx, user, id, 'fixture', d.draft)).toThrow('Transcribe');
    expect((await fetch(`${url}/${c.id}/transcript`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Corrected explanation' }) })).status).toBe(200);
    expect(() => saveTeaching(ctx, user, id, 'fixture', d.draft)).toThrow('Update the draft');
    expect(finishTeaching(ctx, user, id).draft).toContain('Corrected explanation');
});
it('rechecks permission after asynchronous transcription and does not retain revoked results', async () => {
    const c = await (await upload()).json();
    let release!: (s: string) => void;
    transcribe.mockImplementationOnce(() => new Promise(r => { release = r; }));
    const request = post(`${url}/${c.id}/transcribe`);
    await vi.waitFor(() => expect(transcribe).toHaveBeenCalled());
    db.prepare("UPDATE users SET status='disabled' WHERE id=1").run();
    release('Private transcript');
    expect((await request).status).toBe(403);
    expect(db.prepare('SELECT transcript FROM bot_teaching_audio').get()).toEqual({ transcript: null });
});
it('deduplicates transcription requests and cannot restore a removed or discarded clip', async () => {
    const c = await (await upload()).json();
    let release!: (s: string) => void;
    transcribe.mockImplementationOnce(() => new Promise(r => { release = r; }));
    const calls = [post(`${url}/${c.id}/transcribe`), post(`${url}/${c.id}/transcribe`)];
    await vi.waitFor(() => expect(transcribe).toHaveBeenCalledTimes(1));
    await fetch(`${url}/${c.id}`, { method: 'DELETE' });
    release('Late text');
    for (const r of await Promise.all(calls))
        expect(r.status).toBe(404);
    expect(db.prepare('SELECT count(*) n FROM bot_teaching_audio').get()).toEqual({ n: 0 });
    db.prepare("UPDATE bot_teaching_sessions SET state='discarded' WHERE id=?").run(id);
    expect((await fetch(url)).status).toBe(404);
    expect((await upload()).status).toBe(404);
});
it('preserves manual corrections if an in-flight transcription returns later', async () => {
    const c = await (await upload()).json();
    let release!: (s: string) => void;
    transcribe.mockImplementationOnce(() => new Promise(r => { release = r; }));
    const request = post(`${url}/${c.id}/transcribe`);
    await vi.waitFor(() => expect(transcribe).toHaveBeenCalled());
    await fetch(`${url}/${c.id}/transcript`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Human correction' }) });
    release('Machine text');
    expect((await request).status).toBe(200);
    expect(db.prepare('SELECT transcript FROM bot_teaching_audio').get()).toEqual({ transcript: 'Human correction' });
});
it('keeps saved evidence immutable and silent demonstrations compatible', async () => {
    const d = finishTeaching(ctx, user, id);
    expect(d.draft).not.toContain('## Narration');
    const c = await (await upload()).json();
    db.prepare("UPDATE bot_teaching_sessions SET state='saved' WHERE id=?").run(id);
    expect((await upload()).status).toBe(409);
    expect((await post(`${url}/${c.id}/transcribe`)).status).toBe(409);
    expect((await fetch(`${url}/${c.id}`, { method: 'DELETE' })).status).toBe(409);
    expect((await fetch(`${url}/${c.id}`)).status).toBe(200);
});
