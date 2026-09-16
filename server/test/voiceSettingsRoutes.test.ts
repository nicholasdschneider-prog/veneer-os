import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import Database from 'better-sqlite3';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppContext } from '../src/context.js';
import { migrate } from '../src/db/migrate.js';
import { createApiRouter } from '../src/routes/api.js';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/db/migrations');

let server: Server;
let base: string;
let db: Database.Database;
let identityEmail = 'owner@example.com';

beforeAll(async () => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db, MIGRATIONS);
  db.prepare(
    `INSERT INTO users (email, display_name, role) VALUES
      ('owner@example.com', 'Owner', 'owner'),
      ('member@example.com', 'Member', 'member')`,
  ).run();

  const ctx = {
    db,
    resolveIdentity: async () => ({ email: identityEmail }),
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

describe('voice settings routes', () => {
  it('returns the default Soniox vocabulary hints', async () => {
    identityEmail = 'owner@example.com';
    const response = await fetch(`${base}/api/admin/voice-settings`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      settings: {
        vocabularyTerms: expect.arrayContaining(['Veneer Pro', 'Codex', 'Soniox']),
      },
    });
  });

  it('persists vocabulary hints', async () => {
    const saved = await fetch(`${base}/api/admin/voice-settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vocabularyTerms: ['Veneer Pro', 'Acme'] }),
    });
    expect(saved.status).toBe(200);
    await expect(saved.json()).resolves.toMatchObject({
      settings: { vocabularyTerms: ['Veneer Pro', 'Acme'] },
    });
  });

  it('rejects invalid vocabulary hints', async () => {
    for (const vocabularyTerms of [
      ['this phrase is longer than twenty characters'],
      Array.from({ length: 51 }, (_, index) => `term-${index}`),
    ]) {
      const invalid = await fetch(`${base}/api/admin/voice-settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vocabularyTerms }),
      });
      expect(invalid.status).toBe(400);
    }
  });

  it('keeps voice settings admin-only', async () => {
    identityEmail = 'member@example.com';
    const read = await fetch(`${base}/api/admin/voice-settings`);
    const write = await fetch(`${base}/api/admin/voice-settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vocabularyTerms: [] }),
    });
    expect(read.status).toBe(403);
    expect(write.status).toBe(403);
  });
});

describe('retired voice agent routes', () => {
  it.each([
    ['GET', '/voice-agent'],
    ['GET', '/admin/voice-agent-settings'],
    ['PUT', '/admin/voice-agent-settings'],
    ['GET', '/admin/voice-agent-voices'],
    ['GET', '/admin/voice-agent-preview?voice=Maya'],
  ])('returns 404 for %s %s', async (method, route) => {
    identityEmail = 'owner@example.com';
    const response = await fetch(`${base}/api${route}`, { method });
    expect(response.status).toBe(404);
  });
});
