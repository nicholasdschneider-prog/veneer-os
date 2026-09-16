import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AppContext } from '../src/context.js';
import type { UserRow } from '../src/db/db.js';
import { createFilesRouter } from '../src/routes/files.js';

const USERS: Record<string, UserRow> = {
  member: { id: 3, email: 'm@x.com', display_name: 'M', role: 'member', created_at: '' },
  owner: { id: 2, email: 'o@x.com', display_name: 'O', role: 'owner', created_at: '' },
  consultant: { id: 1, email: 'c@x.com', display_name: 'C', role: 'consultant', created_at: '' },
};

let tmp: string;
let server: Server;
let base: string;
const projectRoots = new Map<string, { slug: string; root_dir: string | null }>();

beforeAll(async () => {
  // The 'data' root points at a throwaway temp dir — every test works inside it.
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-files-'));
  const ctx = {
    config: { dataDir: tmp, sourceDir: tmp },
    db: {
      prepare: () => ({
        get: (id: string) => projectRoots.get(id),
      }),
    },
  } as unknown as AppContext;
  const app = express();
  // Mirrors api.ts: /files/write carries whole text files and gets a higher limit.
  const jsonBody = express.json({ limit: '1mb' });
  const jsonBodyLarge = express.json({ limit: '8mb' });
  app.use((req, res, next) => (req.path === '/api/files/write' ? jsonBodyLarge : jsonBody)(req, res, next));
  app.use((req, _res, next) => {
    req.user = USERS[String(req.headers['x-test-user'] ?? 'member')];
    next();
  });
  app.use('/api/files', createFilesRouter(ctx));
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  for (const name of fs.readdirSync(tmp)) fs.rmSync(path.join(tmp, name), { recursive: true, force: true });
  projectRoots.clear();
});

async function call(method: string, url: string, user: string, body?: unknown) {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-test-user': user },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json().catch(() => null)) as Record<string, unknown> | null };
}

const q = (rel: string) => `root=data&path=${encodeURIComponent(rel)}`;

