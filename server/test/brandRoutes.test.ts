import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AppContext } from '../src/context.js';
import { migrate } from '../src/db/migrate.js';
import { EMPTY_BRAND, PAGE_BRAND_KEY } from '../src/pages/brand.js';
import { createApiRouter } from '../src/routes/api.js';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/db/migrations');

let server: Server;
let base: string;
let db: Database.Database;
let identityEmail = 'owner@example.com';

async function call(
  method: 'GET' | 'PUT',
  pathname: '/api/brand' | '/api/pages/brand',
  body?: Record<string, unknown>,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

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

beforeEach(() => {
  identityEmail = 'owner@example.com';
  db.prepare('DELETE FROM settings WHERE key = ?').run(PAGE_BRAND_KEY);
});

afterAll(() => {
  server.close();
  db.close();
});

describe('site brand routes', () => {
  it('returns the full default brand from canonical and legacy paths', async () => {
    for (const pathname of ['/api/brand', '/api/pages/brand'] as const) {
      const response = await call('GET', pathname);
      expect(response.status).toBe(200);
      expect(response.json.brand).toEqual(EMPTY_BRAND);
    }
  });

  it('round-trips colors and applyToApp across both route paths', async () => {
    const brand = {
      primaryColor: '#123',
      accentColor: '#456789',
      backgroundColor: '#abcdef',
      font: 'Inter',
      headingFont: 'Playfair Display',
      notes: 'Keep it quiet.',
      applyToApp: false,
    };
    const saved = await call('PUT', '/api/brand', brand);
    const legacyRead = await call('GET', '/api/pages/brand');
    expect(saved.status).toBe(200);
    expect(saved.json.brand).toEqual(brand);
    expect(legacyRead.status).toBe(200);
    expect(legacyRead.json.brand).toEqual(brand);

    const legacySaved = await call('PUT', '/api/pages/brand', {
      ...brand,
      accentColor: '#654321',
      applyToApp: true,
    });
    const canonicalRead = await call('GET', '/api/brand');
    expect(legacySaved.status).toBe(200);
    expect(canonicalRead.json.brand).toMatchObject({
      accentColor: '#654321',
      applyToApp: true,
    });
  });

  it('keeps writes admin-only on canonical and legacy paths', async () => {
    identityEmail = 'member@example.com';
    for (const pathname of ['/api/brand', '/api/pages/brand'] as const) {
      const response = await call('PUT', pathname, { primaryColor: '#123' });
      expect(response.status).toBe(403);
    }
  });

  it('rejects invalid colors on canonical and legacy paths', async () => {
    for (const pathname of ['/api/brand', '/api/pages/brand'] as const) {
      const response = await call('PUT', pathname, { accentColor: '#abcd' });
      expect(response.status).toBe(400);
    }
  });

  it('defaults applyToApp to true for legacy stored rows', async () => {
    db.prepare('INSERT INTO settings (key, value_json) VALUES (?, ?)').run(
      PAGE_BRAND_KEY,
      JSON.stringify({ accentColor: '#abc', font: 'Site Sans' }),
    );
    for (const pathname of ['/api/brand', '/api/pages/brand'] as const) {
      const response = await call('GET', pathname);
      expect(response.status).toBe(200);
      expect(response.json.brand).toMatchObject({
        accentColor: '#abc',
        font: 'Site Sans',
        applyToApp: true,
      });
    }
  });

  it('treats a row with only applyToApp as unset', async () => {
    db.prepare('INSERT INTO settings (key, value_json) VALUES (?, ?)').run(
      PAGE_BRAND_KEY,
      JSON.stringify({ applyToApp: false }),
    );
    const response = await call('GET', '/api/brand');
    expect(response.status).toBe(200);
    expect(response.json.brand).toEqual(EMPTY_BRAND);
  });
});
