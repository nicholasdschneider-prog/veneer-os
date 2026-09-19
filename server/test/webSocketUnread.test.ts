import { EventEmitter } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { WebSocket } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { attachWebSocket } from '../src/channels/webSocket.js';
import { isUnread } from '../src/conversations/unread.js';
import type { AppContext } from '../src/context.js';
import { migrate } from '../src/db/migrate.js';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/db/migrations');

describe('conversation WebSocket unread', () => {
  let server: Server | null = null;
  let db: Database.Database | null = null;
  let socket: WebSocket | null = null;

  afterEach(async () => {
    socket?.close();
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    db?.close();
  });

  it('keeps a subscribed viewer seen and marks everyone else unread on turn_done', async () => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db, MIGRATIONS);
    db.prepare("INSERT INTO users (email, display_name, role) VALUES ('owner@example.com', 'Owner', 'owner')").run();
    db.prepare("INSERT INTO users (email, display_name, role) VALUES ('member@example.com', 'Member', 'member')").run();
    db.prepare(
      `INSERT INTO conversations (id, assistant_id, user_id, visibility, title, provider, native_session_id, channel)
       VALUES ('team-chat', 1, 1, 'team', 'Team chat', 'claude', 'session-1', 'web')`,
    ).run();

    const bus = new EventEmitter();
    const ctx = {
      db,
      resolveIdentity: async () => ({ email: 'owner@example.com' }),
      manager: {
        bus,
        snapshot: async () => [],
        statusOf: async () => 'idle',
        activityOf: async () => null,
        queueSnapshot: async () => ({ revision: 0, messages: [], failedTurn: null }),
        listWakeups: async () => [],
      },
    } as unknown as AppContext;
    server = createServer();
    attachWebSocket(server, ctx);
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));

    socket = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws`);
    await new Promise<void>((resolve, reject) => {
      socket!.once('open', resolve);
      socket!.once('error', reject);
    });
    socket.send(JSON.stringify({ kind: 'subscribe', conversationId: 'team-chat' }));
    await expect(nextFrame(socket)).resolves.toMatchObject({ kind: 'snapshot', conversationId: 'team-chat' });

    bus.emit('event', 'team-chat', { type: 'turn_done', turnId: 'turn-1', outcome: 'completed' });
    await expect(nextFrame(socket)).resolves.toMatchObject({
      kind: 'event',
      conversationId: 'team-chat',
      event: { type: 'turn_done' },
    });

    expect(isUnread(db, 1, 'team-chat')).toBe(false);
    expect(isUnread(db, 2, 'team-chat')).toBe(true);
  });

  it('observes reply activity without transcript content or marking conversations read', async () => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db, MIGRATIONS);
    db.prepare("INSERT INTO users (email, display_name, role) VALUES ('owner@example.com', 'Owner', 'owner')").run();
    db.prepare("INSERT INTO users (email, display_name, role) VALUES ('member@example.com', 'Member', 'member')").run();
    db.prepare(
      `INSERT INTO conversations (id, assistant_id, user_id, visibility, title, provider, native_session_id, channel)
       VALUES ('team-chat', 1, 1, 'team', 'Team chat', 'claude', 'session-1', 'web')`,
    ).run();

    const bus = new EventEmitter();
    const ctx = {
      db,
      resolveIdentity: async () => ({ email: 'owner@example.com' }),
      manager: {
        bus,
        snapshot: async () => [],
        statusOf: async () => 'idle',
        activityOf: async () => null,
        queueSnapshot: async () => ({ revision: 0, messages: [], failedTurn: null }),
        listWakeups: async () => [],
      },
    } as unknown as AppContext;
    server = createServer();
    attachWebSocket(server, ctx);
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));

    socket = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws`);
    await new Promise<void>((resolve, reject) => {
      socket!.once('open', resolve);
      socket!.once('error', reject);
    });
    socket.send(JSON.stringify({ kind: 'observe', conversationId: 'team-chat' }));
    await expect(nextFrame(socket)).resolves.toMatchObject({ kind: 'status', conversationId: 'team-chat', status: 'idle' });

    bus.emit('event', 'team-chat', { type: 'text_delta', text: 'Private transcript content' });
    await expect(nextFrame(socket)).resolves.toEqual({ kind: 'presence', conversationId: 'team-chat', event: { type: 'text_delta', text: '…' } });
    bus.emit('event', 'team-chat', { type: 'turn_done', turnId: 'turn-1', outcome: 'completed' });
    await expect(nextFrame(socket)).resolves.toMatchObject({
      kind: 'presence',
      conversationId: 'team-chat',
      event: { type: 'turn_done' },
    });

    expect(isUnread(db, 1, 'team-chat')).toBe(true);
    expect(isUnread(db, 2, 'team-chat')).toBe(true);
  });

  it('restores compaction activity in snapshots and clears it live', async () => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db, MIGRATIONS);
    db.prepare("INSERT INTO users (email, display_name, role) VALUES ('owner@example.com', 'Owner', 'owner')").run();
    db.prepare(
      `INSERT INTO conversations (id, assistant_id, user_id, title, provider, native_session_id, channel)
       VALUES ('compact-chat', 1, 1, 'Compact chat', 'codex', 'thread-1', 'web')`,
    ).run();

    const bus = new EventEmitter();
    const ctx = {
      db,
      resolveIdentity: async () => ({ email: 'owner@example.com' }),
      manager: {
        bus,
        snapshot: async () => [],
        statusOf: async () => 'working',
        activityOf: async () => 'compacting',
        queueSnapshot: async () => ({ revision: 0, messages: [], failedTurn: null }),
        listWakeups: async () => [],
      },
    } as unknown as AppContext;
    server = createServer();
    attachWebSocket(server, ctx);
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));

    socket = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws`);
    await new Promise<void>((resolve, reject) => {
      socket!.once('open', resolve);
      socket!.once('error', reject);
    });
    socket.send(JSON.stringify({ kind: 'subscribe', conversationId: 'compact-chat' }));
    await expect(nextFrame(socket)).resolves.toMatchObject({
      kind: 'snapshot',
      conversationId: 'compact-chat',
      status: 'working',
      activity: 'compacting',
    });

    bus.emit('status', 'compact-chat', 'idle', null);
    await expect(nextFrame(socket)).resolves.toMatchObject({
      kind: 'status',
      conversationId: 'compact-chat',
      status: 'idle',
      activity: null,
    });
  });
});

function nextFrame(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for WebSocket frame')), 2_000);
    socket.once('message', (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(String(data)) as Record<string, unknown>);
    });
  });
}
