import http, { type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AppContext } from '../src/context.js';
import { migrate } from '../src/db/migrate.js';
import type { UserRow } from '../src/db/db.js';
import { createPagesRouter } from '../src/routes/pages.js';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/db/migrations');

const USERS: Record<string, UserRow> = {
  owner: {
    id: 1,
    email: 'owner@example.com',
    display_name: 'Owner',
    role: 'owner',
    status: 'active',
    created_at: '',
    last_seen_at: null,
  },
  member: {
    id: 2,
    email: 'member@example.com',
    display_name: 'Member',
    role: 'member',
    status: 'active',
    created_at: '',
    last_seen_at: null,
  },
};

let db: Database.Database;
let server: Server;
let base: string;

interface JsonResponse {
  status: number;
  json: Record<string, unknown>;
}

function call(method: string, pathname: string, user = 'owner', body?: Record<string, unknown>): Promise<JsonResponse> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      `${base}${pathname}`,
      {
        method,
        headers: {
          'x-test-user': user,
          ...(data === undefined
            ? {}
            : {
                'content-type': 'application/json',
                'content-length': String(Buffer.byteLength(data)),
              }),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({
            status: res.statusCode ?? 0,
            json: JSON.parse(text) as Record<string, unknown>,
          });
        });
      },
    );
    req.on('error', reject);
    if (data !== undefined) req.write(data);
    req.end();
  });
}

beforeAll(async () => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db, MIGRATIONS);
  for (const user of Object.values(USERS)) {
    db.prepare(
      'INSERT INTO users (id, email, display_name, role, status) VALUES (?, ?, ?, ?, ?)',
    ).run(user.id, user.email, user.display_name, user.role, user.status);
  }
  db.prepare("INSERT INTO projects (id, slug, name, instructions) VALUES ('project-1', 'alpha', 'Alpha', '')").run();
  db.prepare(
    `INSERT INTO conversations (id, assistant_id, user_id, project_id, title, provider, native_session_id)
     VALUES ('member-chat', 1, 2, 'project-1', 'Member chat', 'claude', 'member-native')`,
  ).run();
  db.prepare(
    `INSERT INTO pages
      (id, slug, title, project_id, conversation_id, creator_user_id, size_bytes, updated_at, expires_at)
     VALUES
      ('owner-page', 'owner-page-slug', 'Owner page', 'project-1', NULL, 1, 123, '2026-07-23 12:00:00', datetime('now', '+1 day')),
      ('unknown-page', 'unknown-page-slug', 'Unknown page', NULL, NULL, NULL, 45, '2026-07-23 11:00:00', datetime('now', '+1 day'))`,
  ).run();

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = USERS[String(req.headers['x-test-user'] ?? 'owner')];
    next();
  });
  app.use(
    '/api/pages',
    createPagesRouter({
      db,
      config: {
        pages: {
          accountId: 'account',
          apiToken: 'secret',
          bucket: 'pages',
          publicBase: 'https://veneer.page',
        },
      },
    } as unknown as AppContext),
  );
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
  db.close();
});

