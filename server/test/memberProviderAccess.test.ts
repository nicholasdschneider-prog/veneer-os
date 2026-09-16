import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import Database from 'better-sqlite3';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AppContext } from '../src/context.js';
import { migrate } from '../src/db/migrate.js';
import { createApiRouter } from '../src/routes/api.js';

let server: Server;
let base: string;
let db: Database.Database;
let identityEmail: string | null = 'member@example.com';
const usage = vi.fn(async () => ({ snapshots: [], accounts: [] }));
const provider = { connected: true, windows: [], planType: null, capturedAt: null, source: null, error: null };

beforeAll(async () => {
  db = new Database(':memory:');
  migrate(db, path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/db/migrations'));
  db.prepare(`INSERT INTO users (email, display_name, role, status) VALUES
    ('member@example.com', 'Member', 'member', 'active'),
    ('owner@example.com', 'Owner', 'owner', 'active'),
    ('consultant@example.com', 'Consultant', 'consultant', 'active'),
    ('pending@example.com', 'Pending', 'member', 'pending'),
    ('disabled@example.com', 'Disabled', 'member', 'disabled')`).run();
  const app = express();
  app.use('/api', createApiRouter({
    db,
    config: {},
    resolveIdentity: async () => identityEmail ? { email: identityEmail } : null,
    manager: {
      usage,
      listModels: async () => [
        { id: 'model-1', label: 'Model One' },
      ],
    },
    secrets: { status: () => ({ connected: true }), listClaudeAccounts: () => [] },
    codexUsage: { read: async () => provider },
    grokUsage: { read: async () => provider },
    openRouterUsage: { read: async () => ({ connected: true, summary: { todayUsd: 1 } }) },
  } as unknown as AppContext));
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});

afterAll(() => { server.close(); db.close(); });

describe('member provider viewing permissions', () => {
  it.each(['member', 'owner', 'consultant'])('lets %s read usage and refresh with the existing probe limit', async (role) => {
    identityEmail = `${role}@example.com`;
    const response = await fetch(`${base}/usage`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ providers: { claude: { connected: true }, codex: provider, grok: provider } });
    expect(usage).toHaveBeenLastCalledWith(Number.MAX_SAFE_INTEGER);
    expect((await fetch(`${base}/usage?refresh=1`)).status).toBe(200);
    expect(usage).toHaveBeenLastCalledWith(15_000);
  });

  it('lets members read model preferences, model lists, and the system meter', async () => {
    identityEmail = 'member@example.com';
    for (const route of ['/model-prefs', '/models?provider=claude', '/models?provider=codex', '/models?provider=grok', '/models?provider=openrouter', '/system/usage']) {
      expect((await fetch(`${base}${route}`)).status, route).toBe(200);
    }
  });


  it.each([
    ['PUT', '/model-prefs'],
    ['POST', '/admin/claude/accounts/account-1/activate'],
    ['POST', '/admin/claude/accounts/account-1/limit-reset'],
    ['PATCH', '/admin/claude/accounts/account-1'],
    ['DELETE', '/admin/claude/accounts/account-1'],
    ['POST', '/admin/claude/connect/start'],
    ['POST', '/admin/codex/connect/start'],
    ['POST', '/admin/grok/connect/start'],
    ['GET', '/admin/api-keys'],
    ['PUT', '/admin/claude/preferences'],
  ])('still rejects member %s %s', async (method, route) => {
    identityEmail = 'member@example.com';
    expect((await fetch(`${base}${route}`, { method })).status).toBe(403);
  });

  it.each(['pending@example.com', 'disabled@example.com', 'unknown@example.com', null])('rejects inactive or absent identity %s', async (email) => {
    identityEmail = email;
    const response = await fetch(`${base}/usage`);
    expect([401, 403]).toContain(response.status);
  });
});
