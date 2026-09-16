import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import Database from 'better-sqlite3';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppContext } from '../src/context.js';
import { migrate } from '../src/db/migrate.js';
import { createApiRouter } from '../src/routes/api.js';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/db/migrations');

let server: Server;
let base: string;
let db: Database.Database;
let identityEmail = 'owner@example.com';
let appPublicOrigin = 'https://client-one.veneer.app';
// Null models a machine with no authenticated Doppler CLI, where the access
// policy must report 'none' instead of advertising a vault.
let projectDopplerCli: { binDir: string; configDir: string; userHome: string } | null =
  { binDir: '/tmp/project-cli', configDir: '/tmp/.doppler', userHome: '/tmp' };
const clearTokens = vi.fn();

beforeAll(async () => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db, MIGRATIONS);
  db.prepare(
    `INSERT INTO users (email, display_name, role) VALUES
      ('owner@example.com', 'Owner', 'owner'),
      ('consultant@example.com', 'Consultant', 'consultant'),
      ('member@example.com', 'Member', 'member')`,
  ).run();
  db.prepare('INSERT INTO settings (key, value_json) VALUES (?, ?)').run(
    'doppler_connection',
    JSON.stringify({
      project: 'client-one',
      config: 'prd',
      connectedAt: '2026-07-28T12:00:00.000Z',
      runtimeConfigured: true,
      agentConfigured: true,
    }),
  );

  const ctx = {
    config: {
      get appPublicOrigin() {
        return appPublicOrigin;
      },
    },
    db,
    resolveIdentity: async () => ({ email: identityEmail }),
    manager: { statusOf: async () => 'idle' },
    get projectDopplerCli() {
      return projectDopplerCli;
    },
    dopplerTokens: {
      get: () => ({
        runtimeToken: 'dp.st.runtime-must-not-leak',
        agentToken: 'dp.st.agent-must-not-leak',
        connectedAt: '2026-07-28T12:00:00.000Z',
      }),
      clear: clearTokens,
    },
    doppler: {
      status: () => ({
        configured: true,
        healthy: true,
        project: 'client-one',
        config: 'prd',
        lastCheckedAt: '2026-07-28T12:05:00.000Z',
        error: null,
      }),
      refresh: vi.fn(async () => ({
        configured: false,
        healthy: false,
        project: null,
        config: null,
        lastCheckedAt: '2026-07-28T12:05:00.000Z',
        error: null,
      })),
    },
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

beforeEach(() => {
  identityEmail = 'owner@example.com';
  projectDopplerCli = { binDir: '/tmp/project-cli', configDir: '/tmp/.doppler', userHome: '/tmp' };
  appPublicOrigin = 'https://client-one.veneer.app';
  clearTokens.mockClear();
  db.prepare("DELETE FROM settings WHERE key = 'doppler_agent_guidance'").run();
});

describe('Doppler settings routes', () => {
  it('returns only masked connection health to owners and consultants', async () => {
    for (const email of ['owner@example.com', 'consultant@example.com']) {
      identityEmail = email;
      const response = await fetch(`${base}/api/admin/doppler`);
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).not.toContain('runtime-must-not-leak');
      expect(text).not.toContain('agent-must-not-leak');
      expect(JSON.parse(text)).toMatchObject({
        connection: {
          connected: true,
          project: 'client-one',
          config: 'prd',
          access: {
            mode: 'main_full',
            label: 'Full workplace access',
            locked: true,
          },
          additionalGuidance: '',
          runtime: { configured: true, healthy: true },
          agent: { configured: true },
        },
      });
    }
  });

  it('lets only owners save extra guidance and returns it on later reads', async () => {
    const save = await fetch(`${base}/api/admin/doppler/guidance`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ additionalGuidance: '  Use the client vendor account.  ' }),
    });
    expect(save.status).toBe(200);
    expect(await save.json()).toMatchObject({
      connection: { additionalGuidance: 'Use the client vendor account.' },
    });

    const read = await fetch(`${base}/api/admin/doppler`);
    expect(await read.json()).toMatchObject({
      connection: { additionalGuidance: 'Use the client vendor account.' },
    });

    for (const email of ['consultant@example.com', 'member@example.com']) {
      identityEmail = email;
      const denied = await fetch(`${base}/api/admin/doppler/guidance`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ additionalGuidance: 'Change the rule.' }),
      });
      expect(denied.status).toBe(403);
    }
  });

  it('rejects attempts to change the locked access mode through guidance settings', async () => {
    const response = await fetch(`${base}/api/admin/doppler/guidance`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        additionalGuidance: 'Keep client access.',
        accessMode: 'main_full',
      }),
    });
    expect(response.status).toBe(400);

    const read = await fetch(`${base}/api/admin/doppler`);
    expect(await read.json()).toMatchObject({
      connection: {
        access: { mode: 'main_full', locked: true },
        additionalGuidance: '',
      },
    });
  });

  it('reports a not-connected access mode when there is no authenticated Doppler CLI', async () => {
    projectDopplerCli = null;
    const response = await fetch(`${base}/api/admin/doppler`);
    const body = await response.json() as { connection: { access: { mode: string; label: string; safetyGuidance: string } } };
    expect(body.connection.access.mode).toBe('none');
    expect(body.connection.access.label).toBe('Doppler not connected');
    expect(body.connection.access.safetyGuidance).toContain('Doppler is not connected');
    expect(body.connection.access.safetyGuidance).not.toContain('full Doppler access');
  });

  it('keeps connection status and mutations unavailable to members', async () => {
    identityEmail = 'member@example.com';
    const read = await fetch(`${base}/api/admin/doppler`);
    const test = await fetch(`${base}/api/admin/doppler/test`, { method: 'POST' });
    const guidance = await fetch(`${base}/api/admin/doppler/guidance`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ additionalGuidance: 'Not allowed.' }),
    });
    const disconnect = await fetch(`${base}/api/admin/doppler`, { method: 'DELETE' });
    expect(read.status).toBe(403);
    expect(test.status).toBe(403);
    expect(guidance.status).toBe(403);
    expect(disconnect.status).toBe(403);
    expect(clearTokens).not.toHaveBeenCalled();
  });
});
