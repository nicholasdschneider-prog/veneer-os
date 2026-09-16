import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import express, { type Request } from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppContext } from '../src/context.js';
import { migrate } from '../src/db/migrate.js';
import { createApiRouter } from '../src/routes/api.js';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/db/migrations');

let server: Server;
let base: string;
let db: Database.Database;

async function call(
  method: 'GET' | 'PATCH',
  conversationId?: string,
  body?: Record<string, unknown>,
  user: 'owner' | 'member' = 'member',
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${base}/api/project-settings`, {
    method,
    headers: {
      'x-test-user': user,
      ...(conversationId ? { 'x-test-conversation': conversationId } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

beforeAll(async () => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db, MIGRATIONS);
  db.prepare("INSERT INTO users (id, email, display_name, role) VALUES (1, 'owner@example.com', 'Owner', 'owner')").run();
  db.prepare("INSERT INTO users (id, email, display_name, role) VALUES (2, 'member@example.com', 'Member', 'member')").run();
  db.prepare(
    `INSERT INTO projects (id, slug, name, appearance_json, sort_order)
     VALUES ('project-1', 'alpha', 'Alpha', ?, 0)`,
  ).run(
    JSON.stringify({
      primaryColor: '#111111',
      accentColor: '',
      backgroundColor: '',
      font: '',
      notes: '',
    }),
  );
  db.prepare(
    `INSERT INTO conversations
      (id, assistant_id, user_id, project_id, title, provider, native_session_id)
     VALUES
      ('owner-project-chat', 1, 1, 'project-1', 'Owner project chat', 'claude', 'owner-native'),
      ('member-project-chat', 1, 2, 'project-1', 'Member project chat', 'claude', 'member-native'),
      ('member-loose-chat', 1, 2, NULL, 'Loose chat', 'claude', 'loose-native')`,
  ).run();
  db.prepare(
    `INSERT INTO hub_inbound_messages (idempotency_key, conversation_id, message_id)
     VALUES ('verified-receipt-1234', 'member-project-chat', 42)`,
  ).run();
  db.prepare("INSERT INTO settings (key, value_json) VALUES ('page_brand', ?)").run(
    JSON.stringify({ accentColor: '#abc', font: 'Site Sans' }),
  );

  const ctx = {
    db,
    resolveIdentity: async (req: Request) => {
      const member = req.headers['x-test-user'] === 'member';
      const conversationId = req.headers['x-test-conversation'];
      return {
        email: member ? 'member@example.com' : 'owner@example.com',
        ...(typeof conversationId === 'string' ? { agentConversationId: conversationId } : {}),
      };
    },
    manager: { statusOf: async () => 'idle' },
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

describe('agent project settings routes', () => {
  it('reads raw and effective appearance from the authenticated chat project', async () => {
    const response = await call('GET', 'member-project-chat');
    expect(response.status).toBe(200);
    expect(response.json).toMatchObject({
      projectSettings: {
        project: { id: 'project-1', slug: 'alpha', name: 'Alpha' },
        instructions: '',
        appearance: {
          primaryColor: '#111111',
          accentColor: '',
          backgroundColor: '',
          font: '',
          notes: '',
        },
        effectiveAppearance: {
          primaryColor: '#111111',
          accentColor: '#abc',
          backgroundColor: '#faf7f2',
          font: 'Site Sans',
        },
      },
    });
  });

  it('updates and clears durable project instructions without changing appearance', async () => {
    const updated = await call('PATCH', 'member-project-chat', {
      instructions: 'Keep answers concise.\n\nUse metric units.',
    });
    expect(updated.status).toBe(200);
    expect(updated.json).toMatchObject({
      projectSettings: {
        instructions: 'Keep answers concise.\n\nUse metric units.',
        appearance: { primaryColor: '#111111' },
      },
    });

    const cleared = await call('PATCH', 'member-project-chat', { instructions: '' });
    expect(cleared.status).toBe(200);
    expect(cleared.json).toMatchObject({ projectSettings: { instructions: '' } });
  });

  it('allows a member agent to patch fields, preserves omissions, and clears to inherited values', async () => {
    const updated = await call('PATCH', 'member-project-chat', {
      appearance: { accentColor: '#123456', notes: 'Use sharp corners.' },
    });
    expect(updated.status).toBe(200);
    expect(updated.json).toMatchObject({
      projectSettings: {
        appearance: {
          primaryColor: '#111111',
          accentColor: '#123456',
          backgroundColor: '',
          font: '',
          notes: 'Use sharp corners.',
        },
        effectiveAppearance: {
          primaryColor: '#111111',
          accentColor: '#123456',
          backgroundColor: '#faf7f2',
          font: 'Site Sans',
          notes: 'Use sharp corners.',
        },
      },
    });

    const cleared = await call('PATCH', 'member-project-chat', {
      appearance: { accentColor: '', notes: '' },
    });
    expect(cleared.status).toBe(200);
    expect(cleared.json).toMatchObject({
      projectSettings: {
        appearance: { primaryColor: '#111111', accentColor: '', notes: '' },
        effectiveAppearance: { primaryColor: '#111111', accentColor: '#abc' },
      },
    });
  });

  it('rejects invalid fields and never accepts an arbitrary project id', async () => {
    const invalidColor = await call('PATCH', 'member-project-chat', {
      appearance: { primaryColor: 'purple' },
    });
    expect(invalidColor.status).toBe(400);
    expect(invalidColor.json.error).toContain('hex color');

    const arbitraryTarget = await call('PATCH', 'member-project-chat', {
      projectId: 'some-other-project',
      appearance: { font: 'Targeted font' },
    });
    expect(arbitraryTarget.status).toBe(400);
    expect(arbitraryTarget.json.error).toContain('Unrecognized key');
  });

  it('requires token-bound scope and lets unfiled chats read site design only', async () => {
    const browserRequest = await call('GET');
    expect(browserRequest.status).toBe(403);
    expect(browserRequest.json.error).toContain('authenticated agent conversation');

    const otherUsersChat = await call('GET', 'owner-project-chat');
    expect(otherUsersChat.status).toBe(404);
    expect(otherUsersChat.json.error).toContain('conversation not found');

    const unfiled = await call('GET', 'member-loose-chat');
    expect(unfiled.status).toBe(200);
    expect(unfiled.json).toMatchObject({
      projectSettings: {
        project: null,
        instructions: '',
        appearance: {},
      },
    });
  });
});
