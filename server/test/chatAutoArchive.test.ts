import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import Database from 'better-sqlite3';
import express from 'express';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import type { AppContext } from '../src/context.js';
import { createApiRouter } from '../src/routes/api.js';
import { DEFAULT_TODO_PLANNING_PROMPT } from '../src/routes/todoPlanningSettings.js';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/db/migrations');

let db: Database.Database;
let server: Server;
let base: string;
const interrupt = vi.fn();
const stopBrowser = vi.fn(async () => ({ active: false }));
let identityEmail = 'owner@example.com';

beforeAll(async () => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db, MIGRATIONS);
  db.prepare(
    "INSERT INTO users (id, email, display_name, role) VALUES (1, 'owner@example.com', 'Owner', 'owner')",
  ).run();
  db.prepare(
    "INSERT INTO users (id, email, display_name, role) VALUES (2, 'member@example.com', 'Member', 'member')",
  ).run();
  const assistant = db.prepare("SELECT id FROM assistants WHERE slug = 'assistant'").get() as { id: number };
  db.prepare(
    `INSERT INTO conversations
       (id, assistant_id, user_id, title, provider, native_session_id, channel, last_active_at, last_user_activity_at, pin_order)
     VALUES
       ('stale', ?, 1, 'Stale', 'claude', 'stale-native', 'web', datetime('now'), datetime('now', '-31 days'), NULL),
       ('opened', ?, 1, 'Opened', 'claude', 'opened-native', 'web', datetime('now'), datetime('now', '-31 days'), NULL),
       ('pinned', ?, 1, 'Pinned', 'claude', 'pinned-native', 'web', datetime('now'), datetime('now', '-90 days'), 0),
       ('automation', ?, 1, 'Automation', 'claude', 'automation-native', 'automation', datetime('now'), datetime('now', '-90 days'), NULL),
       ('delete-me', ?, 1, 'Delete me', 'claude', 'delete-native', 'web', datetime('now'), datetime('now'), NULL)`,
  ).run(assistant.id, assistant.id, assistant.id, assistant.id, assistant.id);
  db.prepare(
    "INSERT INTO todos (id, title, state, conversation_id) VALUES ('stale-todo', 'Stale todo', 'active', 'stale')",
  ).run();

  const ctx = {
    db,
    resolveIdentity: async () => ({ email: identityEmail }),
    manager: {
      statusOf: vi.fn(async () => 'idle' as const),
      interrupt,
      veneerBrowserConversationStop: stopBrowser,
    },
  } as unknown as AppContext;
  const app = express();
  app.use('/api', createApiRouter(ctx));
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(() => {
  identityEmail = 'owner@example.com';
});

afterAll(() => {
  server.close();
  db.close();
});

