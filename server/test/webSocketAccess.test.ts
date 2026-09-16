import { EventEmitter } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { WebSocket } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { attachWebSocket } from '../src/channels/webSocket.js';
import type { AppContext } from '../src/context.js';
import { migrate } from '../src/db/migrate.js';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/db/migrations');

describe('conversation WebSocket access changes', () => {
  let server: Server | null = null;
  let db: Database.Database | null = null;
  let socket: WebSocket | null = null;

  afterEach(async () => {
    socket?.close();
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    db?.close();
  });

  it('stops a Team subscriber when the creator makes the chat Private', async () => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db, MIGRATIONS);
    db.prepare("INSERT INTO users (email, display_name, role) VALUES ('creator@example.com', 'Creator', 'owner')").run();
    db.prepare("INSERT INTO users (email, display_name, role) VALUES ('member@example.com', 'Member', 'member')").run();
    db.prepare(
      `INSERT INTO conversations (id, assistant_id, user_id, visibility, title, provider, native_session_id, channel)
       VALUES ('shared-chat', 1, 1, 'team', 'Shared chat', 'claude', 'session-1', 'web')`,
    ).run();

    const bus = new EventEmitter();
    const ctx = {
      db,
      resolveIdentity: async () => ({ email: 'member@example.com' }),
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
    socket.send(JSON.stringify({ kind: 'subscribe', conversationId: 'shared-chat' }));
    await expect(nextFrame(socket)).resolves.toMatchObject({ kind: 'snapshot', conversationId: 'shared-chat' });

    db.prepare("UPDATE conversations SET visibility = 'private' WHERE id = 'shared-chat'").run();
    bus.emit('access', 'shared-chat');
    await expect(nextFrame(socket)).resolves.toEqual({
      kind: 'error',
      conversationId: 'shared-chat',
      message: 'Conversation access changed',
    });

    bus.emit('event', 'shared-chat', {
      type: 'text_final',
      turnId: 'turn-1',
      markdown: 'Private update',
      at: new Date().toISOString(),
    });
    await expect(noFrame(socket)).resolves.toBe(true);
  });

  it('authorizes agent source links per subscriber for snapshots and live events', async () => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db, MIGRATIONS);
    db.prepare("INSERT INTO users (id, email, display_name, role) VALUES (1, 'creator@example.com', 'Creator', 'owner')").run();
    db.prepare("INSERT INTO users (id, email, display_name, role) VALUES (2, 'member@example.com', 'Member', 'member')").run();
    db.prepare(
      `INSERT INTO conversations (id, assistant_id, user_id, visibility, title, provider, native_session_id, channel)
       VALUES ('shared-chat', 1, 1, 'team', 'Shared chat', 'claude', 'session-1', 'web'),
              ('private-source', 1, 1, 'private', 'Creator secrets', 'claude', 'session-2', 'web')`,
    ).run();

    const origin = {
      kind: 'agent' as const,
      from: 'Assistant',
      to: 'Assistant',
      sourceConversationId: 'private-source',
      sourceConversationTitle: 'Creator secrets',
    };
    const event = {
      type: 'turn_started' as const,
      turnId: 'turn-1',
      role: 'user' as const,
      text: 'Private handoff',
      at: '2026-08-24T12:00:00.000Z',
      via: 'web' as const,
      origin,
    };
    const bus = new EventEmitter();
    const ctx = {
      db,
      resolveIdentity: async () => ({ email: 'member@example.com' }),
      manager: {
        bus,
        snapshot: async () => [event],
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
    socket.send(JSON.stringify({ kind: 'subscribe', conversationId: 'shared-chat' }));
    const snapshot = await nextFrame(socket);
    expect(JSON.stringify(snapshot)).not.toContain('private-source');
    expect(JSON.stringify(snapshot)).not.toContain('Creator secrets');

    bus.emit('event', 'shared-chat', event);
    const privateLive = await nextFrame(socket);
    expect(JSON.stringify(privateLive)).not.toContain('private-source');
    expect(JSON.stringify(privateLive)).not.toContain('Creator secrets');

    db.prepare("UPDATE conversations SET visibility = 'team' WHERE id = 'private-source'").run();
    bus.emit('event', 'shared-chat', event);
    await expect(nextFrame(socket)).resolves.toMatchObject({
      kind: 'event',
      event: {
        origin: {
          sourceChat: { id: 'private-source', title: 'Creator secrets' },
        },
      },
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

function noFrame(socket: WebSocket): Promise<boolean> {
  return new Promise((resolve) => {
    const onMessage = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      socket.off('message', onMessage);
      resolve(true);
    }, 100);
    socket.once('message', onMessage);
  });
}
