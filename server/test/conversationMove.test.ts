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
let status: 'idle' | 'working' | 'needs_you' | 'failed' = 'idle';
const browserStop = vi.fn(async () => null);

async function patch(id: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${base}/api/conversations/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

function row(id: string): { project_id: string | null; instruction_snapshot_json: string | null; provider_instruction_hash: string | null } {
  return db
    .prepare('SELECT project_id, instruction_snapshot_json, provider_instruction_hash FROM conversations WHERE id = ?')
    .get(id) as { project_id: string | null; instruction_snapshot_json: string | null; provider_instruction_hash: string | null };
}

beforeAll(async () => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db, MIGRATIONS);
  db.prepare("INSERT INTO users (id, email, display_name, role) VALUES (1, 'owner@example.com', 'Owner', 'owner')").run();
  db.prepare("INSERT INTO users (id, email, display_name, role) VALUES (2, 'member@example.com', 'Member', 'member')").run();
  db.prepare("INSERT INTO projects (id, slug, name) VALUES ('old', 'old', 'Old'), ('new', 'new', 'New')").run();
  const assistant = db.prepare("SELECT id FROM assistants WHERE slug = 'assistant'").get() as { id: number };
  const insert = db.prepare(
    `INSERT INTO conversations
       (id, assistant_id, user_id, title, provider, native_session_id, channel, project_id, side_chat_of,
        instruction_snapshot_json, provider_instruction_hash)
     VALUES (?, ?, ?, ?, 'claude', ?, 'web', ?, ?, '{"stale":true}', 'hash')`,
  );
  insert.run('parent', assistant.id, 1, 'Parent', 'native-parent', 'old', null);
  insert.run('side', assistant.id, 1, 'Side', 'native-side', 'old', 'parent');
  insert.run('other', assistant.id, 2, 'Other user', 'native-other', 'old', null);
  insert.run('unfile-me', assistant.id, 1, 'Unfile', 'native-unfile', 'old', null);
  db.prepare(
    `INSERT INTO generated_files (id, path, name, source, user_id, conversation_id, project_id)
     VALUES ('file-1', '/tmp/report.md', 'report.md', 'write', 1, 'parent', 'old')`,
  ).run();

  const manager = {
    statusOf: vi.fn(async () => status),
    interrupt: vi.fn(async () => undefined),
    veneerBrowserConversationStop: browserStop,
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

describe('PATCH /conversations/:id projectId', () => {
  it('rejects an unknown target project', async () => {
    const result = await patch('parent', { projectId: 'missing' });
    expect(result.status).toBe(404);
    expect(row('parent').project_id).toBe('old');
  });

  it('refuses to move a side chat on its own', async () => {
    const result = await patch('side', { projectId: 'new' });
    expect(result.status).toBe(400);
    expect(row('side').project_id).toBe('old');
  });

  it('refuses while a turn is live', async () => {
    status = 'working';
    try {
      const result = await patch('parent', { projectId: 'new' });
      expect(result.status).toBe(409);
      expect(row('parent').project_id).toBe('old');
    } finally {
      status = 'idle';
    }
  });

  it('moves the chat, its side chats, and its files, and re-freezes instructions', async () => {
    const result = await patch('parent', { projectId: 'new' });
    expect(result.status).toBe(200);
    expect((result.json.conversation as { projectId: string }).projectId).toBe('new');
    for (const id of ['parent', 'side']) {
      const moved = row(id);
      expect(moved.project_id).toBe('new');
      expect(moved.instruction_snapshot_json).toBeNull();
      expect(moved.provider_instruction_hash).toBeNull();
    }
    const file = db.prepare("SELECT project_id FROM generated_files WHERE id = 'file-1'").get() as { project_id: string };
    expect(file.project_id).toBe('new');
    expect(browserStop).toHaveBeenCalledWith(1, 'parent');
  });

  it('unfiles a chat with projectId null', async () => {
    const result = await patch('unfile-me', { projectId: null });
    expect(result.status).toBe(200);
    expect(row('unfile-me').project_id).toBeNull();
  });

  it('leaves a chat alone when the project is unchanged', async () => {
    db.prepare("UPDATE conversations SET instruction_snapshot_json = '{\"kept\":true}' WHERE id = 'unfile-me'").run();
    const result = await patch('unfile-me', { projectId: null, title: 'Renamed' });
    expect(result.status).toBe(200);
    expect(row('unfile-me').instruction_snapshot_json).toBe('{"kept":true}');
  });
});
