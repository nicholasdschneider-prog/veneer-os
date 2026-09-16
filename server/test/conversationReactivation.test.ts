import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import Database from 'better-sqlite3';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import type { AppContext } from '../src/context.js';
import { createApiRouter } from '../src/routes/api.js';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/db/migrations');

let db: Database.Database;
let server: Server;
let base: string;
let archivedWhenPosted: number | null = null;
let archivedWhenSteered: number | null = null;

beforeAll(async () => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db, MIGRATIONS);
  db.prepare(
    "INSERT INTO users (id, email, display_name, role) VALUES (1, 'owner@example.com', 'Owner', 'owner')",
  ).run();
  const assistant = db.prepare("SELECT id FROM assistants WHERE slug = 'assistant'").get() as { id: number };
  const insertConversation = db.prepare(
    `INSERT INTO conversations
       (id, assistant_id, user_id, title, provider, native_session_id, channel, archived)
     VALUES (?, ?, 1, ?, 'claude', ?, 'web', 1)`,
  );
  insertConversation.run('archived-message', assistant.id, 'Archived message', 'native-message');
  insertConversation.run('archived-steer', assistant.id, 'Archived steer', 'native-steer');
  db.prepare(
    `INSERT INTO todos (id, title, state, conversation_id) VALUES
       ('todo-message', 'Archived message', 'done', 'archived-message'),
       ('todo-steer', 'Archived steer', 'done', 'archived-steer')`,
  ).run();

  const queue = { revision: 1, messages: [], failedTurn: null };
  const manager = {
    postMessage: vi.fn(async (conversationId: string) => {
      archivedWhenPosted = (
        db.prepare('SELECT archived FROM conversations WHERE id = ?').get(conversationId) as { archived: number }
      ).archived;
      return { messageId: 1, disposition: 'running' as const, queue };
    }),
    steerMessage: vi.fn(async (conversationId: string) => {
      archivedWhenSteered = (
        db.prepare('SELECT archived FROM conversations WHERE id = ?').get(conversationId) as { archived: number }
      ).archived;
      return { messageId: 2, disposition: 'running' as const, queue };
    }),
    statusOf: vi.fn(async () => 'idle' as const),
  };
  const ctx = {
    db,
    manager,
    resolveIdentity: async () => ({ email: 'owner@example.com' }),
  } as unknown as AppContext;

  const app = express();
  app.use('/api', createApiRouter(ctx));
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
  db.close();
});

describe('archived conversation reactivation', () => {
  it('moves a chat and linked todo back to active before posting a user message', async () => {
    const response = await fetch(`${base}/api/conversations/archived-message/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Continue this work.' }),
    });
    expect(response.status).toBe(200);
    expect(archivedWhenPosted).toBe(0);
    expect(db.prepare("SELECT archived FROM conversations WHERE id = 'archived-message'").get()).toEqual({ archived: 0 });
    expect(
      (db.prepare("SELECT last_user_activity_at FROM conversations WHERE id = 'archived-message'").get() as {
        last_user_activity_at: string | null;
      }).last_user_activity_at,
    ).not.toBeNull();
    expect(db.prepare("SELECT state FROM todos WHERE id = 'todo-message'").get()).toEqual({ state: 'active' });
  });

  it('does the same for agent-to-agent guidance', async () => {
    const response = await fetch(`${base}/api/conversations/archived-steer/steer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Pick this up again.' }),
    });
    expect(response.status).toBe(200);
    expect(archivedWhenSteered).toBe(0);
    expect(db.prepare("SELECT archived FROM conversations WHERE id = 'archived-steer'").get()).toEqual({ archived: 0 });
    expect(db.prepare("SELECT state FROM todos WHERE id = 'todo-steer'").get()).toEqual({ state: 'active' });
  });
});