describe('files routes', () => {
  it('serves nested project Markdown images while retaining file-manager permissions', async () => {
    const folder = path.join(tmp, 'Crew Seating');
    fs.mkdirSync(folder);
    fs.writeFileSync(path.join(folder, 'report.md'), '![Shot](./shot.png)');
    fs.writeFileSync(path.join(folder, 'shot.png'), 'image bytes');
    projectRoots.set('crew', { slug: 'crew', root_dir: folder });
    const url = '/api/files/read?root=project:crew&path=report.md&image=.%2Fshot.png';
    expect((await call('GET', url, 'owner')).status).toBe(200);
    expect((await call('GET', url, 'member')).status).toBe(403);
    expect((await call('GET', url.replace('project:crew', 'project:other'), 'owner')).status).toBe(400);
  });
  it('denies members entirely', async () => {
    expect((await call('GET', '/api/files/roots', 'member')).status).toBe(403);
    expect((await call('GET', `/api/files/list?${q('')}`, 'member')).status).toBe(403);
    expect((await call('PUT', '/api/files/write', 'member', { root: 'data', path: 'a.txt', content: 'x' })).status).toBe(403);
  });

  it('lists the four named roots', async () => {
    const res = await call('GET', '/api/files/roots', 'owner');
    expect(res.status).toBe(200);
    const roots = res.json!.roots as { id: string; label: string; path: string }[];
    expect(roots.map((r) => r.id)).toEqual(['home', 'source', 'data', 'system']);
    expect(roots.find((r) => r.id === 'data')!.path).toBe(tmp);
    expect(roots.find((r) => r.id === 'system')!.path).toBe('/');
  });

  it('rejects traversal, absolute paths, embedded null bytes and unknown roots', async () => {
    expect((await call('GET', `/api/files/list?${q('../outside')}`, 'consultant')).status).toBe(400);
    expect((await call('GET', `/api/files/read?${q('a/../../etc/passwd')}`, 'consultant')).status).toBe(400);
    expect((await call('GET', `/api/files/read?${q('/etc/passwd')}`, 'consultant')).status).toBe(400);
    expect((await call('GET', `/api/files/read?${q('a\0b')}`, 'consultant')).status).toBe(400);
    expect((await call('PUT', '/api/files/write', 'consultant', { root: 'data', path: '../x', content: '' })).status).toBe(400);
    expect((await call('POST', '/api/files/mkdir', 'consultant', { root: 'nope', path: 'x' })).status).toBe(400);
    expect((await call('POST', '/api/files/delete', 'consultant', { root: 'data', path: '../x' })).status).toBe(400);
  });

  it('scopes project roots to default and custom project folders', async () => {
    const defaultDir = path.join(tmp, 'workspaces', 'projects', 'alpha');
    fs.mkdirSync(defaultDir, { recursive: true });
    fs.writeFileSync(path.join(defaultDir, 'default.txt'), 'default');
    projectRoots.set('default', { slug: 'alpha', root_dir: null });

    const listedDefault = await call(
      'GET',
      '/api/files/list?root=project%3Adefault&path=',
      'owner',
    );
    expect(listedDefault.status).toBe(200);
    expect((listedDefault.json!.entries as { name: string }[]).map((entry) => entry.name)).toEqual(['default.txt']);

    const customDir = path.join(tmp, 'custom-project');
    fs.mkdirSync(customDir);
    fs.writeFileSync(path.join(customDir, 'custom.txt'), 'custom');
    projectRoots.set('custom', { slug: 'ignored', root_dir: customDir });

    const readCustom = await call(
      'GET',
      '/api/files/read?root=project%3Acustom&path=custom.txt',
      'consultant',
    );
    expect(readCustom.status).toBe(200);
    expect(readCustom.json!.content).toBe('custom');

    expect((await call('GET', '/api/files/list?root=project%3Amissing&path=', 'owner')).status).toBe(400);
    expect((await call('GET', '/api/files/list?root=project%3Adefault&path=..', 'owner')).status).toBe(400);
    expect(
      (await call('POST', '/api/files/delete', 'owner', { root: 'project:default', path: '' })).status,
    ).toBe(400);
  });

  it('resolves project file links with locations and rejects unsafe targets', async () => {
    const projectDir = path.join(tmp, 'custom-project');
    fs.mkdirSync(path.join(projectDir, 'src'), { recursive: true });
    const filePath = path.join(projectDir, 'src', 'server.mjs');
    fs.writeFileSync(filePath, 'one\ntwo\n');
    projectRoots.set('custom', { slug: 'ignored', root_dir: projectDir });

    const resolved = await call(
      'GET',
      `/api/files/resolve-link?root=project%3Acustom&target=${encodeURIComponent(`${filePath}:2:3`)}`,
      'owner',
    );
    expect(resolved.status).toBe(200);
    expect(resolved.json!.file).toMatchObject({
      path: 'src/server.mjs',
      absolutePath: fs.realpathSync(filePath),
      line: 2,
      column: 3,
    });

    expect((await call(
      'GET',
      `/api/files/resolve-link?root=project%3Acustom&target=${encodeURIComponent('../outside.mjs')}`,
      'owner',
    )).status).toBe(403);
    expect((await call(
      'GET',
      `/api/files/resolve-link?root=project%3Acustom&target=${encodeURIComponent('missing.mjs')}`,
      'owner',
    )).status).toBe(404);
    const resolvedDir = await call(
      'GET',
      `/api/files/resolve-link?root=project%3Acustom&target=${encodeURIComponent(path.join(projectDir, 'src'))}`,
      'owner',
    );
    expect(resolvedDir.status).toBe(200);
    expect(resolvedDir.json!.file).toMatchObject({ kind: 'directory', path: 'src' });

    expect((await call(
      'GET',
      `/api/files/resolve-link?root=project%3Acustom&target=${encodeURIComponent('src/server.mjs')}`,
      'member',
    )).status).toBe(403);
  });

  it('lists a directory dirs-first, case-insensitive, symlinks classified by target', async () => {
    fs.mkdirSync(path.join(tmp, 'beta'));
    fs.mkdirSync(path.join(tmp, 'Gamma'));
    fs.writeFileSync(path.join(tmp, 'zeta.txt'), 'zz');
    fs.writeFileSync(path.join(tmp, 'Alpha.txt'), 'aaa');
    fs.symlinkSync(path.join(tmp, 'beta'), path.join(tmp, 'link-to-dir'));
    fs.symlinkSync(path.join(tmp, 'does-not-exist'), path.join(tmp, 'broken'));
    const res = await call('GET', `/api/files/list?${q('')}`, 'owner');
    expect(res.status).toBe(200);
    const entries = res.json!.entries as { name: string; kind: string; size: number | null; mtime: number | null }[];
    expect(entries.map((e) => e.name)).toEqual(['beta', 'Gamma', 'link-to-dir', 'Alpha.txt', 'broken', 'zeta.txt']);
    expect(entries.map((e) => e.kind)).toEqual(['dir', 'dir', 'dir', 'file', 'other', 'file']);
    const alpha = entries.find((e) => e.name === 'Alpha.txt')!;
    expect(alpha.size).toBe(3);
    expect(alpha.mtime).toBeTypeOf('number');
    const broken = entries.find((e) => e.name === 'broken')!;
    expect(broken.size).toBeNull();
    expect(broken.mtime).toBeNull();
  });

  it('404s listing a missing directory', async () => {
    const res = await call('GET', `/api/files/list?${q('nope')}`, 'owner');
    expect(res.status).toBe(404);
    expect(res.json).toEqual({ ok: false, error: 'not-found' });
  });

  it('round-trips write → read, including new-file creation and mtime echo', async () => {
    const wrote = await call('PUT', '/api/files/write', 'consultant', {
      root: 'data',
      path: 'notes.txt',
      content: 'hello files',
    });
    expect(wrote.status).toBe(200);
    expect(wrote.json!.mtime).toBeTypeOf('number');
    const read = await call('GET', `/api/files/read?${q('notes.txt')}`, 'consultant');
    expect(read.status).toBe(200);
    expect(read.json!.content).toBe('hello files');
    expect(read.json!.size).toBe('hello files'.length);
    expect(read.json!.mtime).toBe(wrote.json!.mtime);
    // A second write with the matching expectedMtime succeeds.
    const again = await call('PUT', '/api/files/write', 'consultant', {
      root: 'data',
      path: 'notes.txt',
      content: 'v2',
      expectedMtime: wrote.json!.mtime,
    });
    expect(again.status).toBe(200);
    expect((await call('GET', `/api/files/read?${q('notes.txt')}`, 'consultant')).json!.content).toBe('v2');
  });

  it('saves a file bigger than the default 1mb JSON body limit', async () => {
    // Anything readable (up to the 2 MiB read cap) must also be writable.
    const content = 'x'.repeat(1_500_000);
    const wrote = await call('PUT', '/api/files/write', 'owner', { root: 'data', path: 'big.txt', content });
    expect(wrote.status).toBe(200);
    const read = await call('GET', `/api/files/read?${q('big.txt')}`, 'owner');
    expect(read.status).toBe(200);
    expect((read.json!.content as string).length).toBe(content.length);
  });

  it('409s a write when expectedMtime no longer matches', async () => {
    fs.writeFileSync(path.join(tmp, 'shared.txt'), 'first');
    const mtime = fs.statSync(path.join(tmp, 'shared.txt')).mtimeMs;
    const res = await call('PUT', '/api/files/write', 'owner', {
      root: 'data',
      path: 'shared.txt',
      content: 'second',
      expectedMtime: mtime - 5000,
    });
    expect(res.status).toBe(409);
    expect(res.json!.error).toBe('conflict');
    expect(res.json!.mtime).toBe(mtime);
    expect(fs.readFileSync(path.join(tmp, 'shared.txt'), 'utf8')).toBe('first');
  });

  it('400s a write into a missing parent directory', async () => {
    const res = await call('PUT', '/api/files/write', 'owner', {
      root: 'data',
      path: 'missing/dir/f.txt',
      content: 'x',
    });
    expect(res.status).toBe(400);
    expect(res.json!.error).toBe('no-parent');
  });

  it('415s reading a binary file', async () => {
    fs.writeFileSync(path.join(tmp, 'blob.bin'), Buffer.from([0x89, 0x50, 0x00, 0x0a, 0x41]));
    const res = await call('GET', `/api/files/read?${q('blob.bin')}`, 'owner');
    expect(res.status).toBe(415);
    expect(res.json!.error).toBe('binary');
    expect(res.json!.size).toBe(5);
  });

  it('413s reading a file over 2 MB', async () => {
    const size = 2 * 1024 * 1024 + 1;
    fs.writeFileSync(path.join(tmp, 'big.txt'), Buffer.alloc(size, 0x61));
    const res = await call('GET', `/api/files/read?${q('big.txt')}`, 'owner');
    expect(res.status).toBe(413);
    expect(res.json!.error).toBe('too-large');
    expect(res.json!.size).toBe(size);
  });

  it('404s reading a missing file', async () => {
    const res = await call('GET', `/api/files/read?${q('nope.txt')}`, 'owner');
    expect(res.status).toBe(404);
    expect(res.json).toEqual({ ok: false, error: 'not-found' });
  });

  it('mkdirs recursively', async () => {
    const res = await call('POST', '/api/files/mkdir', 'consultant', { root: 'data', path: 'a/b/c' });
    expect(res.status).toBe(200);
    expect(fs.statSync(path.join(tmp, 'a/b/c')).isDirectory()).toBe(true);
  });

  it('renames, and 409s when the target exists', async () => {
    fs.writeFileSync(path.join(tmp, 'one.txt'), '1');
    fs.writeFileSync(path.join(tmp, 'two.txt'), '2');
    const clash = await call('POST', '/api/files/rename', 'owner', { root: 'data', from: 'one.txt', to: 'two.txt' });
    expect(clash.status).toBe(409);
    expect(clash.json!.error).toBe('exists');
    const ok = await call('POST', '/api/files/rename', 'owner', { root: 'data', from: 'one.txt', to: 'three.txt' });
    expect(ok.status).toBe(200);
    expect(fs.existsSync(path.join(tmp, 'one.txt'))).toBe(false);
    expect(fs.readFileSync(path.join(tmp, 'three.txt'), 'utf8')).toBe('1');
  });

  it('refuses deleting a non-empty dir without recursive, allows it with', async () => {
    fs.mkdirSync(path.join(tmp, 'full'));
    fs.writeFileSync(path.join(tmp, 'full', 'f.txt'), 'x');
    const refused = await call('POST', '/api/files/delete', 'consultant', { root: 'data', path: 'full' });
    expect(refused.status).toBe(400);
    expect(refused.json!.error).toBe('not-empty');
    const ok = await call('POST', '/api/files/delete', 'consultant', { root: 'data', path: 'full', recursive: true });
    expect(ok.status).toBe(200);
    expect(fs.existsSync(path.join(tmp, 'full'))).toBe(false);
  });

  it('refuses deleting the root itself', async () => {
    expect((await call('POST', '/api/files/delete', 'owner', { root: 'data', path: '' })).status).toBe(400);
    expect((await call('POST', '/api/files/delete', 'owner', { root: 'data', path: '.' })).status).toBe(400);
    expect(fs.existsSync(tmp)).toBe(true);
  });

  it('unlinks a symlink without following it', async () => {
    fs.mkdirSync(path.join(tmp, 'target'));
    fs.writeFileSync(path.join(tmp, 'target', 'keep.txt'), 'safe');
    fs.symlinkSync(path.join(tmp, 'target'), path.join(tmp, 'ln'));
    const res = await call('POST', '/api/files/delete', 'owner', { root: 'data', path: 'ln' });
    expect(res.status).toBe(200);
    expect(fs.existsSync(path.join(tmp, 'ln'))).toBe(false);
    expect(fs.readFileSync(path.join(tmp, 'target', 'keep.txt'), 'utf8')).toBe('safe');
  });
});
