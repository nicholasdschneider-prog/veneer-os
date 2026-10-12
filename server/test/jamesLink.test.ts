import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import Database from 'better-sqlite3';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { asksQuestion, backfillThreads, getThread, guessStartedBy, JAMES_MARKER } from '../src/jamesLink/registry.js';
import { createJamesRouter } from '../src/jamesLink/routes.js';
import { JamesLink, parseEmailCommand, PUSH_GAP_MS, quietThresholdMs } from '../src/jamesLink/service.js';
import type { MailMessage } from '../src/jamesLink/mail.js';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/db/migrations');
const KEY = 'test-james-key';

let db: Database.Database;
let clock = Date.parse('2026-10-12T16:30:00Z'); // 12:30 ET, after the heartbeat window
const secrets: Record<string, string | null> = {};
const fetchMock = vi.fn();
const sent: Array<{ to: string; subject: string; body: string }> = [];
let failEmailTo: string | null = null;
let inbox: MailMessage[] = [];
const posted: Array<{ id: string; text: string }> = [];
let liveStatus = 'idle';
let link: JamesLink;
let server: Server;
let base: string;

function addConversation(id: string, title: string, extra: { origin?: string; archived?: number } = {}) {
  db.prepare(
    `INSERT INTO conversations (id, assistant_id, user_id, title, provider, native_session_id, origin_conversation_id, archived)
     VALUES (?, 1, 1, ?, 'claude', ?, ?, ?)`,
  ).run(id, title, `${id}-native`, extra.origin ?? null, extra.archived ?? 0);
}
function addDoc(conversationId: string, kind: string, body: string, at: string) {
  db.prepare('INSERT INTO bot_search_documents (id, conversation_id, kind, body, at, href) VALUES (?, ?, ?, ?, ?, ?)')
    .run(`${conversationId}-${kind}-${at}`, conversationId, kind, body, at, '#');
}
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const D = '44444444-4444-4444-8444-444444444444';

function userTurn(id: string, turnId: string, text: string, origin?: { kind: 'agent'; from: string; to: string }) {
  link.onEvent(id, { type: 'turn_started', turnId, role: 'user', text, at: new Date(clock).toISOString(), via: 'web', origin });
}
function veneerReply(id: string, turnId: string, markdown: string) {
  link.onEvent(id, { type: 'text_final', turnId, markdown, at: new Date(clock).toISOString() });
  link.onEvent(id, { type: 'turn_done', turnId, outcome: 'completed' });
}
async function settle() { await link.flush(); }
const api = (p: string, init: RequestInit = {}, key = KEY) =>
  fetch(`${base}${p}`, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, ...(init.headers ?? {}) } });

beforeAll(async () => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db, MIGRATIONS);
  db.prepare("INSERT INTO users (id, email, display_name, role) VALUES (1, 'owner@example.com', 'Owner', 'owner')").run();
  addConversation(A, 'James REM costs');
  addDoc(A, 'user', 'From James for Nick (Oct 12): load REM costs', '2026-10-12T14:00:00Z');
  addDoc(A, 'assistant', 'Done. Should I also update retail?', '2026-10-12T14:05:00Z');
  addConversation(B, 'Nick misc');
  addDoc(B, 'user', 'Check the shipping report', '2026-10-10T14:00:00Z');
  addConversation(C, 'Bot handoff', { origin: B });
  addDoc(C, 'user', 'Please run the import', '2026-10-11T14:00:00Z');
  addConversation(D, 'Old archived', { archived: 1 });
  link = new JamesLink({
    db,
    getSecret: (name) => secrets[name] ?? null,
    fetch: fetchMock as unknown as typeof fetch,
    mailer: {
      async send(to, subject, body) {
        if (to === failEmailTo) throw new Error('smtp down');
        sent.push({ to, subject, body });
        return { messageId: `m${sent.length}` };
      },
      async search() { return inbox; },
    },
    now: () => clock,
    publicOrigin: 'https://veneer.example.com',
    postToChat: async (id, text) => { posted.push({ id, text }); return { disposition: 'running' }; },
    statusOf: async () => liveStatus,
    sleep: async () => undefined,
  });
  backfillThreads(db, clock);
  const app = express();
  app.use('/api/james', createJamesRouter(db, link, (name) => secrets[name] ?? null));
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => { server?.close(); db.close(); });
beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
  sent.length = 0;
  failEmailTo = null;
  secrets.JAMES_WEBHOOK_URL = 'https://grok.example.com/hook';
  secrets.JAMES_WEBHOOK_KEY = 'hook-key';
  secrets.VENEER_JAMES_API_KEY = KEY;
});

