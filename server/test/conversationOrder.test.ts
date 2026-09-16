import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import Database from 'better-sqlite3';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import type { AppContext } from '../src/context.js';
import { createApiRouter } from '../src/routes/api.js';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/db/migrations');

let server: Server;
let base: string;
let db: Database.Database;

beforeAll(async () => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db, MIGRATIONS);
  db.prepare("INSERT INTO users (email, display_name, role) VALUES ('owner@example.com', 'Owner', 'owner')").run();
  db.prepare("INSERT INTO projects (id, slug, name) VALUES ('project-1', 'project-1', 'Project 1')").run();
  // Timestamps are relative to now: the conversations route auto-archives
  // unpinned chats whose last activity is older than 30 days, so a fixed date
  // here becomes a time bomb that silently drops rows once the calendar
  // catches up with it. Keep everything well inside the archive window.
  db.prepare(
    `INSERT INTO conversations
      (id, assistant_id, user_id, project_id, title, provider, native_session_id, created_at, last_active_at)
     VALUES
      ('project-older', 1, 1, 'project-1', 'Older creation', 'claude', 'p-old', datetime('now', '-20 days'), datetime('now', '-5 days')),
      ('project-newer', 1, 1, 'project-1', 'Newer creation', 'claude', 'p-new', datetime('now', '-19 days'), datetime('now', '-6 days')),
      ('loose-older', 1, 1, NULL, 'Older loose creation', 'claude', 'l-old', datetime('now', '-20 days'), datetime('now', '-5 days')),
      ('loose-newer', 1, 1, NULL, 'Newer loose creation', 'claude', 'l-new', datetime('now', '-19 days'), datetime('now', '-6 days'))`,
  ).run();
  db.prepare(
    `INSERT INTO conversations
      (id, assistant_id, user_id, title, provider, native_session_id, channel, created_at, last_active_at)
     VALUES
      ('automation-routine', 1, 1, 'Routine automation', 'claude', 'a-routine', 'automation', datetime('now', '-18 days'), datetime('now', '-1 days')),
      ('automation-attention', 1, 1, 'Attention automation', 'claude', 'a-attention', 'automation', datetime('now', '-18 days'), datetime('now', '-2 days')),
      ('automation-important', 1, 1, 'Important automation', 'claude', 'a-important', 'automation', datetime('now', '-18 days'), datetime('now', '-3 days')),
      ('automation-pinned-old', 1, 1, 'Pinned old run', 'claude', 'a-pinned-old', 'automation', datetime('now', '-18 days'), datetime('now', '-4 days')),
      ('automation-pinned-latest', 1, 1, 'Pinned latest run', 'claude', 'a-pinned-latest', 'automation', datetime('now', '-18 days'), datetime('now', '-5 days', '+1 hours'))`,
  ).run();
  db.prepare("UPDATE conversations SET project_id = 'project-1' WHERE id = 'automation-attention'").run();
  db.prepare(
    `INSERT INTO scheduled_tasks
      (id, user_id, assistant_id, name, prompt, schedule_json, timezone, provider, pin_order)
     VALUES
      ('task-routine', 1, 1, 'Routine', 'work', '{"type":"daily","time":"09:00"}', 'UTC', 'claude', NULL),
      ('task-attention', 1, 1, 'Attention', 'work', '{"type":"daily","time":"09:00"}', 'UTC', 'claude', NULL),
      ('task-important', 1, 1, 'Important', 'work', '{"type":"daily","time":"09:00"}', 'UTC', 'claude', NULL),
      ('task-pinned', 1, 1, 'Pinned', 'work', '{"type":"daily","time":"09:00"}', 'UTC', 'claude', 0)`,
  ).run();
  db.prepare(
    `INSERT INTO scheduled_task_runs
      (id, scheduled_task_id, conversation_id, scheduled_for, trigger, status, important, started_at, finished_at)
     VALUES
      ('run-routine', 'task-routine', 'automation-routine', datetime('now', '-1 days'), 'scheduled', 'completed', 0, datetime('now', '-1 days'), datetime('now', '-1 days', '+1 minutes')),
      ('run-attention', 'task-attention', 'automation-attention', datetime('now', '-2 days'), 'scheduled', 'failed', 0, datetime('now', '-2 days'), datetime('now', '-2 days', '+1 minutes')),
      ('run-important', 'task-important', 'automation-important', datetime('now', '-3 days'), 'scheduled', 'completed', 1, datetime('now', '-3 days'), datetime('now', '-3 days', '+1 minutes')),
      ('run-pinned-old', 'task-pinned', 'automation-pinned-old', datetime('now', '-4 days'), 'scheduled', 'completed', 0, datetime('now', '-4 days'), datetime('now', '-4 days', '+1 minutes')),
      ('run-pinned-latest', 'task-pinned', 'automation-pinned-latest', datetime('now', '-5 days', '+1 hours'), 'manual', 'completed', 0, datetime('now', '-12 hours'), datetime('now', '-12 hours', '+1 minutes'))`,
  ).run();

  const ctx = {
    db,
    resolveIdentity: async () => ({ email: 'owner@example.com' }),
    // interrupt: the route's auto-archive sweep interrupts whatever it archives.
    // Nothing here should ever cross the archive window, but if it does, the
    // failure should be an ordering assertion, not a 500 from a missing method.
    manager: { statusOf: async () => 'idle', interrupt: async () => true },
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

async function conversationIds(project: string): Promise<string[]> {
  const response = await fetch(`${base}/api/conversations?project=${project}`);
  const body = (await response.json()) as { conversations: { id: string }[] };
  return body.conversations.map((conversation) => conversation.id);
}

describe('conversation list order', () => {
  it('keeps project chats in newest-first creation order', async () => {
    expect(await conversationIds('project-1')).toEqual(['project-newer', 'project-older']);

    db.prepare("UPDATE conversations SET last_active_at = datetime('now', '-4 days') WHERE id = 'project-older'").run();
    expect(await conversationIds('project-1')).toEqual(['project-newer', 'project-older']);
  });

  it('keeps loose chats ordered by recent activity', async () => {
    expect(await conversationIds('none')).toEqual([
      'automation-attention',
      'automation-important',
      'loose-older',
      'loose-newer',
    ]);
  });

  it('hides routine and pinned automation runs while exposing attention and important results', async () => {
    const ids = await conversationIds('none');
    expect(ids).not.toContain('automation-routine');
    expect(ids).not.toContain('automation-pinned-old');
    expect(ids).not.toContain('automation-pinned-latest');
    expect(ids).toContain('automation-attention');
    expect(ids).toContain('automation-important');
    expect(await conversationIds('project-1')).not.toContain('automation-attention');
  });
});
