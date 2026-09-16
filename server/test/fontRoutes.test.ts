import http, { type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import express from 'express';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppContext } from '../src/context.js';
import { migrate } from '../src/db/migrate.js';
import type { UserRow } from '../src/db/db.js';
import { createPagesRouter } from '../src/routes/pages.js';

/**
 * Routes for the uploaded font library (Settings → Appearance → Fonts). R2 is
 * stubbed at the fetch layer: what matters here is the gate, the validation,
 * and the row/URL the caller gets back.
 */

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/db/migrations');

const USERS: Record<string, UserRow> = {
  owner: {
    id: 1, email: 'owner@example.com', display_name: 'Owner', role: 'owner',
    status: 'active', created_at: '', last_seen_at: null,
  },
  member: {
    id: 2, email: 'member@example.com', display_name: 'Member', role: 'member',
    status: 'active', created_at: '', last_seen_at: null,
  },
};

let db: Database.Database;
let server: Server;
let base: string;
// A second app whose config has no Cloudflare credentials. The router reads
// ctx.config once when it is created, so this needs its own server.
let unconfiguredServer: Server;
let unconfiguredBase: string;

function woff2(size = 64): Buffer {
  return Buffer.concat([Buffer.from('wOF2', 'ascii'), Buffer.alloc(size)]);
}

interface JsonResponse {
  status: number;
  json: Record<string, unknown>;
}

function call(
  method: string,
  pathname: string,
  options: { user?: string; body?: Buffer; contentType?: string; origin?: string } = {},
): Promise<JsonResponse> {
  const { user = 'owner', body, contentType = 'application/octet-stream', origin } = options;
  return new Promise((resolve, reject) => {
    const req = http.request(
      `${origin ?? base}${pathname}`,
      {
        method,
        headers: {
          'x-test-user': user,
          ...(body ? { 'content-type': contentType, 'content-length': String(body.length) } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            json: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>,
          }),
        );
      },
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

beforeAll(async () => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db, MIGRATIONS);
  for (const user of Object.values(USERS)) {
    db.prepare('INSERT INTO users (id, email, display_name, role, status) VALUES (?, ?, ?, ?, ?)').run(
      user.id, user.email, user.display_name, user.role, user.status,
    );
  }

  const appFor = (config: Record<string, unknown>): express.Express => {
    const app = express();
    app.use((req, _res, next) => {
      req.user = USERS[String(req.headers['x-test-user'] ?? 'owner')];
      next();
    });
    app.use('/api/pages', createPagesRouter({ db, config } as unknown as AppContext));
    return app;
  };

  const configured = appFor({
    pages: { accountId: 'account', apiToken: 'secret', bucket: 'pages', publicBase: 'https://veneer.page' },
  });
  await new Promise<void>((resolve) => {
    server = configured.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  await new Promise<void>((resolve) => {
    unconfiguredServer = appFor({}).listen(0, '127.0.0.1', resolve);
  });
  unconfiguredBase = `http://127.0.0.1:${(unconfiguredServer.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
  unconfiguredServer.close();
  db.close();
});

beforeEach(() => {
  db.prepare('DELETE FROM page_fonts').run();
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify({ success: true }), { status: 200 }),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

const UPLOAD = '/api/pages/fonts?family=Harman%20Sans&weight=400&style=normal&fileName=Harman-Sans.woff2';

describe('font routes', () => {
  it('starts empty and reports that hosting is configured', async () => {
    const res = await call('GET', '/api/pages/fonts');
    expect(res.status).toBe(200);
    expect(res.json.fonts).toEqual([]);
    expect(res.json.configured).toBe(true);
  });

  it('stores an upload under f/ and returns its public URL', async () => {
    const res = await call('POST', UPLOAD, { body: woff2() });
    expect(res.status).toBe(200);
    const font = res.json.font as Record<string, unknown>;
    expect(font.family).toBe('Harman Sans');
    expect(font.weight).toBe('400');
    expect(font.contentType).toBe('font/woff2');
    expect(font.sizeBytes).toBe(68);
    expect(String(font.objectKey)).toMatch(/^f\/[0-9a-f]{16}\/Harman-Sans\.woff2$/);
    expect(String(font.publicUrl)).toBe(`https://veneer.page/${String(font.objectKey)}`);

    const list = await call('GET', '/api/pages/fonts');
    expect(list.json.fonts).toHaveLength(1);
  });

  it('refuses a member', async () => {
    const res = await call('POST', UPLOAD, { user: 'member', body: woff2() });
    expect(res.status).toBe(403);
    expect(await call('GET', '/api/pages/fonts').then((r) => r.json.fonts)).toEqual([]);
  });

  it('rejects a file that is not a font', async () => {
    const wrongType = await call(
      'POST',
      '/api/pages/fonts?family=X&weight=400&style=normal&fileName=evil.svg',
      { body: woff2() },
    );
    expect(wrongType.status).toBe(415);

    const wrongBytes = await call('POST', UPLOAD, {
      body: Buffer.from('<html>not a font</html>'),
    });
    expect(wrongBytes.status).toBe(400);
    expect(String(wrongBytes.json.error)).toMatch(/not a valid \.woff2 font/);
  });

  it('rejects an upload with no family name', async () => {
    const res = await call(
      'POST',
      '/api/pages/fonts?weight=400&style=normal&fileName=Harman-Sans.woff2',
      { body: woff2() },
    );
    expect(res.status).toBe(400);
  });

  it('rejects an empty body', async () => {
    const res = await call('POST', UPLOAD);
    expect(res.status).toBe(400);
  });

  it('deletes the R2 object and the row', async () => {
    const created = await call('POST', UPLOAD, { body: woff2() });
    const id = String((created.json.font as Record<string, unknown>).id);

    const res = await call('DELETE', `/api/pages/fonts/${id}`);
    expect(res.status).toBe(200);
    expect(await call('GET', '/api/pages/fonts').then((r) => r.json.fonts)).toEqual([]);

    const deleteCall = vi.mocked(globalThis.fetch).mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === 'DELETE',
    );
    expect(deleteCall).toBeTruthy();
  });

  it('404s when deleting an unknown font', async () => {
    expect(await call('DELETE', '/api/pages/fonts/nope').then((r) => r.status)).toBe(404);
  });

  it('explains itself instead of failing when publishing is not configured', async () => {
    const list = await call('GET', '/api/pages/fonts', { origin: unconfiguredBase });
    expect(list.status).toBe(200);
    expect(list.json.configured).toBe(false);

    const upload = await call('POST', UPLOAD, { origin: unconfiguredBase, body: woff2() });
    expect(upload.status).toBe(503);
  });
});