describe('Pages routes', () => {
  it('keeps the shared list visible to members and identifies each creator', async () => {
    const response = await call('GET', '/api/pages', 'member');
    expect(response.status).toBe(200);
    expect(response.json.pages).toEqual([
      expect.objectContaining({
        id: 'owner-page',
        creator: { id: 1, displayName: 'Owner' },
        projectName: 'Alpha',
        pinOrder: null,
        url: 'https://veneer.page/p/owner-page-slug',
      }),
      expect.objectContaining({
        id: 'unknown-page',
        creator: { id: null, displayName: 'Unknown user' },
      }),
    ]);
  });

  it('attributes a new page to the authenticated publishing user', async () => {
    const upload = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    try {
      const response = await call('POST', '/api/pages', 'member', {
        title: 'Member page',
        html: '<!doctype html><title>Member page</title>',
        conversationId: 'member-chat',
      });
      expect(response.status).toBe(200);
      expect(response.json.page).toEqual(
        expect.objectContaining({
          title: 'Member page',
          creator: { id: 2, displayName: 'Member' },
          projectId: 'project-1',
          projectName: 'Alpha',
          expiresAt: expect.any(String),
        }),
      );
      const published = db
        .prepare("SELECT creator_user_id, expires_at > datetime('now', '+6 days') AS has_full_window FROM pages WHERE title = 'Member page'")
        .get();
      expect(published).toEqual({ creator_user_id: 2, has_full_window: 1 });
    } finally {
      upload.mockRestore();
    }
  });

  it('preserves the original creator when another user updates a page', async () => {
    const before = db.prepare("SELECT updated_at, expires_at FROM pages WHERE id = 'owner-page'").get();
    const response = await call('POST', '/api/pages', 'member', {
      pageId: 'owner-page',
      title: 'Updated owner page',
    });
    expect(response.status).toBe(200);
    expect(response.json.page).toEqual(
      expect.objectContaining({
        id: 'owner-page',
        title: 'Updated owner page',
        creator: { id: 1, displayName: 'Owner' },
      }),
    );
    expect(db.prepare("SELECT creator_user_id FROM pages WHERE id = 'owner-page'").get()).toEqual({
      creator_user_id: 1,
    });
    expect(db.prepare("SELECT updated_at, expires_at FROM pages WHERE id = 'owner-page'").get()).toEqual(before);
  });

  it('lists project groups in project order with pinned pages first and unfiled pages last', async () => {
    db.prepare(
      "INSERT INTO projects (id, slug, name, instructions, sort_order) VALUES ('project-2', 'beta', 'Beta', '', 1)",
    ).run();
    db.prepare(
      `INSERT INTO pages
        (id, slug, title, project_id, creator_user_id, pin_order, size_bytes, updated_at, expires_at)
       VALUES
        ('alpha-pinned', 'alpha-pinned-slug', 'Alpha pinned', 'project-1', 1, -5, 1, '2026-07-20 09:00:00', datetime('now', '+1 day')),
        ('beta-page', 'beta-page-slug', 'Beta page', 'project-2', 1, NULL, 1, '2026-07-29 13:00:00', datetime('now', '+1 day'))`,
    ).run();
    try {
      const response = await call('GET', '/api/pages');
      expect(response.status).toBe(200);
      const pages = response.json.pages as Array<{ id: string; projectId: string | null }>;
      const ids = pages.map((page) => page.id);
      const lastAlpha = Math.max(...pages.map((page, index) => (page.projectId === 'project-1' ? index : -1)));

      expect(ids[0]).toBe('alpha-pinned');
      expect(ids.indexOf('beta-page')).toBeGreaterThan(lastAlpha);
      expect(ids.indexOf('unknown-page')).toBeGreaterThan(ids.indexOf('beta-page'));
    } finally {
      db.prepare("DELETE FROM pages WHERE id IN ('alpha-pinned', 'beta-page')").run();
      db.prepare("DELETE FROM projects WHERE id = 'project-2'").run();
    }
  });

  it('persists pin and unpin changes and returns the new ordering', async () => {
    const pinned = await call('PATCH', '/api/pages/owner-page', 'member', { pinned: true });
    expect(pinned.status).toBe(200);
    expect(pinned.json.page).toEqual(
      expect.objectContaining({
        id: 'owner-page',
        pinOrder: expect.any(Number),
      }),
    );

    const listed = await call('GET', '/api/pages');
    const pages = listed.json.pages as Array<{ id: string }>;
    expect(pages[0]?.id).toBe('owner-page');
    expect(db.prepare("SELECT pin_order FROM pages WHERE id = 'owner-page'").get()).toEqual({
      pin_order: expect.any(Number),
    });

    const unpinned = await call('PATCH', '/api/pages/owner-page', 'member', { pinned: false });
    expect(unpinned.status).toBe(200);
    expect(unpinned.json.page).toEqual(expect.objectContaining({ id: 'owner-page', pinOrder: null }));
    expect(db.prepare("SELECT pin_order FROM pages WHERE id = 'owner-page'").get()).toEqual({ pin_order: null });
  });

  it('hides expired pages and rejects attempts to renew them after expiry', async () => {
    db.prepare(
      `INSERT INTO pages (id, slug, title, size_bytes, expires_at)
       VALUES ('expired-page', 'expired-page-slug', 'Expired page', 1, datetime('now', '-1 minute'))`,
    ).run();
    try {
      const listed = await call('GET', '/api/pages');
      expect((listed.json.pages as Array<{ id: string }>).some((page) => page.id === 'expired-page')).toBe(false);

      const update = await call('POST', '/api/pages', 'owner', {
        pageId: 'expired-page',
        title: 'Too late',
        html: '<!doctype html><title>Too late</title>',
      });
      expect(update.status).toBe(404);
    } finally {
      db.prepare("DELETE FROM pages WHERE id = 'expired-page'").run();
    }
  });
});
