import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppContext } from '../src/context.js';
import type { UserRow } from '../src/db/db.js';
import { migrate } from '../src/db/migrate.js';
import { createNavigationRouter, removeMiniAppFromNavigation } from '../src/routes/navigation.js';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/db/migrations');
const SOURCE = 'export function handle() { return new Response("ok"); }';

let db: Database.Database;
let server: Server;
let base: string;
let role: UserRow['role'] = 'owner';

beforeAll(async () => {
  db = new Database(':memory:');
  migrate(db, MIGRATIONS);
  db.prepare(
    `INSERT INTO mini_apps
      (id, slug, title, source_text, source_size_bytes, script_name, status)
     VALUES ('sales-app', 'sales-app', 'Sales Pulse', ?, ?, 'sales-app-script', 'deployed')`,
  ).run(SOURCE, Buffer.byteLength(SOURCE));

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = {
      id: 1,
      email: 'owner@example.com',
      display_name: 'Owner',
      role,
      status: 'active',
      created_at: '2026-01-01 00:00:00',
      last_seen_at: null,
    };
    next();
  });
  app.use('/api/navigation', createNavigationRouter({ db } as unknown as AppContext));
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
});

async function getNavigation() {
  return fetch(`${base}/api/navigation`).then((response) => response.json()) as Promise<Record<string, any>>;
}

describe('workspace navigation settings', () => {
  it('starts with the current built-ins and a hidden Terminal', async () => {
    const result = await getNavigation();
    expect(result.configured).toBe(false);
    expect(result.navigation.items).toEqual([
      { kind: 'builtin', key: 'automations', visible: true },
      { kind: 'builtin', key: 'todos', visible: true },
      { kind: 'builtin', key: 'pages', visible: true },
      { kind: 'builtin', key: 'apps', visible: true },
      { kind: 'builtin', key: 'terminal', visible: false },
    ]);
  });

  it('persists order, visibility, and a resolved Mini App title', async () => {
    role = 'owner';
    const response = await fetch(`${base}/api/navigation`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        items: [
          { kind: 'app', appId: 'sales-app', visible: true, icon: 'chart', label: null },
          { kind: 'builtin', key: 'pages', visible: true },
          { kind: 'builtin', key: 'todos', visible: false },
          { kind: 'builtin', key: 'automations', visible: true },
          { kind: 'builtin', key: 'apps', visible: true },
          { kind: 'builtin', key: 'terminal', visible: false },
        ],
      }),
    });
    expect(response.status).toBe(200);
    const result = (await response.json()) as Record<string, any>;
    expect(result.navigation.items[0]).toEqual({
      kind: 'app',
      appId: 'sales-app',
      visible: true,
      icon: 'chart',
      label: null,
      title: 'Sales Pulse',
    });
    expect((await getNavigation()).navigation.items[2]).toEqual({ kind: 'builtin', key: 'todos', visible: false });
  });

  it('rejects member writes and unknown Mini Apps', async () => {
    role = 'member';
    const denied = await fetch(`${base}/api/navigation`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items: [] }),
    });
    expect(denied.status).toBe(403);

    role = 'consultant';
    const unknown = await fetch(`${base}/api/navigation`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items: [{ kind: 'app', appId: 'missing', visible: true, icon: 'app' }] }),
    });
    expect(unknown.status).toBe(400);
  });

  it('removes a deleted Mini App from the saved navigation', async () => {
    removeMiniAppFromNavigation(db, 'sales-app');
    expect((await getNavigation()).navigation.items.some((item: Record<string, unknown>) => item.kind === 'app')).toBe(false);
  });
});
