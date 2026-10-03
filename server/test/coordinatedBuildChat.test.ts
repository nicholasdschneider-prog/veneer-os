import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import Database from 'better-sqlite3';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import type { AppContext } from '../src/context.js';
import type { BuildQueueRow, UserRow } from '../src/db/db.js';
import { createBuildQueueRouter } from '../src/routes/buildQueue.js';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { botFeatureInstructions } from '../src/featureGuide/catalog.js';

// A build that another bot asks for through coordination must not land in the
// receiving chat's human thread (2026-10-03: a Runway request ran as build
// #549 inside an unrelated "Bot avatar voice calls" chat).
const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/db/migrations');
let db: Database.Database;
let server: Server;
let base: string;
let nextJob = 100;
let failEnqueue = false;
const enqueued: { conversationId: string; title: string; brief: string }[] = [];

function chat(id: string, assistantId: number, title: string, extra = '') {
  db.prepare(
    `INSERT INTO conversations (id, assistant_id, user_id, visibility, project_id, title, provider, model, effort, native_session_id, channel)
     VALUES (?, ?, 1, 'private', 'veneer', ?, 'claude', 'claude-fable-5-1', 'medium', ?, 'web')`,
  ).run(id, assistantId, title, `native-${id}${extra}`);
}
function coordinate(a: string, b: string, laneOwner: string, laneId: string, assistantId: number) {
  const [left, right] = [a, b].sort();
  const thread = `thread-${laneId}`;
  db.prepare('INSERT INTO coordination_threads(id,left_id,right_id) VALUES(?,?,?)').run(thread, left, right);
  chat(laneId, assistantId, 'lane');
  db.prepare('INSERT INTO coordination_lanes(conversation_id,thread_id,owner_id) VALUES(?,?,?)').run(laneId, thread, laneOwner);
}

beforeAll(async () => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db, MIGRATIONS);
  db.prepare("INSERT INTO users (id, email, display_name, role) VALUES (1, 'owner@example.com', 'Owner', 'owner')").run();
  db.prepare("INSERT INTO projects (id, slug, name, instructions) VALUES ('veneer', 'veneer', 'Veneer', '')").run();
  const platformDev = (db.prepare("SELECT id FROM assistants WHERE slug = 'platform-dev'").get() as { id: number }).id;
  const assistant = (db.prepare("SELECT id FROM assistants WHERE slug = 'assistant'").get() as { id: number }).id;
  chat('voice-calls', platformDev, 'Bot avatar voice calls');
  chat('runway', assistant, 'Runway subscription integration');
  chat('worker', assistant, 'AutoShip Worker');
  db.prepare("INSERT INTO bot_registrations(conversation_id,name,active,registered_by) VALUES('worker','AutoShip Worker',1,1)").run();
  coordinate('voice-calls', 'runway', 'voice-calls', 'lane-voice', platformDev);
  coordinate('worker', 'runway', 'worker', 'lane-worker', assistant);

  const users = db.prepare('SELECT * FROM users WHERE id = ?');
  const enqueueBuild = async (conversationId: string, title: string, brief: string) => {
    if (failEnqueue) return { ok: false as const, error: 'not_queueable' as const };
    enqueued.push({ conversationId, title, brief });
    const job = { id: nextJob++, user_id: 1, conversation_id: conversationId, scope_key: 'project:veneer', title, brief, status: 'queued', error: null, created_at: '2026-10-03 18:02:34', started_at: null, finished_at: null } as BuildQueueRow;
    return { ok: true as const, job, position: 1, disposition: 'enqueued' as const };
  };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = users.get(1) as UserRow;
    if (req.headers['x-agent']) req.agentConversationId = String(req.headers['x-agent']);
    if (req.headers['x-lane']) req.agentExecutionConversationId = String(req.headers['x-lane']);
    next();
  });
  app.use('/api/build-queue', createBuildQueueRouter({ db, manager: { enqueueBuild, statusOf: async () => 'idle' } } as unknown as AppContext));
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => { server.close(); db.close(); });

