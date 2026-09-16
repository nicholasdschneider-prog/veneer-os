import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import Database from 'better-sqlite3';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import type { AppContext } from '../src/context.js';
import type { UserRow } from '../src/db/db.js';
import type { CreatedFileRef } from '../src/providers/types.js';
import { ensureFileSyncBackfill } from '../src/files/generatedFiles.js';
import { createGeneratedFilesRouter } from '../src/routes/generatedFiles.js';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/db/migrations');

const USERS: Record<string, UserRow> = {
  owner: { id: 2, email: 'o@x.com', display_name: 'O', role: 'owner', created_at: '' },
  member: { id: 3, email: 'm@x.com', display_name: 'M', role: 'member', created_at: '' },
};

let db: Database.Database;
let ctx: AppContext;
let server: Server;
let base: string;
let rootDir: string; // temp workspace on disk
let workDir: string; // where deliverables live
let sourceDir: string; // the platform-dev source checkout (excluded)

// Per-test control over what the runner "detects" for each conversation, plus a
// log of which conversations were actually scanned (to prove the high-water mark).
let sessionFiles: Record<string, CreatedFileRef[]> = {};
let listCalls: string[] = [];

const manager = {
  listSessionFiles: async (id: string): Promise<CreatedFileRef[]> => {
    listCalls.push(id);
    return sessionFiles[id] ?? [];
  },
} as unknown as AppContext['manager'];

function insertConversation(
  id: string,
  userId: number,
  projectId: string | null,
  visibility: 'team' | 'private' = 'team',
): void {
  // created_at/last_active_at an hour in the past so a "fresh" file (now) clears
  // the bash mtime gate and a later bump of last_active_at re-marks it stale.
  db.prepare(
    `INSERT INTO conversations
      (id, assistant_id, user_id, visibility, project_id, title, provider, native_session_id, created_at, last_active_at)
     VALUES (?, 1, ?, ?, ?, ?, 'claude', ?, datetime('now','-1 hour'), datetime('now','-1 hour'))`,
  ).run(id, userId, visibility, projectId, `Chat ${id}`, `sess-${id}`);
}

/** Write a real file under workDir and return its absolute path. */
function makeFile(name: string, content = 'hello', mtime?: Date): string {
  const p = path.join(workDir, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  if (mtime) fs.utimesSync(p, mtime, mtime);
  return p;
}

beforeAll(async () => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-gen-'));
  workDir = path.join(rootDir, 'work');
  sourceDir = path.join(rootDir, 'src-checkout');
  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(sourceDir, { recursive: true });

  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db, MIGRATIONS);

  ctx = { db, config: { dataDir: rootDir, sourceDir }, manager } as unknown as AppContext;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = USERS[String(req.headers['x-test-user'] ?? 'owner')];
    next();
  });
  app.use('/api/generated-files', createGeneratedFilesRouter(ctx));
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
  db.close();
  fs.rmSync(rootDir, { recursive: true, force: true });
});

beforeEach(() => {
  db.prepare('DELETE FROM generated_files').run();
  db.prepare('DELETE FROM conversations').run();
  db.prepare('DELETE FROM projects').run();
  db.prepare('DELETE FROM users').run();
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(workDir, { recursive: true });
  for (const u of Object.values(USERS)) {
    db.prepare('INSERT INTO users (id, email, display_name, role) VALUES (?, ?, ?, ?)').run(
      u.id,
      u.email,
      u.display_name,
      u.role,
    );
  }
  db.prepare("INSERT INTO projects (id, slug, name) VALUES ('p1', 'sales', 'Sales')").run();
  sessionFiles = {};
  listCalls = [];
});

async function call(method: string, url: string, user = 'owner') {
  const res = await fetch(`${base}${url}`, { method, headers: { 'x-test-user': user } });
  return { status: res.status, json: (await res.json().catch(() => null)) as Record<string, unknown> | null };
}

/** Run the background sweep to completion — GET / only kicks it off. */
async function settle(): Promise<void> {
  await ensureFileSyncBackfill(ctx);
}

