import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import Database from 'better-sqlite3';
import express, { type Request } from 'express';
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
  db.prepare("INSERT INTO users (email, display_name, role) VALUES ('member@example.com', 'Member', 'member')").run();
  db.prepare(
    `INSERT INTO projects (id, slug, name, sort_order, created_at)
     VALUES ('first', 'first', 'First', 0, '2026-01-01'),
            ('second', 'second', 'Second', 1, '2026-01-02')`,
  ).run();
  // Recent chat activity must no longer override the manual project order.
  // Relative date: a fixed timestamp ages across the 30-day chat auto-archive
  // window and the sweep then 500s against this file's minimal fake manager.
  db.prepare(
    `INSERT INTO conversations
      (id, assistant_id, user_id, project_id, title, provider, native_session_id, last_active_at)
     VALUES ('recent', 1, 1, 'second', 'Recent', 'claude', 'session', datetime('now', '-2 days'))`,
  ).run();

  const ctx = {
    db,
    resolveIdentity: async (req: Request) => ({
      email: req.headers['x-test-user'] === 'member' ? 'member@example.com' : 'owner@example.com',
    }),
    // interrupt: the auto-archive sweep interrupts whatever it archives; a
    // missing stub turns a future date-crossing into an HTML 500 mid-test.
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

async function projectIds(): Promise<string[]> {
  const response = await fetch(`${base}/api/projects`);
  const body = (await response.json()) as { projects: { id: string }[] };
  return body.projects.map((project) => project.id);
}

describe('project order', () => {
  it('lists by saved order, persists a reorder, and appends new projects', async () => {
    expect(await projectIds()).toEqual(['first', 'second']);

    const reordered = await fetch(`${base}/api/projects/order`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: ['second', 'first'] }),
    });
    expect(reordered.status).toBe(200);
    expect(await projectIds()).toEqual(['second', 'first']);

    const created = await fetch(`${base}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Third', appearance: { accentColor: '#654321' } }),
    });
    expect(created.status).toBe(200);
    const createdBody = (await created.json()) as {
      project: { id: string; sortOrder: number; appearance: { accentColor: string } };
    };
    expect(createdBody.project.sortOrder).toBe(2);
    expect(createdBody.project.appearance.accentColor).toBe('#654321');
    expect(await projectIds()).toEqual(['second', 'first', createdBody.project.id]);
  });

  it('round-trips project appearance, inherits empty defaults, and lets members edit it', async () => {
    const initial = await fetch(`${base}/api/projects/first`);
    const initialBody = (await initial.json()) as { project: { appearance: Record<string, string> } };
    expect(initialBody.project.appearance).toEqual({
      primaryColor: '',
      accentColor: '',
      backgroundColor: '',
      font: '',
      headingFont: '',
      notes: '',
    });

    const updated = await fetch(`${base}/api/projects/first`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'x-test-user': 'member' },
      body: JSON.stringify({
        appearance: {
          primaryColor: '#123456',
          accentColor: '#abc',
          backgroundColor: '',
          font: 'Source Sans 3',
          headingFont: 'Playfair Display',
          notes: 'Use crisp editorial layouts.',
        },
      }),
    });
    expect(updated.status).toBe(200);
    await expect(updated.json()).resolves.toMatchObject({
      project: {
        appearance: {
          primaryColor: '#123456',
          accentColor: '#abc',
          backgroundColor: '',
          font: 'Source Sans 3',
          headingFont: 'Playfair Display',
          notes: 'Use crisp editorial layouts.',
        },
      },
    });

    const invalid = await fetch(`${base}/api/projects/first`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appearance: { accentColor: 'bronze' } }),
    });
    expect(invalid.status).toBe(400);
  });

  it('rejects stale or incomplete project lists without changing the order', async () => {
    const before = await projectIds();
    const response = await fetch(`${base}/api/projects/order`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: ['first', 'second'] }),
    });
    expect(response.status).toBe(409);
    expect(await projectIds()).toEqual(before);
  });
});