describe('heuristics', () => {
  it('guesses who started a thread', () => {
    expect(guessStartedBy('From James for Nick (Oct 12)', false)).toBe('james');
    expect(guessStartedBy('BUILD the link. James asked for this for Nick', true)).toBe('james');
    expect(guessStartedBy('Please run the import', true)).toBe('bot');
    expect(guessStartedBy('[Build queue #1: x]', false)).toBe('bot');
    expect(guessStartedBy('Check the shipping report', false)).toBe('nick');
  });
  it('detects a closing question but not one inside code or links', () => {
    expect(asksQuestion('Done.\n\nShould I also update retail?')).toBe(true);
    expect(asksQuestion('Done. See https://x.test/?a=1 and `a?b`.')).toBe(false);
  });
  it('parses email commands', () => {
    expect(parseEmailCommand(`Re: [VENEER thread ${A}] x`, 'CLOSE\n> quoted')).toEqual({ command: 'CLOSE', threadRef: A });
    expect(parseEmailCommand('Re: hi', `ARCHIVE ${B} please`)).toEqual({ command: 'ARCHIVE', threadRef: B });
    expect(parseEmailCommand('x', 'Close call yesterday')).toBeNull();
  });
  it('uses 2 quiet hours by day and 12 overnight (ET)', () => {
    expect(quietThresholdMs(Date.parse('2026-10-12T15:00:00Z'))).toBe(2 * 3_600_000);
    expect(quietThresholdMs(Date.parse('2026-10-13T04:00:00Z'))).toBe(12 * 3_600_000);
  });
});

describe('backfill', () => {
  it('registers every chat with a best-guess owner, status and turn', () => {
    expect(getThread(db, A)).toMatchObject({ started_by: 'james', followed: 1, status: 'waiting_on_james', turn: 2 });
    expect(getThread(db, B)).toMatchObject({ started_by: 'nick', status: 'waiting_on_veneer', turn: 1 });
    expect(getThread(db, C)).toMatchObject({ started_by: 'bot' });
    expect(getThread(db, D)).toMatchObject({ status: 'archived' });
  });
});

describe('API', () => {
  it('rejects a missing or wrong key and refuses when unconfigured', async () => {
    expect((await api('/api/james/threads', {}, 'nope')).status).toBe(401);
    secrets.VENEER_JAMES_API_KEY = null;
    expect((await api('/api/james/threads')).status).toBe(503);
  });

  it('lists with started_by and waiting_on_james filters', async () => {
    const james = await (await api('/api/james/threads?started_by=james')).json();
    expect(james.threads.map((t: { thread_id: string }) => t.thread_id)).toEqual([A]);
    const waiting = await (await api('/api/james/threads?waiting_on_james=1')).json();
    expect(waiting.threads.map((t: { thread_id: string }) => t.thread_id)).toEqual([A]);
    expect(waiting.threads[0]).toMatchObject({ turn: 2, url: `https://veneer.example.com/#/chat/${A}` });
    const all = await (await api('/api/james/threads')).json();
    expect(all.total).toBe(3); // archived excluded by default
  });

  it('posts a reply at the expected turn and rejects a stale one', async () => {
    const stale = await api(`/api/james/threads/${A}/reply`, { method: 'POST', body: JSON.stringify({ expected_turn: 1, text: 'old' }) });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: 'stale_turn', current_turn: 2 });
    const ok = await api(`/api/james/threads/${A}/reply`, { method: 'POST', body: JSON.stringify({ expected_turn: 2, text: 'Yes, update retail.' }) });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ turn: 3, thread: { status: 'waiting_on_veneer' } });
    expect(posted.at(-1)).toEqual({ id: A, text: `${JAMES_MARKER} · thread ${A} · turn 3]\nFrom James (direct, no Nick relay): Yes, update retail.` });
    // The runner echoes the marked prompt back; it must not count twice.
    userTurn(A, 'echo-1', posted.at(-1)!.text);
    expect(getThread(db, A)!.turn).toBe(3);
    const replay = await api(`/api/james/threads/${A}/reply`, { method: 'POST', body: JSON.stringify({ expected_turn: 2, text: 'dup' }) });
    expect(replay.status).toBe(409);
  });
});