interface View {
  id: string;
  name: string;
  path: string;
  conversationId: string | null;
  conversationTitle: string | null;
  projectId: string | null;
  projectName: string | null;
}

describe('generated-files route', () => {
  it('authenticates nested Markdown images using the report, without requiring an image registry entry', async () => {
    insertConversation('c-owner', 2, null, 'private');
    const report = makeFile('Crew Seating/report.md', '![Shot](./shot.png)');
    makeFile('Crew Seating/shot.png', 'image bytes');
    sessionFiles['c-owner'] = [{ path: report, source: 'write' }];
    await settle();
    const files = (await call('GET', '/api/generated-files', 'owner')).json!.files as View[];
    expect(files).toHaveLength(1);
    const url = `/api/generated-files/${files[0].id}/preview?image=.%2Fshot.png`;
    expect((await call('GET', url, 'owner')).status).toBe(200);
    expect((await call('GET', url, 'member')).status).toBe(404);
  });
  it('sweeps stale conversations in the background, returns joined views, and honours the high-water mark', async () => {
    insertConversation('c-owner', 2, 'p1');
    const p = makeFile('report.csv');
    sessionFiles['c-owner'] = [{ path: p, source: 'write' }];

    // The list responds immediately from the (empty) registry and only kicks
    // off the sweep — it must not block on the transcript scan.
    const first = await call('GET', '/api/generated-files', 'owner');
    expect(first.status).toBe(200);

    await settle();
    const settled = await call('GET', '/api/generated-files', 'owner');
    expect(settled.status).toBe(200);
    const files = settled.json!.files as View[];
    expect(files).toHaveLength(1);
    expect(files[0].name).toBe('report.csv');
    expect(files[0].conversationId).toBe('c-owner');
    expect(files[0].conversationTitle).toBe('Chat c-owner');
    expect(files[0].projectName).toBe('Sales');
    expect(listCalls).toContain('c-owner');
    expect(settled.json!.pendingSync).toBe(0);

    // Nothing has changed since the sweep, so another sweep re-scans nothing.
    listCalls = [];
    await settle();
    expect(listCalls).not.toContain('c-owner');

    // Activity bumps last_active_at past the high-water mark → re-scan.
    db.prepare("UPDATE conversations SET last_active_at = datetime('now') WHERE id = 'c-owner'").run();
    listCalls = [];
    await settle();
    expect(listCalls).toContain('c-owner');
  });

  it('excludes a bash ref older than the chat, includes a write ref', async () => {
    insertConversation('c-owner', 2, null);
    const oldP = makeFile('stale.csv', 'old', new Date(Date.now() - 2 * 3600_000)); // 2h ago < created_at (1h ago)
    const freshP = makeFile('fresh.csv', 'new'); // mtime now
    sessionFiles['c-owner'] = [
      { path: oldP, source: 'bash' },
      { path: freshP, source: 'write' },
    ];
    await settle();
    const res = await call('GET', '/api/generated-files', 'owner');
    const names = (res.json!.files as View[]).map((f) => f.name);
    expect(names).toEqual(['fresh.csv']);
  });

  it('canonically excludes source, Claude, dependency, and upload refs', async () => {
    insertConversation('c-owner', 2, null);
    const good = makeFile('deliverable.csv');
    const srcFile = path.join(sourceDir, 'edited.csv');
    fs.writeFileSync(srcFile, 'x');
    const sourceAlias = path.join(workDir, 'source-alias.csv');
    fs.symlinkSync(srcFile, sourceAlias);
    const claudeFile = makeFile('.claude/settings.csv');
    const dependencyFile = makeFile('node_modules/pkg/generated.csv');
    const uploadFile = path.join(rootDir, 'uploads', 'incoming.csv');
    fs.mkdirSync(path.dirname(uploadFile), { recursive: true });
    fs.writeFileSync(uploadFile, 'input');
    sessionFiles['c-owner'] = [
      { path: good, source: 'write' },
      { path: srcFile, source: 'write' },
      { path: sourceAlias, source: 'write' },
      { path: claudeFile, source: 'write' },
      { path: dependencyFile, source: 'write' },
      { path: uploadFile, source: 'bash' },
    ];
    await settle();
    const res = await call('GET', '/api/generated-files', 'owner');
    const names = (res.json!.files as View[]).map((f) => f.name);
    expect(names).toEqual(['deliverable.csv']);
  });

  it('keeps a shared path owned by the newest conversation during a full rescan', async () => {
    insertConversation('c-older', 2, null);
    insertConversation('c-newer', 2, null);
    db.prepare("UPDATE conversations SET last_active_at = datetime('now','-30 minutes') WHERE id = 'c-older'").run();
    db.prepare("UPDATE conversations SET last_active_at = datetime('now','-10 minutes') WHERE id = 'c-newer'").run();
    const shared = makeFile('shared-report.pdf');
    sessionFiles['c-older'] = [{ path: shared, source: 'bash' }];
    sessionFiles['c-newer'] = [{ path: shared, source: 'bash' }];

    await settle();

    expect(listCalls.slice(0, 2)).toEqual(['c-newer', 'c-older']);
    expect(db.prepare('SELECT conversation_id FROM generated_files WHERE path = ?').get(fs.realpathSync(shared))).toEqual({
      conversation_id: 'c-newer',
    });
  });

  it('prunes the row when the file is deleted from disk', async () => {
    insertConversation('c-owner', 2, null);
    const p = makeFile('temp.csv');
    sessionFiles['c-owner'] = [{ path: p, source: 'write' }];
    await settle();
    expect((await call('GET', '/api/generated-files', 'owner')).json!.files).toHaveLength(1);

    fs.rmSync(p);
    const res = await call('GET', '/api/generated-files', 'owner');
    expect(res.json!.files).toHaveLength(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM generated_files').get()).toEqual({ n: 0 });
  });

  it('shows Team chat files to everyone and hides Private chat files from other users', async () => {
    insertConversation('c-owner', 2, null);
    insertConversation('c-member', 3, null);
    insertConversation('c-private-owner', 2, null, 'private');
    const ownerFile = makeFile('owner.csv');
    const memberFile = makeFile('member.csv');
    const privateOwnerFile = makeFile('private-owner.csv');
    sessionFiles['c-owner'] = [{ path: ownerFile, source: 'write' }];
    sessionFiles['c-member'] = [{ path: memberFile, source: 'write' }];
    sessionFiles['c-private-owner'] = [{ path: privateOwnerFile, source: 'write' }];

    await settle();
    const asOwner = (await call('GET', '/api/generated-files', 'owner')).json!.files as View[];
    expect(asOwner.map((f) => f.name).sort()).toEqual(['member.csv', 'owner.csv', 'private-owner.csv']);

    const asMember = (await call('GET', '/api/generated-files', 'member')).json!.files as View[];
    expect(asMember.map((f) => f.name).sort()).toEqual(['member.csv', 'owner.csv']);
  });

  it('404s a member on another user’s Private chat file (download + delete)', async () => {
    insertConversation('c-owner', 2, null, 'private');
    const p = makeFile('secret.csv');
    sessionFiles['c-owner'] = [{ path: p, source: 'write' }];
    await settle();
    const files = (await call('GET', '/api/generated-files', 'owner')).json!.files as View[];
    const id = files[0].id;

    expect((await call('GET', `/api/generated-files/${id}/download`, 'member')).status).toBe(404);
    expect((await call('DELETE', `/api/generated-files/${id}`, 'member')).status).toBe(404);
    // Untouched on disk + in the registry.
    expect(fs.existsSync(p)).toBe(true);
  });

  it('downloads bytes with the registry filename; ?inline=1 omits Content-Disposition', async () => {
    insertConversation('c-owner', 2, null);
    const p = makeFile('財務資料.csv', 'a,b,c\n1,2,3\n');
    sessionFiles['c-owner'] = [{ path: p, source: 'write' }];
    await settle();
    const id = ((await call('GET', '/api/generated-files', 'owner')).json!.files as View[])[0].id;

    const dl = await fetch(`${base}/api/generated-files/${id}/download/${encodeURIComponent('財務資料.csv')}`, {
      headers: { 'x-test-user': 'owner' },
    });
    expect(dl.status).toBe(200);
    expect(dl.headers.get('content-disposition')).toBe(
      `attachment; filename="????.csv"; filename*=UTF-8''%E8%B2%A1%E5%8B%99%E8%B3%87%E6%96%99.csv`,
    );
    expect(await dl.text()).toBe('a,b,c\n1,2,3\n');

    const inline = await fetch(`${base}/api/generated-files/${id}/download?inline=1`, {
      headers: { 'x-test-user': 'owner' },
    });
    expect(inline.status).toBe(200);
    expect(inline.headers.get('content-disposition')).toBeNull();
    expect(inline.headers.get('content-type')).toContain('text/csv');
    expect(await inline.text()).toBe('a,b,c\n1,2,3\n');
  });

  it.each([
    ['AuthBox.otf', 'font/otf'],
    ['AuthBox.ttf', 'font/ttf'],
  ])('downloads %s as a font attachment', async (name, contentType) => {
    insertConversation('c-owner', 2, null);
    const bytes = '\u0000font-data';
    const p = makeFile(name, bytes);
    sessionFiles['c-owner'] = [{ path: p, source: 'bash' }];
    await settle();
    const id = ((await call('GET', '/api/generated-files', 'owner')).json!.files as View[])[0].id;

    const response = await fetch(`${base}/api/generated-files/${id}/download/${name}`, {
      headers: { 'x-test-user': 'owner' },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toBe(`attachment; filename="${name}"`);
    expect(response.headers.get('content-type')).toContain(contentType);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from(bytes));
  });

  it('DELETE removes file + row, and still succeeds when the file is already gone', async () => {
    insertConversation('c-owner', 2, null);
    const p1 = makeFile('drop.csv');
    sessionFiles['c-owner'] = [{ path: p1, source: 'write' }];
    await settle();
    const id1 = ((await call('GET', '/api/generated-files', 'owner')).json!.files as View[])[0].id;

    expect((await call('DELETE', `/api/generated-files/${id1}`, 'owner')).status).toBe(200);
    expect(fs.existsSync(p1)).toBe(false);
    expect(db.prepare('SELECT COUNT(*) AS n FROM generated_files').get()).toEqual({ n: 0 });
    expect((await call('GET', '/api/generated-files', 'owner')).json!.files).toEqual([]);

    // Row present but file already removed → delete still ok, row dropped.
    const p2 = makeFile('ghost.csv');
    sessionFiles['c-owner'] = [{ path: p2, source: 'write' }];
    db.prepare("UPDATE conversations SET last_active_at = datetime('now') WHERE id = 'c-owner'").run();
    await settle();
    const id2 = ((await call('GET', '/api/generated-files', 'owner')).json!.files as View[])[0].id;
    fs.rmSync(p2);
    expect((await call('DELETE', `/api/generated-files/${id2}`, 'owner')).status).toBe(200);
    expect(db.prepare('SELECT COUNT(*) AS n FROM generated_files WHERE id = ?').get(id2)).toEqual({ n: 0 });
  });

  it('keeps the file after its chat is deleted (conversation_id → NULL, still lists)', async () => {
    insertConversation('c-owner', 2, 'p1');
    const p = makeFile('kept.csv');
    sessionFiles['c-owner'] = [{ path: p, source: 'write' }];
    await settle();

    db.prepare("DELETE FROM conversations WHERE id = 'c-owner'").run();
    const row = db.prepare('SELECT conversation_id, project_id FROM generated_files').get() as {
      conversation_id: string | null;
      project_id: string | null;
    };
    expect(row.conversation_id).toBeNull();
    expect(row.project_id).toBe('p1'); // project not deleted → still linked

    const files = (await call('GET', '/api/generated-files', 'owner')).json!.files as View[];
    expect(files).toHaveLength(1);
    expect(files[0].name).toBe('kept.csv');
    expect(files[0].conversationId).toBeNull();
    expect(files[0].conversationTitle).toBeNull();
    expect(files[0].projectName).toBe('Sales');
  });
});
