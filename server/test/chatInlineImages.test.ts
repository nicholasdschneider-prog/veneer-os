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
import { linkedFilePaths } from '../src/providers/fileScan.js';
import { createApiRouter } from '../src/routes/api.js';

let server: Server;
let base: string;
let db: Database.Database;
let root: string;
let imagePath: string;
let otherPath: string;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZY0AAAAASUVORK5CYII=', 'base64');

beforeAll(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vp-chat-images-')));
  imagePath = path.join(root, 'outline with spaces.png');
  otherPath = path.join(root, 'unlisted.png');
  fs.writeFileSync(imagePath, png);
  fs.writeFileSync(otherPath, png);
  fs.writeFileSync(path.join(root, 'report.md'), '![Nested](./unlisted.png)');
  fs.writeFileSync(path.join(root, 'old.png'), png);
  fs.utimesSync(path.join(root, 'old.png'), new Date(0), new Date(0));
  fs.symlinkSync(otherPath, path.join(root, 'unlisted-alias.png'));
  db = new Database(':memory:');
  migrate(db, path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/db/migrations'));
  db.prepare("INSERT INTO users (id, email, display_name, role) VALUES (1, 'owner@example.com', 'Owner', 'owner'), (2, 'member@example.com', 'Member', 'member')").run();
  db.prepare(`INSERT INTO conversations (id, assistant_id, user_id, visibility, title, provider, native_session_id, created_at)
    VALUES ('private', 1, 1, 'private', 'Private', 'codex', 'private-session', datetime('now', '-1 hour')),
           ('team', 1, 1, 'team', 'Team', 'codex', 'team-session', datetime('now', '-1 hour'))`).run();
  const ctx = {
    db,
    resolveIdentity: async (req: express.Request) => req.headers['x-test-email'] ? { email: String(req.headers['x-test-email']) } : null,
    manager: {
      listSessionFiles: async () => linkedFilePaths(`![Wrong-layer outline](${imagePath})\n![Old](${root}/old.png)\n[Report](${root}/report.md)`, root)
        .map((filePath) => ({ path: filePath, source: 'bash' as const })),
    },
  } as unknown as AppContext;
  const app = express();
  app.use('/api', createApiRouter(ctx));
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server?.close();
  db?.close();
  fs.rmSync(root, { recursive: true, force: true });
});

function request(chat: string, target: string, email: string | null = 'owner@example.com') {
  return fetch(`${base}/api/conversations/${chat}/files/content?path=${encodeURIComponent(target)}&inline=1`, {
    headers: email ? { 'x-test-email': email } : {},
  });
}

describe('authenticated inline chat images', () => {
  it('serves nested images only to readers of the detected report', async () => {
    const url = (chat: string) => `${base}/api/conversations/${chat}/files/content?path=${encodeURIComponent(path.join(root, 'report.md'))}&image=.%2Funlisted.png`;
    const owner = await fetch(url('private'), { headers: { 'x-test-email': 'owner@example.com' } });
    expect(owner.status).toBe(200);
    expect(Buffer.from(await owner.arrayBuffer())).toEqual(png);
    expect((await fetch(url('private'))).status).toBe(403);
    expect((await fetch(url('private'), { headers: { 'x-test-email': 'member@example.com' } })).status).toBe(404);
    expect((await fetch(url('team'), { headers: { 'x-test-email': 'member@example.com' } })).status).toBe(200);
  });
  it('serves exact detected PNG bytes and MIME type, including paths with spaces', async () => {
    const response = await request('private', imagePath);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await response.arrayBuffer())).toEqual(png);
  });

  it('requires identity and preserves Private and Team chat visibility', async () => {
    expect((await request('private', imagePath, null)).status).toBe(403);
    expect((await request('private', imagePath, 'member@example.com')).status).toBe(404);
    expect((await request('team', imagePath, 'member@example.com')).status).toBe(200);
    expect((await request('missing-chat', imagePath)).status).toBe(404);
  });

  it('rejects unlisted files, directories, traversal, symlinks, missing files, and old heuristic matches', async () => {
    for (const target of [
      otherPath, root, `${root}/../${path.basename(root)}/unlisted.png`,
      `${root}/unlisted-alias.png`, `${root}/missing.png`, `${root}/old.png`,
      `${imagePath}\0.png`, '/etc/passwd',
    ]) {
      expect((await request('private', target)).status, target).toBe(404);
    }
  });
});
