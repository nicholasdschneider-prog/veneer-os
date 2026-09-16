import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { WebSocket } from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { createIpcServer } from '../src/runner/ipcServer.js';
import { ensureIpcSecret, ipcSecretMatches, ipcSecretPath, IPC_SECRET_HEADER } from '../src/runner/ipcSecret.js';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/db/migrations');

let db: Database.Database;
let dataDir: string;
let server: Server;
let base: string;
let secret: string;
const postedMessages: unknown[][] = [];
const browserReads: unknown[][] = [];

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-ipc-auth-'));
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db, MIGRATIONS);
  db.prepare("INSERT INTO users (id, email, display_name, role) VALUES (1, 'owner@example.com', 'Owner', 'owner')").run();
  db.prepare(
    `INSERT INTO conversations (id, assistant_id, user_id, title, provider, native_session_id, channel)
     VALUES ('ipc-chat', 1, 1, 'IPC chat', 'codex', 'ipc-native', 'web')`,
  ).run();

  const manager = {
    bus: new EventEmitter(),
    statusOf: () => 'idle',
    postMessage: (...args: unknown[]) => {
      postedMessages.push(args);
      return { disposition: 'running' };
    },
  };
  server = createIpcServer({
    manager,
    adapters: {},
    db,
    dataDir,
    usage: {},
    usageBus: new EventEmitter(),
    probe: {},
    veneerBrowser: { fetchUrl: async (...args: unknown[]) => {
      browserReads.push(args);
      return { ok: true, fetched_at: '2026-09-10T00:00:00Z', text: 'Ready' };
    } },
    scheduled: {},
    wakeups: {},
    buildQueue: {},
    onRestart: () => {},
  } as unknown as Parameters<typeof createIpcServer>[0]);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  secret = ensureIpcSecret(dataDir);
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function rpc(headers: Record<string, string>): Promise<Response> {
  return fetch(`${base}/rpc/status`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ convId: 'nope' }),
  });
}

function openEvents(headers: Record<string, string>): Promise<'open' | number> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/events`, { headers });
    ws.on('open', () => {
      ws.close();
      resolve('open');
    });
    ws.on('unexpected-response', (_req, res) => {
      ws.close();
      resolve(res.statusCode ?? 0);
    });
    ws.on('error', () => resolve(0));
  });
}

describe('runner IPC secret', () => {
  it('authenticates script reads and derives the acting user from the chat', async () => {
    const call = (headers: Record<string, string>, convId = 'ipc-chat') => fetch(`${base}/rpc/veneerBrowserFetchUrl`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ convId, userId: 999, request: { url: 'https://example.com' } }),
    });
    expect((await call({})).status).toBe(401);
    expect((await call({ [IPC_SECRET_HEADER]: secret, origin: 'https://attacker.test' })).status).toBe(403);
    expect(browserReads).toHaveLength(0);
    const allowed = await call({ [IPC_SECRET_HEADER]: secret });
    expect(allowed.status).toBe(200);
    expect(browserReads).toEqual([[1, 'ipc-chat', { url: 'https://example.com' }]]);
    expect((await call({ [IPC_SECRET_HEADER]: secret }, 'missing')).status).toBe(404);
  });

  it('mints a 0600 secret file once and adopts it on later reads', () => {
    const file = ipcSecretPath(dataDir);
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    // Bootstrap race: a second process must adopt the existing secret, never
    // overwrite it.
    expect(ensureIpcSecret(dataDir)).toBe(secret);
    expect(fs.readFileSync(file, 'utf8').trim()).toBe(secret);
  });

  it('compares in constant time and rejects near misses', () => {
    expect(ipcSecretMatches(secret, secret)).toBe(true);
    expect(ipcSecretMatches(secret, `${secret}x`)).toBe(false);
    expect(ipcSecretMatches(secret, '')).toBe(false);
    expect(ipcSecretMatches(secret, undefined)).toBe(false);
  });
});

describe('runner IPC /rpc auth', () => {
  it('accepts a request carrying the secret', async () => {
    const res = await rpc({ 'Content-Type': 'application/json', [IPC_SECRET_HEADER]: secret });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'idle' });
  });

  it('rejects a request with no secret', async () => {
    const res = await rpc({ 'Content-Type': 'application/json' });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
  });

  it('rejects a request with the wrong secret', async () => {
    const res = await rpc({ 'Content-Type': 'application/json', [IPC_SECRET_HEADER]: 'not-the-secret' });
    expect(res.status).toBe(401);
  });

  it('rejects any request bearing an Origin header', async () => {
    const res = await rpc({
      'Content-Type': 'application/json',
      [IPC_SECRET_HEADER]: secret,
      Origin: 'https://evil.example',
    });
    expect(res.status).toBe(403);
  });

  it('rejects a non-JSON content type (the CORS-preflight-free POST)', async () => {
    const res = await rpc({ 'Content-Type': 'text/plain', [IPC_SECRET_HEADER]: secret });
    expect(res.status).toBe(415);
  });

  it('leaves /healthz open for the boot probes', async () => {
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('transports bounded source-chat provenance to the runner manager', async () => {
    const response = await fetch(`${base}/rpc/postMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [IPC_SECRET_HEADER]: secret },
      body: JSON.stringify({
        convId: 'ipc-chat',
        text: 'Agent handoff',
        actorUserId: 1,
        origin: {
          kind: 'agent',
          from: 'Researcher',
          to: 'Writer',
          sourceConversationId: 'source-chat',
          sourceConversationTitle: 'Research synthesis',
        },
      }),
    });

    expect(response.status).toBe(200);
    expect(postedMessages.at(-1)).toEqual([
      expect.objectContaining({ id: 'ipc-chat' }),
      'Agent handoff',
      1,
      {
        kind: 'agent',
        from: 'Researcher',
        to: 'Writer',
        sourceConversationId: 'source-chat',
        sourceConversationTitle: 'Research synthesis',
      },
    ]);
  });
});

describe('runner IPC /events auth', () => {
  it('accepts an upgrade carrying the secret', async () => {
    expect(await openEvents({ [IPC_SECRET_HEADER]: secret })).toBe('open');
  });

  it('rejects an upgrade with no secret', async () => {
    expect(await openEvents({})).toBe(401);
  });

  it('rejects an upgrade bearing an Origin header', async () => {
    expect(await openEvents({ [IPC_SECRET_HEADER]: secret, Origin: 'https://evil.example' })).toBe(401);
  });
});
