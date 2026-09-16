import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import Database from 'better-sqlite3';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppContext } from '../src/context.js';
import { migrate } from '../src/db/migrate.js';
import type { ConversationEvent, ConversationStatus } from '../src/runtime/events.js';
import { createApiRouter } from '../src/routes/api.js';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/db/migrations');

let server: Server;
let base: string;
let db: Database.Database;

const statuses = new Map<string, ConversationStatus>([
  ['team-recent', 'needs_you'],
  ['own-project', 'working'],
  ['unfiled', 'idle'],
  ['other-private', 'failed'],
  ['archived', 'failed'],
]);

const transcripts = new Map<string, ConversationEvent[]>([
  [
    'team-recent',
    [
      {
        type: 'turn_started',
        turnId: 't1',
        role: 'user',
        text: 'Check the shipment',
        at: '2026-08-10T14:50:00.000Z',
        via: 'web',
      },
      {
        type: 'text_final',
        turnId: 't1',
        markdown: 'Waiting for your approval on the shipment.',
        at: '2026-08-10T15:05:00.000Z',
      },
    ],
  ],
  [
    'own-project',
    [
      {
        type: 'turn_started',
        turnId: 't1',
        role: 'user',
        text: 'Review the landing page',
        at: '2026-08-10T13:30:00.000Z',
        via: 'web',
      },
      {
        type: 'text_final',
        turnId: 't1',
        markdown: 'The landing page review is complete.',
        at: '2026-08-10T14:05:00.000Z',
      },
    ],
  ],
  [
    'unfiled',
    [
      {
        type: 'turn_started',
        turnId: 't1',
        role: 'user',
        text: 'password=supersecretvalue plan my week',
        at: '2026-08-10T13:00:00.000Z',
        via: 'web',
      },
      {
        type: 'tool_finished',
        turnId: 't1',
        toolId: 'tool-1',
        ok: true,
        resultPreview: 'TOOL OUTPUT MUST NOT APPEAR',
      },
    ],
  ],
]);