const enqueue = (source: string, headers: Record<string, string>, extra: Record<string, unknown> = {}) =>
  fetch(`${base}/api/build-queue`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ sourceConversationId: source, title: 'Runway connector', brief: 'Build the connector.', ...extra }),
  }).then(async (res) => ({ status: res.status, body: (await res.json()) as Record<string, any> }));
const chatCount = () => (db.prepare('SELECT count(*) AS n FROM conversations').get() as { n: number }).n;

describe('builds requested by another bot', () => {
  it('runs in a new chat of its own, linked to the chat that asked', async () => {
    const before = chatCount();
    const { status, body } = await enqueue('voice-calls', { 'x-agent': 'voice-calls', 'x-lane': 'lane-voice' });
    expect(status).toBe(201);
    const created = body.buildConversation as { id: string; title: string };
    expect(created.id).not.toBe('voice-calls');
    expect(created.title).toBe('Runway connector');
    expect(chatCount()).toBe(before + 1);
    const row = db.prepare('SELECT * FROM conversations WHERE id=?').get(created.id) as Record<string, unknown>;
    const owner = db.prepare("SELECT * FROM conversations WHERE id='voice-calls'").get() as Record<string, unknown>;
    for (const field of ['assistant_id', 'user_id', 'visibility', 'project_id', 'provider', 'model', 'effort', 'business_team_id']) {
      expect(row[field], field).toEqual(owner[field]);
    }
    expect(row.origin_conversation_id).toBe('runway');
    expect(row.native_session_id).not.toBe(owner.native_session_id);
    const job = enqueued.at(-1)!;
    expect(job.conversationId).toBe(created.id);
    expect(job.brief).toContain('read_conversation("runway")');
    expect(job.brief).toContain('“Bot avatar voice calls”');
    expect(job.brief.endsWith('Build the connector.')).toBe(true);
    expect(body.job.conversation_id).toBe(created.id);
  });

  it('stays in the receiving chat when its agent says the build continues that chat’s own work', async () => {
    const before = chatCount();
    const { body } = await enqueue('voice-calls', { 'x-agent': 'voice-calls', 'x-lane': 'lane-voice' }, { continuesThisChat: true });
    expect(body.buildConversation).toBeUndefined();
    expect(chatCount()).toBe(before);
    expect(enqueued.at(-1)).toMatchObject({ conversationId: 'voice-calls', brief: 'Build the connector.' });
  });

  it('leaves a build the chat’s own human turn queued exactly where it was', async () => {
    const before = chatCount();
    const { body } = await enqueue('voice-calls', { 'x-agent': 'voice-calls' });
    expect(body.buildConversation).toBeUndefined();
    expect(chatCount()).toBe(before);
    expect(enqueued.at(-1)!.conversationId).toBe('voice-calls');
  });

  it('keeps a registered bot’s build in its one standing chat', async () => {
    const before = chatCount();
    const { body } = await enqueue('worker', { 'x-agent': 'worker', 'x-lane': 'lane-worker' });
    expect(body.buildConversation).toBeUndefined();
    expect(chatCount()).toBe(before);
    expect(enqueued.at(-1)!.conversationId).toBe('worker');
  });

  it('ignores a lane that belongs to a different chat', async () => {
    const before = chatCount();
    const { body } = await enqueue('voice-calls', { 'x-agent': 'voice-calls', 'x-lane': 'lane-worker' });
    expect(body.buildConversation).toBeUndefined();
    expect(chatCount()).toBe(before);
  });

  it('leaves no empty chat behind when the queue refuses the build', async () => {
    const before = chatCount();
    failEnqueue = true;
    const { status } = await enqueue('voice-calls', { 'x-agent': 'voice-calls', 'x-lane': 'lane-voice' });
    failEnqueue = false;
    expect(status).toBe(400);
    expect(chatCount()).toBe(before);
  });
});

