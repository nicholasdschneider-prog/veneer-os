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
import { migrate } from '../src/db/migrate.js';
import { createApiRouter } from '../src/routes/api.js';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/db/migrations');

let server: Server;
let base: string;
let db: Database.Database;
let identityEmail = 'owner@example.com';
let ctx: AppContext;
let tempDir: string;
let currentClaudeBin: string;
let oldClaudeBin: string;

beforeAll(async () => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db, MIGRATIONS);
  db.prepare(
    `INSERT INTO users (email, display_name, role) VALUES
      ('owner@example.com', 'Owner', 'owner'),
      ('member@example.com', 'Member', 'member')`,
  ).run();
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-claude-preferences-'));
  currentClaudeBin = path.join(tempDir, 'claude-current');
  oldClaudeBin = path.join(tempDir, 'claude-old');
  fs.writeFileSync(currentClaudeBin, '#!/usr/bin/env node\nconsole.log("2.1.237 (Claude Code)");\n', { mode: 0o755 });
  fs.writeFileSync(oldClaudeBin, '#!/usr/bin/env node\nconsole.log("2.1.236 (Claude Code)");\n', { mode: 0o755 });
  ctx = {
    db,
    config: { claudeBin: currentClaudeBin, codexBin: '', grokBin: '' },
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
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('Claude Code preferences routes', () => {
  it('returns every provider runtime and clear unavailable versions', async () => {
    identityEmail = 'owner@example.com';
    const response = await fetch(`${base}/api/admin/provider-versions`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      versions: {
        claude: { runtime: 'Claude Code', version: '2.1.237', supportsConciseOutputStyle: true },
        openrouter: { runtime: 'Claude Code harness', version: '2.1.237' },
        codex: { runtime: 'Codex CLI', version: null },
        grok: { runtime: 'Grok CLI', version: null },
      },
    });
  });

  it('defaults to Default and persists Concise', async () => {
    identityEmail = 'owner@example.com';
    const initial = await fetch(`${base}/api/admin/claude/preferences`);
    expect(initial.status).toBe(200);
    await expect(initial.json()).resolves.toMatchObject({ preferences: { outputStyle: 'Default' } });

    const saved = await fetch(`${base}/api/admin/claude/preferences`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outputStyle: 'Concise' }),
    });
    expect(saved.status).toBe(200);
    await expect(saved.json()).resolves.toMatchObject({ preferences: { outputStyle: 'Concise' } });

    const reread = await fetch(`${base}/api/admin/claude/preferences`);
    await expect(reread.json()).resolves.toMatchObject({ preferences: { outputStyle: 'Concise' } });
  });

  it('rejects unknown output styles', async () => {
    identityEmail = 'owner@example.com';
    const response = await fetch(`${base}/api/admin/claude/preferences`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outputStyle: 'Explanatory' }),
    });
    expect(response.status).toBe(400);
  });

  it('rejects Concise when the installed Claude Code is too old', async () => {
    identityEmail = 'owner@example.com';
    ctx.config.claudeBin = oldClaudeBin;
    try {
      const response = await fetch(`${base}/api/admin/claude/preferences`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ outputStyle: 'Concise' }),
      });
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({
        error: 'Concise requires Claude Code 2.1.237 or newer.',
      });
    } finally {
      ctx.config.claudeBin = currentClaudeBin;
    }
  });

  it('keeps the preference administrator-only', async () => {
    identityEmail = 'member@example.com';
    const read = await fetch(`${base}/api/admin/claude/preferences`);
    const write = await fetch(`${base}/api/admin/claude/preferences`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outputStyle: 'Default' }),
    });
    expect(read.status).toBe(403);
    expect(write.status).toBe(403);
  });
});