beforeAll(async () => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db, MIGRATIONS);
  db.prepare("INSERT INTO users (email, display_name, role) VALUES ('owner@example.com', 'Owner', 'owner')").run();
  db.prepare("INSERT INTO users (email, display_name, role) VALUES ('teammate@example.com', 'Teammate', 'member')").run();
  db.prepare("UPDATE assistants SET slug = 'work-helper', name = 'Work Helper' WHERE id = 1").run();
  db.prepare("INSERT INTO projects (id, slug, name) VALUES ('project-a', 'alpha', 'Alpha')").run();
  db.prepare("INSERT INTO projects (id, slug, name) VALUES ('project-b', 'beta', 'Beta')").run();
  db.prepare(
    "INSERT INTO settings (key, value_json) VALUES ('chat_auto_archive:1', '{\"enabled\":false,\"inactivityDays\":30}')",
  ).run();
  db.prepare(
    `INSERT INTO conversations
      (id, assistant_id, user_id, visibility, project_id, title, provider, model, native_session_id,
       archived, created_at, last_active_at, last_user_activity_at)
     VALUES
      ('team-recent', 1, 2, 'team', 'project-b', 'Shipment follow-up', 'codex', 'gpt-test', 'n1',
       0, '2026-08-10 12:00:00', '2026-08-10 15:06:00', '2026-08-10 14:55:00'),
      ('own-project', 1, 1, 'private', 'project-a', 'Landing page', 'claude', NULL, 'n2',
       0, '2026-08-10 11:00:00', '2026-08-10 14:06:00', '2026-08-10 13:30:00'),
      ('unfiled', 1, 1, 'private', NULL, 'Weekly plan', 'claude', NULL, 'n3',
       0, '2026-08-10 10:00:00', '2026-08-10 13:01:00', '2026-08-10 13:00:00'),
      ('other-private', 1, 2, 'private', 'project-b', 'Hidden teammate chat', 'claude', NULL, 'n4',
       0, '2026-08-10 09:00:00', '2026-08-10 16:00:00', '2026-08-10 16:00:00'),
      ('archived', 1, 1, 'private', 'project-a', 'Archived failure', 'claude', NULL, 'n5',
       1, '2026-08-10 08:00:00', '2026-08-10 17:00:00', '2026-08-10 17:00:00')`,
  ).run();

  const ctx = {
    db,
    resolveIdentity: async () => ({ email: 'owner@example.com' }),
    manager: {
      statusOf: async (id: string) => statuses.get(id) ?? 'idle',
      snapshot: async (id: string) => transcripts.get(id) ?? [],
    },
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

async function recent(query = ''): Promise<{
  status: number;
  body: {
    conversations: Array<Record<string, unknown>>;
    page: { nextOffset: number | null; hasMore: boolean };
  };
}> {
  const response = await fetch(`${base}/api/recent-conversations${query}`);
  return { status: response.status, body: await response.json() };
}

describe('recent conversation discovery route', () => {
  it('orders readable chats globally and returns project, agent, status, and separate activity timestamps', async () => {
    const { body } = await recent();
    expect(body.conversations.map((conversation) => conversation.conversationId)).toEqual([
      'team-recent',
      'own-project',
      'unfiled',
    ]);
    expect(body.conversations[0]).toMatchObject({
      projectId: 'project-b',
      projectName: 'Beta',
      projectSlug: 'beta',
      assistantSlug: 'work-helper',
      assistantName: 'Work Helper',
      provider: 'codex',
      model: 'gpt-test',
      status: 'needs_you',
      updatedAt: '2026-08-10T15:06:00.000Z',
      lastUserActivityAt: '2026-08-10T14:55:00.000Z',
      lastAgentActivityAt: '2026-08-10T15:05:00.000Z',
      preview: {
        role: 'agent',
        text: 'Waiting for your approval on the shipment.',
        at: '2026-08-10T15:05:00.000Z',
      },
    });
  });

  it('keeps previews bounded to sanitized user/agent text', async () => {
    const { body } = await recent('?projectId=none');
    const serialized = JSON.stringify(body);
    expect(body.conversations[0]?.preview).toMatchObject({
      role: 'user',
      text: 'password=[credential omitted] plan my week',
    });
    expect(serialized).not.toContain('supersecretvalue');
    expect(serialized).not.toContain('TOOL OUTPUT MUST NOT APPEAR');
  });

  it('filters by project, activity window, canonical status, and latest preview text', async () => {
    expect((await recent('?projectId=project-a')).body.conversations.map((row) => row.conversationId)).toEqual([
      'own-project',
    ]);
    expect(
      (await recent('?activeSince=2026-08-10T14%3A30%3A00.000Z')).body.conversations.map(
        (row) => row.conversationId,
      ),
    ).toEqual(['team-recent']);
    expect((await recent('?status=working')).body.conversations.map((row) => row.conversationId)).toEqual([
      'own-project',
    ]);
    expect((await recent('?query=shipment')).body.conversations.map((row) => row.conversationId)).toEqual([
      'team-recent',
    ]);
    expect((await recent('?query=plan%20my%20week')).body.conversations.map((row) => row.conversationId)).toEqual([
      'unfiled',
    ]);
  });

  it('paginates with a bounded limit and continuation offset', async () => {
    const first = await recent('?limit=1');
    expect(first.body.conversations.map((row) => row.conversationId)).toEqual(['team-recent']);
    expect(first.body.page).toMatchObject({ nextOffset: 1, hasMore: true });

    const second = await recent('?limit=1&offset=1');
    expect(second.body.conversations.map((row) => row.conversationId)).toEqual(['own-project']);
  });

  it('enforces conversation visibility, excludes archived chats by default, and handles empty results', async () => {
    const normal = await recent();
    expect(normal.body.conversations.map((row) => row.conversationId)).not.toContain('other-private');
    expect(normal.body.conversations.map((row) => row.conversationId)).not.toContain('archived');

    const archived = await recent('?includeArchived=true&query=Archived');
    expect(archived.body.conversations.map((row) => row.conversationId)).toEqual(['archived']);

    const empty = await recent('?projectId=missing');
    expect(empty.body.conversations).toEqual([]);
    expect(empty.body.page).toMatchObject({ nextOffset: null, hasMore: false });
  });

  it('rejects invalid filters', async () => {
    expect((await recent('?status=unknown')).status).toBe(400);
    expect((await recent('?activeSince=not-a-date')).status).toBe(400);
    expect((await recent('?limit=1000')).status).toBe(400);
  });

  it('persists renamed titles for conversation lists and rejects unknown ids', async () => {
    const renamed = await fetch(`${base}/api/conversations/own-project`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '  Today  ' }),
    });
    expect(renamed.status).toBe(200);
    expect((await renamed.json()).conversation.title).toBe('Today');
    expect(db.prepare('SELECT title, title_auto FROM conversations WHERE id = ?').get('own-project')).toEqual({
      title: 'Today',
      title_auto: 0,
    });
    expect((await recent('?query=Today')).body.conversations.map((row) => row.conversationId)).toEqual([
      'own-project',
    ]);

    const missing = await fetch(`${base}/api/conversations/missing-chat`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Today' }),
    });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: 'Conversation not found' });
  });
});
