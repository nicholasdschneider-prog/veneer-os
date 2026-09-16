import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import Database from 'better-sqlite3';
import express, { type Request } from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import type { AppContext } from '../src/context.js';
import { createApiRouter } from '../src/routes/api.js';
import { callProjectTool } from '../src/mcp/projectTools.js';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/db/migrations');

let server: Server;
let base: string;
let db: Database.Database;
let tmpDir: string;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-project-root-'));
  expect(path.relative(os.homedir(), tmpDir).startsWith('..')).toBe(true);

  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db, MIGRATIONS);
  db.prepare(
    `INSERT INTO users (email, display_name, role)
     VALUES ('owner@example.com', 'Owner', 'owner'),
            ('member@example.com', 'Member', 'member'),
            ('consultant@example.com', 'Consultant', 'consultant'),
            ('pending@example.com', 'Pending', 'member'),
            ('disabled@example.com', 'Disabled', 'member')`,
  ).run();

  db.prepare("UPDATE users SET status = 'pending' WHERE email = 'pending@example.com'").run();
  db.prepare("UPDATE users SET status = 'disabled' WHERE email = 'disabled@example.com'").run();

  const ctx = {
    db,
    config: { dataDir: path.join(tmpDir, 'data') } as AppContext['config'],
    resolveIdentity: async (req: Request) => req.headers['x-test-user'] === 'anonymous' ? null : ({
      email: `${req.headers['x-test-user'] ?? 'owner'}@example.com`,
    }),
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
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function createProject(rootDir: string, user = 'owner'): Promise<Response> {
  return fetch(`${base}/api/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-test-user': user },
    body: JSON.stringify({ name: `Project ${crypto.randomUUID()}`, rootDir }),
  });
}

describe('project root folder', () => {
  it.each(['owner', 'consultant', 'member'])('allows %s to choose a folder outside the service home', async (role) => {
    const rootDir = path.join(tmpDir, `${role}-external-project`);
    const response = await createProject(rootDir, role);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ project: { rootDir, folder: rootDir } });
    expect(fs.statSync(rootDir).isDirectory()).toBe(true);
  });

  it('returns the exact resolved folder for a managed project workspace', async () => {
    const response = await fetch(`${base}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Managed Project' }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      project: {
        slug: 'managed-project',
        rootDir: null,
        folder: path.join(tmpDir, 'data', 'workspaces', 'projects', 'managed-project'),
      },
    });
  });

  it.each(['owner', 'member'])('rejects a relative folder for %s', async (role) => {
    const response = await createProject('relative/project', role);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: 'Folder must be an absolute path' });
  });

  it('lets members browse directories while omitting files and hidden folders', async () => {
    const browseRoot = path.join(tmpDir, 'browse');
    fs.mkdirSync(path.join(browseRoot, 'visible'), { recursive: true });
    fs.mkdirSync(path.join(browseRoot, '.hidden'));
    fs.writeFileSync(path.join(browseRoot, 'file.txt'), 'fixture');
    const response = await fetch(`${base}/api/fs/dirs?path=${encodeURIComponent(browseRoot)}`, {
      headers: { 'x-test-user': 'member' },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      path: browseRoot, parent: tmpDir,
      dirs: [{ name: 'visible', path: path.join(browseRoot, 'visible') }],
    });
  });

  it('rejects invalid browsing paths for members', async () => {
    for (const folder of ['relative/path', path.join(tmpDir, 'missing')]) {
      const response = await fetch(`${base}/api/fs/dirs?path=${encodeURIComponent(folder)}`, {
        headers: { 'x-test-user': 'member' },
      });
      expect(response.status).toBe(400);
    }
  });

  it('rejects a file as a member project folder without creating a project', async () => {
    const file = path.join(tmpDir, 'not-a-folder');
    fs.writeFileSync(file, 'fixture');
    const before = db.prepare('SELECT COUNT(*) AS n FROM projects').get();
    expect((await createProject(file, 'member')).status).toBe(400);
    expect(db.prepare('SELECT COUNT(*) AS n FROM projects').get()).toEqual(before);
    expect(fs.readFileSync(file, 'utf8')).toBe('fixture');
  });

  it('uses an existing folder from the native member create_project tool', async () => {
    const folder = path.join(tmpDir, 'native-member-project');
    fs.mkdirSync(folder);
    fs.writeFileSync(path.join(folder, 'existing.txt'), 'keep me');
    const result = await callProjectTool({
      name: 'create_project', args: { name: 'Native Member', root_dir: folder },
      callApi: async (route, init) => {
        const response = await fetch(`${base}${route}`, {
          ...init, headers: { 'Content-Type': 'application/json', 'x-test-user': 'member' },
        });
        expect(response.status).toBe(200);
        return response.json();
      },
    });
    expect(result?.content[0]?.text).toContain(`Folder: ${folder}`);
    expect(fs.readFileSync(path.join(folder, 'existing.txt'), 'utf8')).toBe('keep me');
  });

  it.each(['pending', 'disabled', 'unknown', 'anonymous'])('denies %s creation and browsing', async (user) => {
    const folder = path.join(tmpDir, `${user}-denied`);
    const creation = await createProject(folder, user);
    expect([401, 403]).toContain(creation.status);
    expect(fs.existsSync(folder)).toBe(false);
    const browsing = await fetch(`${base}/api/fs/dirs?path=${encodeURIComponent(tmpDir)}`, {
      headers: { 'x-test-user': user },
    });
    expect([401, 403]).toContain(browsing.status);
  });
});