describe('instructions and tools that keep new work out of unrelated chats', () => {
  const SOURCE = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/mcp/agentToolsServer.ts');
  type Rpc = { result: { tools?: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>; content?: Array<{ text: string }> } };
  let api: Server;
  let apiBase: string;
  let requests: { method: string; path: string; body: Record<string, unknown> }[] = [];
  let reply: Record<string, unknown> = {};
  beforeAll(async () => {
    api = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => { raw += String(chunk); });
      req.on('end', () => {
        requests.push({ method: req.method ?? '', path: req.url ?? '', body: raw ? JSON.parse(raw) : {} });
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(reply));
      });
    });
    await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
    apiBase = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  });
  afterAll(() => { api.close(); });
  function rpc(method: string, params?: Record<string, unknown>): Promise<Rpc> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', SOURCE], {
        env: { ...process.env, VP_AGENT_TOKEN: 'test-token', VP_CONVERSATION_ID: 'runway', VP_INTERNAL_BASE_URL: apiBase },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let out = '';
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('MCP response timed out')); }, 30_000);
      child.stdout.on('data', (chunk) => {
        out += String(chunk);
        const newline = out.indexOf('\n');
        if (newline < 0) return;
        clearTimeout(timer); child.kill(); resolve(JSON.parse(out.slice(0, newline)) as Rpc);
      });
      child.on('error', reject);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })}\n`);
    });
  }

  it('points new work at handoff in every place a bot reads', async () => {
    const tools = (await rpc('tools/list')).result.tools ?? [];
    const tool = (name: string) => tools.find((t) => t.name === name)!;
    expect(tool('send_message').description).toContain('use handoff to start a new chat instead');
    expect(tool('handoff').description).toContain("pass assistant 'platform-dev' and leave project unset");
    expect(tool('list_conversations').description).toContain('otherwise start a new chat with handoff');
    expect(JSON.stringify(tool('enqueue_build').inputSchema)).toContain('continues_this_chat');
    expect(botFeatureInstructions()).toContain('never pick an unrelated chat because it runs the right agent');
  }, 90_000);

  it('hands off to the agent type the bot asked for', async () => {
    requests = []; reply = { conversation: { id: 'new-chat', provider: 'claude', assistantSlug: 'platform-dev' } };
    const result = await rpc('tools/call', { name: 'handoff', arguments: { task: 'Add a Runway connector', assistant: 'platform-dev' } });
    const create = requests.find((r) => r.method === 'POST' && r.path === '/api/conversations')!;
    expect(create.body).toMatchObject({ assistantSlug: 'platform-dev', originConversationId: 'runway' });
    expect(create.body.projectId).toBeUndefined();
    expect(result.result.content?.[0]?.text).toContain('New chat id: new-chat');
  }, 90_000);

  it('tells the receiving agent its coordinated build went to a new chat', async () => {
    requests = []; reply = { job: { id: 549, title: 'Runway connector', status: 'queued' }, position: 1, disposition: 'enqueued', buildConversation: { id: 'build-chat-1', title: 'Runway connector' } };
    const result = await rpc('tools/call', { name: 'enqueue_build', arguments: { title: 'Runway connector', brief: 'Build it.' } });
    expect(requests[0]!.body).toEqual({ sourceConversationId: 'runway', title: 'Runway connector', brief: 'Build it.' });
    const text = result.result.content?.[0]?.text ?? '';
    expect(text).toContain('in a new chat of its own (build-chat-1)');
    expect(text).toContain('do not change or validate source for it here');
    requests = []; reply = { job: { id: 550, title: 'x', status: 'queued' }, position: 1, disposition: 'enqueued' };
    await rpc('tools/call', { name: 'enqueue_build', arguments: { title: 'x', brief: 'y', continues_this_chat: true } });
    expect(requests[0]!.body.continuesThisChat).toBe(true);
  }, 90_000);
});
