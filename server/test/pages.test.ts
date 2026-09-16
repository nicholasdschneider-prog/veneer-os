import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import Database from 'better-sqlite3';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppContext } from '../src/context.js';
import { migrate } from '../src/db/migrate.js';
import { createPagesRouter } from '../src/routes/pages.js';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/db/migrations');

let server: Server;
let base: string;
let db: Database.Database;

beforeAll(async () => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db, MIGRATIONS);

  const ctx = { db, config: {} } as unknown as AppContext;
  const app = express();
  app.use('/api/pages', createPagesRouter(ctx));
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
  db.close();
});

describe('pages route', () => {
  it('DELETE removes a persisted page from subsequent listings', async () => {
    db.prepare("INSERT INTO pages (id, slug, title, size_bytes) VALUES ('page-1', 'public-slug', 'Launch page', 123)").run();

    const deleted = await fetch(`${base}/api/pages/page-1`, { method: 'DELETE' });
    expect(deleted.status).toBe(200);
    await expect(deleted.json()).resolves.toMatchObject({ ok: true });

    const listed = await fetch(`${base}/api/pages`);
    expect(listed.status).toBe(200);
    await expect(listed.json()).resolves.toMatchObject({ pages: [] });
  });

  it('returns 404 when the page does not exist', async () => {
    const response = await fetch(`${base}/api/pages/missing`, { method: 'DELETE' });
    expect(response.status).toBe(404);
  });
});
