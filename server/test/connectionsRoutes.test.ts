import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import Database from 'better-sqlite3';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import type { AppContext } from '../src/context.js';
import type { ConnectionRow, UserRow } from '../src/db/db.js';
import { createConnectionsRouter } from '../src/routes/connections.js';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/db/migrations');

const USERS: Record<string, UserRow> = {
  member: { id: 3, email: 'm@x.com', display_name: 'M', role: 'member', created_at: '' },
  owner: { id: 2, email: 'o@x.com', display_name: 'O', role: 'owner', created_at: '' },
  consultant: { id: 1, email: 'c@x.com', display_name: 'C', role: 'consultant', created_at: '' },
};

let db: Database.Database;
let server: Server;
let base: string;

beforeAll(async () => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db, MIGRATIONS);
  const ctx = { db } as AppContext;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = USERS[String(req.headers['x-test-user'] ?? 'member')];
    next();
  });
  app.use('/api/connections', createConnectionsRouter(ctx));
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
  db.close();
});

beforeEach(() => {
  db.prepare('DELETE FROM connections').run();
});

async function call(method: string, url: string, user: string, body?: unknown) {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-test-user': user },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json().catch(() => null)) as Record<string, unknown> | null };
}

const MCP_BODY = {
  name: 'Shopify',
  config: { transport: 'stdio', command: 'npx', args: ['shopify-mcp'], env: { TOKEN: 'sekret-value' } },
  policy: { default: 'approve', rules: [] },
};

describe('connections route authorization', () => {
  it('denies members entirely', async () => {
    expect((await call('GET', '/api/connections', 'member')).status).toBe(403);
    expect((await call('POST', '/api/connections', 'member', MCP_BODY)).status).toBe(403);
  });

  it('lets a consultant create, and never returns the secret', async () => {
    const created = await call('POST', '/api/connections', 'consultant', MCP_BODY);
    expect(created.status).toBe(200);
    const conn = created.json!.connection as Record<string, unknown>;
    expect((conn.config as { env: Record<string, string> }).env).toEqual({ TOKEN: '' }); // masked
    expect(conn.hasSecrets).toBe(true);
    expect(conn.managedBy).toBe('consultant');
    // The raw secret is stored but never serialized over the API.
    expect(JSON.stringify(created.json)).not.toContain('sekret-value');
  });

  it('forces owner-created connections to managed_by=owner', async () => {
    const created = await call('POST', '/api/connections', 'owner', MCP_BODY);
    expect((created.json!.connection as { managedBy: string }).managedBy).toBe('owner');
  });

  it('lets an owner edit owner-managed but not consultant-managed connections', async () => {
    const owned = await call('POST', '/api/connections', 'owner', MCP_BODY);
    const ownedId = (owned.json!.connection as { id: number }).id;
    const consult = await call('POST', '/api/connections', 'consultant', { ...MCP_BODY, name: 'NetSuite' });
    const consultId = (consult.json!.connection as { id: number }).id;

    expect((await call('PATCH', `/api/connections/${ownedId}`, 'owner', { enabled: false })).status).toBe(200);
    expect((await call('PATCH', `/api/connections/${consultId}`, 'owner', { enabled: false })).status).toBe(403);
    expect((await call('DELETE', `/api/connections/${consultId}`, 'owner')).status).toBe(403);
    // Consultant can edit anything.
    expect((await call('PATCH', `/api/connections/${consultId}`, 'consultant', { enabled: false })).status).toBe(200);
  });

  it('keeps a stored secret when the update sends a blank value', async () => {
    const created = await call('POST', '/api/connections', 'consultant', MCP_BODY);
    const id = (created.json!.connection as { id: number }).id;
    // Send back the masked config (TOKEN blank) — the stored secret must survive.
    await call('PATCH', `/api/connections/${id}`, 'consultant', {
      config: { transport: 'stdio', command: 'npx', args: ['shopify-mcp'], env: { TOKEN: '' } },
    });
    const row = db.prepare('SELECT * FROM connections WHERE id = ?').get(id) as ConnectionRow;
    expect(JSON.parse(row.config_json).env.TOKEN).toBe('sekret-value');
  });

  it('replaces a secret when a new value is provided', async () => {
    const created = await call('POST', '/api/connections', 'consultant', MCP_BODY);
    const id = (created.json!.connection as { id: number }).id;
    await call('PATCH', `/api/connections/${id}`, 'consultant', {
      config: { transport: 'stdio', command: 'npx', args: ['shopify-mcp'], env: { TOKEN: 'new-value' } },
    });
    const row = db.prepare('SELECT * FROM connections WHERE id = ?').get(id) as ConnectionRow;
    expect(JSON.parse(row.config_json).env.TOKEN).toBe('new-value');
  });
  it('rejects the retired custom-skill config shape', async () => {
    const created = await call('POST', '/api/connections', 'consultant', {
      name: 'Refunds',
      config: { content: '# hi' },
    });
    expect(created.status).toBe(400);
  });
});
