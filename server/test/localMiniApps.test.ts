import http, { type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppContext } from '../src/context.js';
import { migrate } from '../src/db/migrate.js';
import { createLocalMiniAppsRouter } from '../src/routes/localMiniApps.js';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/db/migrations');

let db: Database.Database;
let ingress: Server;
let runner: Server;
let ingressBase: string;
let captured: { path: string; headers: http.IncomingHttpHeaders } | undefined;

beforeAll(async () => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db, MIGRATIONS);
  db.prepare(
    "INSERT INTO users (id, email, display_name, role, status) VALUES (1, 'owner@example.com', 'Owner', 'owner', 'active')",
  ).run();
  db.prepare(
    `INSERT INTO mini_apps
      (id, slug, title, source_text, source_size_bytes, script_name, runtime, status)
     VALUES
      ('local-app-1', 'local-tool', 'Local tool', 'export function handle() {}', 27, 'local-script', 'local', 'deployed')`,
  ).run();

  runner = http.createServer((req, res) => {
    captured = { path: req.url ?? '', headers: req.headers };
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><body>proxied locally</body>');
  });
  await new Promise<void>((resolve) => runner.listen(0, '127.0.0.1', resolve));
  const runnerPort = (runner.address() as AddressInfo).port;

  const app = express();
  app.use(
    '/tools',
    createLocalMiniAppsRouter({
      db,
      config: {
        appPublicOrigin: 'https://local.veneer.app',
        appRunnerPort: runnerPort,
      },
      appRunner: {},
      resolveIdentity: async () => ({ email: 'owner@example.com' }),
    } as unknown as AppContext),
  );
  await new Promise<void>((resolve) => {
    ingress = app.listen(0, '127.0.0.1', resolve);
  });
  ingressBase = `http://127.0.0.1:${(ingress.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await Promise.all([
    new Promise<void>((resolve) => ingress.close(() => resolve())),
    new Promise<void>((resolve) => runner.close(() => resolve())),
  ]);
  db.close();
});

describe('local Mini App ingress', () => {
  it('proxies stable tool URLs and strips infrastructure credentials', async () => {
    const response = await fetch(`${ingressBase}/tools/local-tool/records?limit=4`, {
      headers: {
        cookie: 'theme=dark; CF_Authorization=access-secret; mode=compact',
        'cf-access-jwt-assertion': 'access-secret',
        'cf-access-client-id': 'client-id',
        'cf-access-client-secret': 'client-secret',
        'x-vp-agent-token': 'agent-secret',
        'x-veneer-app-id': 'spoofed-app',
        'x-veneer-tenant': 'spoofed-tenant',
      },
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('proxied locally');
    expect(captured?.path).toBe('/apps/local-app-1/records?limit=4');
    expect(captured?.headers['x-veneer-app-id']).toBe('local-app-1');
    expect(captured?.headers['x-veneer-tenant']).toBe('local');
    expect(captured?.headers.cookie).toBe('theme=dark; mode=compact');
    expect(captured?.headers).not.toHaveProperty('cf-access-jwt-assertion');
    expect(captured?.headers).not.toHaveProperty('cf-access-client-id');
    expect(captured?.headers).not.toHaveProperty('cf-access-client-secret');
    expect(captured?.headers).not.toHaveProperty('x-vp-agent-token');
  });

  it('returns not found for Cloudflare-hosted and unknown slugs', async () => {
    db.prepare(
      `INSERT INTO mini_apps
        (id, slug, title, source_text, source_size_bytes, script_name, runtime, status)
       VALUES
        ('cloud-app-1', 'cloud-tool', 'Cloud tool', 'export function handle() {}', 27, 'cloud-script', 'cloudflare', 'deployed')`,
    ).run();

    const cloud = await fetch(`${ingressBase}/tools/cloud-tool/`);
    const missing = await fetch(`${ingressBase}/tools/missing/`);
    expect(cloud.status).toBe(404);
    expect(missing.status).toBe(404);
  });
});