describe('chat auto-archive', () => {
  it('uses per-user settings, refreshes opened chats, and archives only stale unpinned chats', async () => {
    const settingsResponse = await fetch(`${base}/api/chat/auto-archive-settings`);
    expect(settingsResponse.status).toBe(200);
    expect((await settingsResponse.json()) as unknown).toMatchObject({
      settings: { enabled: true, inactivityDays: 30 },
    });

    const openedResponse = await fetch(`${base}/api/conversations/opened`);
    expect(openedResponse.status).toBe(200);

    const listResponse = await fetch(`${base}/api/conversations?project=none`);
    expect(listResponse.status).toBe(200);
    const body = (await listResponse.json()) as { conversations: { id: string }[] };
    const ids = body.conversations.map((conversation) => conversation.id);
    expect(ids).toContain('opened');
    expect(ids).toContain('pinned');
    expect(ids).not.toContain('stale');
    expect(db.prepare("SELECT archived FROM conversations WHERE id = 'stale'").get()).toEqual({ archived: 1 });
    expect(db.prepare("SELECT archived FROM conversations WHERE id = 'opened'").get()).toEqual({ archived: 0 });
    expect(db.prepare("SELECT archived FROM conversations WHERE id = 'pinned'").get()).toEqual({ archived: 0 });
    expect(db.prepare("SELECT archived FROM conversations WHERE id = 'automation'").get()).toEqual({ archived: 0 });
    expect(db.prepare("SELECT state FROM todos WHERE id = 'stale-todo'").get()).toEqual({ state: 'done' });
    expect(interrupt).toHaveBeenCalledWith('stale');
    expect(stopBrowser).toHaveBeenCalledWith(1, 'stale');

    const updateResponse = await fetch(`${base}/api/chat/auto-archive-settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false, inactivityDays: 90 }),
    });
    expect(updateResponse.status).toBe(200);
    expect((await updateResponse.json()) as unknown).toMatchObject({
      settings: { enabled: false, inactivityDays: 90 },
      archivedCount: 0,
    });
    expect(
      JSON.parse(
        (
          db.prepare("SELECT value_json FROM settings WHERE key = 'chat_auto_archive:1'").get() as {
            value_json: string;
          }
        ).value_json,
      ),
    ).toEqual({ enabled: false, inactivityDays: 90 });
  });

  it('stops a chat browser on manual archive and delete', async () => {
    const archived = await fetch(`${base}/api/conversations/opened`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ archived: true }),
    });
    expect(archived.status).toBe(200);
    expect(stopBrowser).toHaveBeenCalledWith(1, 'opened');

    const deleted = await fetch(`${base}/api/conversations/delete-me`, { method: 'DELETE' });
    expect(deleted.status).toBe(200);
    expect(interrupt).toHaveBeenCalledWith('delete-me');
    expect(stopBrowser).toHaveBeenCalledWith(1, 'delete-me');
    expect(db.prepare("SELECT id FROM conversations WHERE id = 'delete-me'").get()).toBeUndefined();
  });
});

describe('chat appearance settings', () => {
  it('defaults to provider logos and persists one install-wide creator-initial setting', async () => {
    const defaultResponse = await fetch(`${base}/api/chat/appearance-settings`);
    expect(defaultResponse.status).toBe(200);
    expect(await defaultResponse.json()).toMatchObject({ settings: { listIcon: 'provider' } });

    const updateResponse = await fetch(`${base}/api/chat/appearance-settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ listIcon: 'creator' }),
    });
    expect(updateResponse.status).toBe(200);
    expect(await updateResponse.json()).toMatchObject({ settings: { listIcon: 'creator' } });
    expect(
      JSON.parse(
        (
          db.prepare("SELECT value_json FROM settings WHERE key = 'chat_appearance'").get() as {
            value_json: string;
          }
        ).value_json,
      ),
    ).toEqual({ listIcon: 'creator' });

    const rereadResponse = await fetch(`${base}/api/chat/appearance-settings`);
    expect(await rereadResponse.json()).toMatchObject({ settings: { listIcon: 'creator' } });
  });

  it('shares the setting with members but prevents them from changing it', async () => {
    identityEmail = 'member@example.com';

    const readResponse = await fetch(`${base}/api/chat/appearance-settings`);
    expect(readResponse.status).toBe(200);
    expect(await readResponse.json()).toMatchObject({ settings: { listIcon: 'creator' } });

    const updateResponse = await fetch(`${base}/api/chat/appearance-settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ listIcon: 'provider' }),
    });
    expect(updateResponse.status).toBe(403);

    identityEmail = 'owner@example.com';
    const rereadResponse = await fetch(`${base}/api/chat/appearance-settings`);
    expect(await rereadResponse.json()).toMatchObject({ settings: { listIcon: 'creator' } });
  });

  it('rejects unknown icon modes without replacing the saved preference', async () => {
    const response = await fetch(`${base}/api/chat/appearance-settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ listIcon: 'assistant' }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'Invalid chat appearance settings.' });

    const rereadResponse = await fetch(`${base}/api/chat/appearance-settings`);
    expect(await rereadResponse.json()).toMatchObject({ settings: { listIcon: 'creator' } });
  });
});

describe('to-do planning prompt settings', () => {
  it('returns the existing prompt by default and persists an exact per-user replacement', async () => {
    const defaultResponse = await fetch(`${base}/api/chat/todo-planning-settings`);
    expect(defaultResponse.status).toBe(200);
    expect((await defaultResponse.json()) as unknown).toMatchObject({
      settings: { prompt: DEFAULT_TODO_PLANNING_PROMPT },
    });

    const prompt = 'Inspect the relevant code first.\n\nThen explain the plan and wait for my reply.';
    const updateResponse = await fetch(`${base}/api/chat/todo-planning-settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt }),
    });
    expect(updateResponse.status).toBe(200);
    expect((await updateResponse.json()) as unknown).toMatchObject({ settings: { prompt } });
    expect(
      JSON.parse(
        (
          db.prepare("SELECT value_json FROM settings WHERE key = 'todo_planning_prompt:1'").get() as {
            value_json: string;
          }
        ).value_json,
      ),
    ).toEqual({ prompt });

    const rereadResponse = await fetch(`${base}/api/chat/todo-planning-settings`);
    expect(await rereadResponse.json()).toMatchObject({ settings: { prompt } });
  });

  it('rejects an empty planning prompt', async () => {
    const response = await fetch(`${base}/api/chat/todo-planning-settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: '   ' }),
    });
    expect(response.status).toBe(400);
  });
});
