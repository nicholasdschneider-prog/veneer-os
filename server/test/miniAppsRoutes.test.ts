import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import express from 'express';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AppContext } from '../src/context.js';
import { migrate } from '../src/db/migrate.js';
import type { LocalAppRunnerClient } from '../src/miniApps/localClient.js';
import { createMiniAppsRouter } from '../src/routes/miniApps.js';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/db/migrations');
const SOURCE = 'export function handle() { return new Response("ok"); }';

let db: Database.Database;
let server: Server;
let base: string;
let appRunner: LocalAppRunnerClient;
let role: 'owner' | 'consultant' | 'member' = 'owner';

beforeAll(async () => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db, MIGRATIONS);
  appRunner = {
    deploy: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
    statuses: vi.fn(async (ids) =>
      Object.fromEntries(ids.map((id) => [id, { status: 'running' as const, error: null, pid: 123 }])),
    ),
  };

  const app = express();
  app.use(express.json());
  // The real /api router authenticates before mounting this one, so every
  // request arrives with req.user set.
  app.use((req, _res, next) => {
    req.user = {
      id: 1,
      email: 'user@example.com',
      display_name: 'User',
      role,
      status: 'active',
      created_at: '2026-01-01T00:00:00.000Z',
      last_seen_at: null,
    };
    next();
  });
  app.use(
    '/api/apps',
    createMiniAppsRouter({
      db,
      config: {
        appPublicOrigin: 'https://local.veneer.app',
      },
      appRunner,
    } as unknown as AppContext),
  );
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
});

afterEach(() => {
  role = 'owner';
});

async function publish(body: Record<string, unknown>): Promise<{ response: Response; json: Record<string, any> }> {
  const response = await fetch(`${base}/api/apps`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { response, json: (await response.json()) as Record<string, any> };
}

describe('Mini App runtime selection', () => {
  it('defaults database rows and new API publishes to Cloudflare', async () => {
    db.prepare(
      `INSERT INTO mini_apps
        (id, slug, title, source_text, source_size_bytes, script_name, status)
       VALUES ('migration-default', 'migration-default', 'Default', ?, ?, 'migration-default-script', 'deployed')`,
    ).run(SOURCE, Buffer.byteLength(SOURCE));
    expect(db.prepare("SELECT runtime FROM mini_apps WHERE id = 'migration-default'").get()).toEqual({
      runtime: 'cloudflare',
    });

    const { response, json } = await publish({ title: 'Cloud default', slug: 'cloud-default', source: SOURCE });
    expect(response.status).toBe(503);
    expect(json.message).toContain('Cloudflare app hosting is not configured');
  });

  it('publishes locally and preserves that runtime when an update omits it', async () => {
    const created = await publish({ title: 'Local tool', slug: 'local-api-tool', source: SOURCE, runtime: 'local' });
    expect(created.response.status).toBe(200);
    expect(created.json.app).toEqual(
      expect.objectContaining({
        runtime: 'local',
        status: 'deployed',
        url: 'https://local.veneer.app/tools/local-api-tool/',
      }),
    );
    const appId = String(created.json.app.id);
    expect(appRunner.deploy).toHaveBeenCalledWith(appId);

    const updated = await publish({ appId, title: 'Updated local tool' });
    expect(updated.response.status).toBe(200);
    expect(updated.json.app.runtime).toBe('local');
    expect(db.prepare('SELECT runtime, title FROM mini_apps WHERE id = ?').get(appId)).toEqual({
      runtime: 'local',
      title: 'Updated local tool',
    });

    const listed = (await fetch(`${base}/api/apps`).then((response) => response.json())) as Record<string, any>;
    expect(listed.hosting).toEqual({ cloudflare: false, local: true });
    expect(listed.apps).toContainEqual(
      expect.objectContaining({
        id: appId,
        runtime: 'local',
        runtimeStatus: { status: 'running', error: null, pid: 123 },
      }),
    );
  });
});

describe('Mini App management is owner/consultant only', () => {
  const MEMBER_APP = 'member-gate-app';

  beforeAll(() => {
    db.prepare(
      `INSERT INTO mini_apps
        (id, slug, title, source_text, source_size_bytes, script_name, runtime, status)
       VALUES (?, 'member-gate', 'Member gate', ?, ?, 'member-gate-script', 'local', 'deployed')`,
    ).run(MEMBER_APP, SOURCE, Buffer.byteLength(SOURCE));
  });

  it('rejects publish, replace, and delete from a member', async () => {
    role = 'member';

    const created = await publish({ title: 'Member tool', slug: 'member-tool', source: SOURCE, runtime: 'local' });
    expect(created.response.status).toBe(403);
    expect(created.json.error).toMatch(/owners and consultants/);
    expect(db.prepare("SELECT 1 FROM mini_apps WHERE slug = 'member-tool'").get()).toBeUndefined();

    const replaced = await publish({ appId: MEMBER_APP, title: 'Hijacked' });
    expect(replaced.response.status).toBe(403);
    expect(db.prepare('SELECT title FROM mini_apps WHERE id = ?').get(MEMBER_APP)).toEqual({ title: 'Member gate' });

    const deleted = await fetch(`${base}/api/apps/${MEMBER_APP}`, { method: 'DELETE' });
    expect(deleted.status).toBe(403);
    expect(db.prepare('SELECT 1 FROM mini_apps WHERE id = ?').get(MEMBER_APP)).toBeTruthy();
    expect(appRunner.remove).not.toHaveBeenCalled();
  });

  it('still lets a member list apps', async () => {
    role = 'member';
    const response = await fetch(`${base}/api/apps`);
    expect(response.status).toBe(200);
    const listed = (await response.json()) as Record<string, any>;
    expect(listed.apps.some((app: { id: string }) => app.id === MEMBER_APP)).toBe(true);
  });

  it('lets a consultant delete', async () => {
    role = 'consultant';
    const response = await fetch(`${base}/api/apps/${MEMBER_APP}`, { method: 'DELETE' });
    expect(response.status).toBe(200);
    expect(db.prepare('SELECT 1 FROM mini_apps WHERE id = ?').get(MEMBER_APP)).toBeUndefined();
  });
});