describe('push', () => {
  it('pushes a Veneer reply in a James thread with turn stamping and batches within 15 minutes', async () => {
    veneerReply(A, 'turn-a1', 'Retail updated. FYI the cover-only SKU had no cost.');
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('https://grok.example.com/hook');
    expect(init.headers.authorization).toBe('Bearer hook-key');
    expect(init.headers['x-veneer-signature']).toMatch(/^sha256=[0-9a-f]{64}$/);
    const payload = JSON.parse(init.body);
    expect(payload).toMatchObject({ type: 'veneer.thread_update', reasons: ['reply'], thread: { thread_id: A, turn: 4, status: 'open' } });
    expect(payload.reply_with.body.expected_turn).toBe(4);

    clock += 60_000;
    veneerReply(A, 'turn-a2', 'Also checked the 24in width?');
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1); // batched
    clock += PUSH_GAP_MS;
    await link.tick();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // The question asked at turn 5 has now waited 15 minutes too: one batched push carries both.
    const second = JSON.parse(fetchMock.mock.calls[1]![1].body);
    expect(second.reasons).toEqual(['reply', 'question_unanswered']);
    expect(second.thread).toMatchObject({ turn: 5, status: 'waiting_on_james' });
  });

  it('does not push replies in threads James neither started nor follows', async () => {
    veneerReply(B, 'turn-b1', 'Report checked.');
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getThread(db, B)!.turn).toBe(2);
  });

  it('emails the alert after two webhook failures, falling back to the second address', async () => {
    fetchMock.mockResolvedValue(new Response('no', { status: 500 }));
    const res = await api('/api/james/test-push', { method: 'POST', body: JSON.stringify({ thread_id: A }) });
    expect((await res.json()).push).toMatchObject({ status: 'emailed', attempts: 2, emailed_to: 'nicks@mail.grokbot.com' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sent[0]!.subject).toBe(`[VENEER thread ${A}] James REM costs`);
    failEmailTo = 'nicks@mail.grokbot.com';
    const res2 = await api('/api/james/test-push', { method: 'POST', body: JSON.stringify({ thread_id: A, simulate_webhook_failure: true }) });
    expect((await res2.json()).push).toMatchObject({ status: 'emailed', emailed_to: 'nick@elkhartrvparts.com' });
  });

  it('pushes quiet James threads once per quiet period', async () => {
    clock += 3 * 3_600_000;
    await link.tick();
    const quiet = fetchMock.mock.calls.filter((c) => JSON.parse(c[1].body).reasons.includes('quiet'));
    expect(quiet).toHaveLength(1);
    clock += PUSH_GAP_MS + 60_000;
    await link.tick();
    expect(fetchMock.mock.calls.filter((c) => JSON.parse(c[1].body).reasons.includes('quiet'))).toHaveLength(1);
  });

  it('sends the 8:30 AM ET heartbeat once a day', async () => {
    clock = Date.parse('2026-10-13T12:31:00Z'); // 8:31 ET
    await link.tick();
    await link.tick();
    const beats = fetchMock.mock.calls.filter((c) => JSON.parse(c[1].body).type === 'veneer.heartbeat');
    expect(beats).toHaveLength(1);
    expect(JSON.parse(beats[0]![1].body).waiting_on_james.map((t: { thread_id: string }) => t.thread_id)).toContain(A);
  });
});

