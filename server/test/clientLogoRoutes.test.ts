import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import Database from 'better-sqlite3';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppContext } from '../src/context.js';
import { clientLogoPath } from '../src/clientLogo.js';
import { migrate } from '../src/db/migrate.js';
import { createApiRouter } from '../src/routes/api.js';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/db/migrations');
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+X2NDWQAAAABJRU5ErkJggg==',
  'base64',
);

let server: Server;
let base: string;
let db: Database.Database;
let dataDir: string;
let identityEmail: string | null = 'owner@example.com';

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'veneer-client-logo-'));
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db, MIGRATIONS);
  db.prepare(
    `INSERT INTO users (email, display_name, role) VALUES
      ('owner@example.com', 'Owner', 'owner'),
      ('consultant@example.com', 'Consultant', 'consultant'),
      ('member@example.com', 'Member', 'member')`,
  ).run();

  const ctx = {
    db,
    config: { dataDir },
    resolveIdentity: async () => (identityEmail ? { email: identityEmail } : null),
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
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('client logo routes', () => {
  it('requires an authenticated identity for the shared logo', async () => {
    identityEmail = null;
    const response = await fetch(`${base}/api/client-logo`);
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: 'No identity' });
  });

  it('reports that no logo is configured', async () => {
    identityEmail = 'owner@example.com';
    const response = await fetch(`${base}/api/admin/client-logo`);
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: 'No client logo configured' });

    identityEmail = 'member@example.com';
    const sharedResponse = await fetch(`${base}/api/client-logo`);
    expect(sharedResponse.status).toBe(404);
    await expect(sharedResponse.json()).resolves.toMatchObject({ error: 'No client logo configured' });
  });

  it('keeps logo management admin-only', async () => {
    identityEmail = 'member@example.com';
    const read = await fetch(`${base}/api/admin/client-logo`);
    const write = await fetch(`${base}/api/admin/client-logo`, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/png' },
      body: PNG,
    });
    const remove = await fetch(`${base}/api/admin/client-logo`, { method: 'DELETE' });
    expect(read.status).toBe(403);
    expect(write.status).toBe(403);
    expect(remove.status).toBe(403);
  });

  it('rejects unsupported content and oversized uploads', async () => {
    identityEmail = 'owner@example.com';
    const wrongType = await fetch(`${base}/api/admin/client-logo`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: PNG,
    });
    expect(wrongType.status).toBe(415);

    const invalidPng = await fetch(`${base}/api/admin/client-logo`, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/png' },
      body: Buffer.from('not a png'),
    });
    expect(invalidPng.status).toBe(400);

    const oversized = await fetch(`${base}/api/admin/client-logo`, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/png' },
      body: Buffer.alloc(2 * 1024 * 1024 + 1, 0x89),
    });
    expect(oversized.status).toBe(413);
    await expect(oversized.json()).resolves.toMatchObject({ error: 'Logo exceeds the 2 MB upload limit' });
  });

  it('lets a consultant atomically save, read, and remove the shared logo', async () => {
    identityEmail = 'consultant@example.com';
    const saved = await fetch(`${base}/api/admin/client-logo`, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/png' },
      body: PNG,
    });
    expect(saved.status).toBe(200);
    expect(fs.readFileSync(clientLogoPath(dataDir))).toEqual(PNG);
    expect(fs.readdirSync(path.dirname(clientLogoPath(dataDir)))).toEqual(['client-logo.png']);

    identityEmail = 'owner@example.com';
    const read = await fetch(`${base}/api/admin/client-logo`);
    expect(read.status).toBe(200);
    expect(read.headers.get('content-type')).toContain('image/png');
    expect(read.headers.get('cache-control')).toBe('private, no-store');
    expect(Buffer.from(await read.arrayBuffer())).toEqual(PNG);

    identityEmail = 'member@example.com';
    const memberRead = await fetch(`${base}/api/client-logo`);
    expect(memberRead.status).toBe(200);
    expect(memberRead.headers.get('content-type')).toContain('image/png');
    expect(memberRead.headers.get('cache-control')).toBe('private, no-store');
    expect(Buffer.from(await memberRead.arrayBuffer())).toEqual(PNG);

    identityEmail = 'consultant@example.com';
    const removed = await fetch(`${base}/api/admin/client-logo`, { method: 'DELETE' });
    expect(removed.status).toBe(200);
    expect(fs.existsSync(clientLogoPath(dataDir))).toBe(false);
  });
});