describe('close, archive and email commands', () => {
  it('closes, refuses archiving a working thread, archives, and never deletes', async () => {
    expect((await (await api(`/api/james/threads/${A}/close`, { method: 'POST' })).json()).thread.status).toBe('done');
    liveStatus = 'working';
    expect((await api(`/api/james/threads/${A}/archive`, { method: 'POST' })).status).toBe(409);
    liveStatus = 'idle';
    expect((await (await api(`/api/james/threads/${A}/archive`, { method: 'POST' })).json()).thread.status).toBe('archived');
    expect(db.prepare('SELECT archived FROM conversations WHERE id = ?').get(A)).toEqual({ archived: 1 });
    expect((await api(`/api/james/threads/${A}/reply`, { method: 'POST', body: JSON.stringify({ expected_turn: 5, text: 'x' }) })).status).toBe(409);
    expect((await (await api(`/api/james/threads/${A}/reopen`, { method: 'POST' })).json()).thread.status).toBe('open');
    expect(db.prepare('SELECT archived FROM conversations WHERE id = ?').get(A)).toEqual({ archived: 0 });
  });

  it('auto-archives done threads after 7 quiet days', async () => {
    await api(`/api/james/threads/${B}/close`, { method: 'POST' });
    clock += 8 * 24 * 3_600_000;
    await link.tick();
    expect(getThread(db, B)!.status).toBe('archived');
  });

  it('applies CLOSE and ARCHIVE email replies only from allowed senders', async () => {
    inbox = [
      { messageId: 'e1', sender: 'James Bot <nicks@mail.grokbot.com>', subject: `Re: [VENEER thread ${C}] Bot handoff`, text: 'CLOSE\n\n> old' },
      { messageId: 'e2', sender: 'stranger@example.com', subject: `Re: [VENEER thread ${A}] x`, text: 'ARCHIVE' },
    ];
    await link.pollEmailCommands();
    expect(getThread(db, C)!.status).toBe('done');
    expect(getThread(db, A)!.status).toBe('open');
    expect(sent.some((m) => m.to === 'nicks@mail.grokbot.com' && m.subject.includes('CLOSE done'))).toBe(true);
    await link.pollEmailCommands();
    expect(db.prepare('SELECT COUNT(*) AS n FROM james_email_commands').get()).toEqual({ n: 2 });
  });

  it('does not auto-follow registered bot chats or wait on James in threads he is not part of', async () => {
    const E = '55555555-5555-4555-8555-555555555555';
    addConversation(E, 'Avery triage');
    db.prepare('INSERT INTO bot_registrations (conversation_id, name, registered_by) VALUES (?, ?, 1)').run(E, 'Avery');
    userTurn(E, 'e-1', 'Nick-approved via James: handle ticket 5');
    veneerReply(E, 'e-2', 'Handled. Should I refund too?');
    await settle();
    expect(getThread(db, E)).toMatchObject({ followed: 0, status: 'open' });
    expect(fetchMock.mock.calls.filter((c) => JSON.parse(c[1].body).thread?.thread_id === E)).toHaveLength(0);
  });

  it('marks a bot-sent message as bot-authored and a James mention as followed', () => {
    userTurn(B, 'b-2', 'Nick-approved via James: archive the old report', { kind: 'agent', from: 'x', to: 'y' });
    expect(getThread(db, B)).toMatchObject({ followed: 1 });
    const last = db.prepare('SELECT author FROM james_thread_messages WHERE conversation_id = ? ORDER BY turn DESC LIMIT 1').get(B);
    expect(last).toEqual({ author: 'bot' });
  });
});
