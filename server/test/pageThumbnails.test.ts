import fs from 'node:fs';
import http, { type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AppContext } from '../src/context.js';
import { migrate } from '../src/db/migrate.js';
import type { UserRow } from '../src/db/db.js';
import { createPageThumbnails } from '../src/pages/thumbnails.js';
import type { VeneerBrowserRemote } from '../src/veneerBrowser/remoteClient.js';
import { createPagesRouter } from '../src/routes/pages.js';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/db/migrations');

const OWNER: UserRow = {
  id: 1,
  email: 'owner@example.com',
  display_name: 'Owner',
  role: 'owner',
  status: 'active',
  created_at: '',
  last_seen_at: null,
};

// A real 1x1 transparent PNG so the route serves genuine image bytes.
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

/** A Veneer Browser VM stand-in that records the throwaway-profile lifecycle. */
function fakeRemote(overrides: Partial<VeneerBrowserRemote> = {}): VeneerBrowserRemote {
  const remote = {
    configured: vi.fn(() => true),
    clientScope: vi.fn(() => 'client'),
    cdpCaFile: vi.fn(() => null),
    viewerConnection: vi.fn(async () => ({ cdpUrl: 'wss://x/cdp/t/ws', viewerUrl: 'https://x/cdp/t', expiresAt: '2099-01-01T00:00:00Z', caFile: null })),
    create: vi.fn(async () => undefined),
    createTemporary: vi.fn(async () => undefined),
    clone: vi.fn(async () => ({ sourceGeneration: 1 })),
    promote: vi.fn(async () => ({ generation: 1 })),
    saveTemporary: vi.fn(async () => ({ generation: 1 })),
    rename: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
    start: vi.fn(async () => ({ active: true, status: 'active' })),
    stop: vi.fn(async () => undefined),
    status: vi.fn(async () => ({ active: true, status: 'active' })),
    open: vi.fn(),
    ticket: vi.fn(async () => ({
      cdpUrl: 'wss://localhost:7301/cdp/ticket/ws',
      viewerUrl: 'https://localhost:7301/viewer/ticket',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })),
    downloads: vi.fn(async () => []),
  } as unknown as VeneerBrowserRemote;
  return Object.assign(remote, overrides);
}

describe('createPageThumbnails', () => {
  it('captures open → set viewport → screenshot on the browser VM and installs the PNG', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-thumbs-'));
    const calls: string[][] = [];
    const runOptions: { conversationId: string; remoteCdpUrl?: string; remoteSessionId?: string }[] = [];
    const run = vi.fn(async (input: unknown, options: { workspaceDir: string; conversationId: string }) => {
      const args = input as string[];
      calls.push(args);
      runOptions.push(options as never);
      const result = { args, stdout: '', stderr: '', exitCode: 0 };
      if (args[0] !== 'screenshot') return result;
      const shot = path.join(options.workspaceDir, '.veneer-browser', 'screenshot-test.png');
      fs.mkdirSync(path.dirname(shot), { recursive: true });
      fs.writeFileSync(shot, PNG_BYTES);
      return { ...result, screenshotPath: shot };
    });
    const closeSession = vi.fn(async () => undefined);
    const remote = fakeRemote();
    const thumbs = createPageThumbnails({
      dataDir,
      run: run as never,
      closeSession: closeSession as never,
      remote,
      log: { warn: vi.fn() },
    });

    thumbs.capture('page-1', 'https://veneer.page/p/some-slug');
    await vi.waitFor(() => {
      expect(fs.existsSync(thumbs.fileFor('page-1')!)).toBe(true);
    });

    expect(calls.map((args) => args[0])).toEqual(['open', 'set', 'screenshot']);
    expect(calls[1]).toEqual(['set', 'viewport', '800', '1080']);
    // The opened URL is cache-busted so an update never photographs a stale CDN copy.
    expect(calls[0]![1]).toMatch(/^https:\/\/veneer\.page\/p\/some-slug\?vp-thumb=\d+$/);
    expect(fs.readFileSync(thumbs.fileFor('page-1')!)).toEqual(PNG_BYTES);

    // Every command drove the remote VM browser, never a browser on this host —
    // that is what keeps published HTML away from this machine's loopback.
    const profileId = (remote.createTemporary as ReturnType<typeof vi.fn>).mock.calls[0]![1] as string;
    expect(remote.createTemporary).toHaveBeenCalledWith('page-thumbnails', profileId, expect.any(String));
    expect(remote.start).toHaveBeenCalledWith('page-thumbnails', profileId);
    expect(remote.ticket).toHaveBeenCalledWith('page-thumbnails', profileId, 'agent');
    for (const options of runOptions) {
      expect(options.remoteCdpUrl).toBe('wss://localhost:7301/cdp/ticket/ws');
      expect(options.remoteSessionId).toBe(profileId);
    }

    // The throwaway profile and the local daemon are both torn down.
    expect(closeSession).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: runOptions[0]!.conversationId,
      remoteSessionId: profileId,
    }));
    expect(remote.stop).toHaveBeenCalledWith('page-thumbnails', profileId);
    expect(remote.delete).toHaveBeenCalledWith('page-thumbnails', profileId);

    // A second capture reuses nothing: new profile, new session identity.
    thumbs.capture('page-2', 'https://veneer.page/p/other-slug');
    await vi.waitFor(() => {
      expect(fs.existsSync(thumbs.fileFor('page-2')!)).toBe(true);
    });
    const secondProfileId = (remote.createTemporary as ReturnType<typeof vi.fn>).mock.calls[1]![1] as string;
    expect(secondProfileId).not.toBe(profileId);
    expect(runOptions.at(-1)!.conversationId).not.toBe(runOptions[0]!.conversationId);
  });

  it('skips the capture entirely when the browser VM is not configured', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-thumbs-'));
    const warn = vi.fn();
    const run = vi.fn();
    const remote = fakeRemote({ configured: vi.fn(() => false) as never });
    const thumbs = createPageThumbnails({ dataDir, run: run as never, remote, log: { warn } });

    thumbs.capture('page-1', 'https://veneer.page/p/some-slug');
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledOnce();
    });
    // No local-browser fallback: a host browser rendering published HTML could
    // photograph this machine's loopback services.
    expect(run).not.toHaveBeenCalled();
    expect(remote.createTemporary).not.toHaveBeenCalled();
    expect(fs.existsSync(thumbs.fileFor('page-1')!)).toBe(false);
  });

  it('never throws when the browser fails, and refuses hostile ids and urls', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-thumbs-'));
    const warn = vi.fn();
    const run = vi.fn(async (input: unknown) => ({
      args: input as string[],
      stdout: '',
      stderr: 'boom',
      exitCode: 1,
    }));
    const remote = fakeRemote();
    const thumbs = createPageThumbnails({
      dataDir,
      run: run as never,
      closeSession: (async () => undefined) as never,
      remote,
      log: { warn },
    });

    thumbs.capture('page-1', 'https://veneer.page/p/some-slug');
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledOnce();
    });

    const callsAfterFailure = run.mock.calls.length; // the failed open
    // A failed capture still discards its throwaway profile.
    expect(remote.delete).toHaveBeenCalledTimes(1);
    expect(thumbs.fileFor('../escape')).toBeNull();
    thumbs.capture('page-2', 'file:///etc/passwd');
    expect(run).toHaveBeenCalledTimes(callsAfterFailure); // non-https url never reached the browser

    // A repeat within the cooldown is skipped — unless forced (publish path).
    thumbs.capture('page-1', 'https://veneer.page/p/some-slug');
    expect(run).toHaveBeenCalledTimes(callsAfterFailure);
    thumbs.capture('page-1', 'https://veneer.page/p/some-slug', { force: true });
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledTimes(2);
    });
    expect(run.mock.calls.length).toBeGreaterThan(callsAfterFailure);
  });
});

describe('GET /api/pages/:id/thumbnail', () => {
  let db: Database.Database;
  let server: Server;
  let base: string;
  let dataDir: string;
  const lazyCapture = vi.fn();

  function get(pathname: string): Promise<{ status: number; type: string; body: Buffer }> {
    return new Promise((resolve, reject) => {
      http
        .get(`${base}${pathname}`, (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () =>
            resolve({
              status: res.statusCode ?? 0,
              type: String(res.headers['content-type'] ?? ''),
              body: Buffer.concat(chunks),
            }),
          );
        })
        .on('error', reject);
    });
  }

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-thumbs-route-'));
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db, MIGRATIONS);
    db.prepare('INSERT INTO users (id, email, display_name, role, status) VALUES (?, ?, ?, ?, ?)').run(
      OWNER.id,
      OWNER.email,
      OWNER.display_name,
      OWNER.role,
      OWNER.status,
    );
    db.prepare(
      `INSERT INTO pages (id, slug, title, project_id, conversation_id, creator_user_id, size_bytes, expires_at)
       VALUES
        ('with-thumb', 'with-thumb-slug', 'Has thumbnail', NULL, NULL, 1, 10, datetime('now', '+1 day')),
        ('no-thumb', 'no-thumb-slug', 'No thumbnail', NULL, NULL, 1, 10, datetime('now', '+1 day'))`,
    ).run();

    const thumbs = createPageThumbnails({ dataDir, run: vi.fn() as never });
    fs.mkdirSync(path.dirname(thumbs.fileFor('with-thumb')!), { recursive: true });
    fs.writeFileSync(thumbs.fileFor('with-thumb')!, PNG_BYTES);

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = OWNER;
      next();
    });
    app.use(
      '/api/pages',
      createPagesRouter(
        {
          db,
          config: {
            dataDir,
            pages: { accountId: 'account', apiToken: 'secret', bucket: 'pages', publicBase: 'https://veneer.page' },
          },
        } as unknown as AppContext,
        { thumbnails: { fileFor: (id) => createPageThumbnails({ dataDir }).fileFor(id), capture: lazyCapture } },
      ),
    );
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    server.close();
    db.close();
  });

  it('serves the PNG uncached when a thumbnail exists', async () => {
    const response = await get('/api/pages/with-thumb/thumbnail');
    expect(response.status).toBe(200);
    expect(response.type).toContain('image/png');
    expect(response.body).toEqual(PNG_BYTES);
  });

  it('404s and lazily queues a capture when the thumbnail is missing', async () => {
    const response = await get('/api/pages/no-thumb/thumbnail');
    expect(response.status).toBe(404);
    expect(lazyCapture).toHaveBeenCalledWith('no-thumb', 'https://veneer.page/p/no-thumb-slug');
  });

  it('404s for an unknown page without queuing a capture', async () => {
    lazyCapture.mockClear();
    const response = await get('/api/pages/missing-page/thumbnail');
    expect(response.status).toBe(404);
    expect(lazyCapture).not.toHaveBeenCalled();
  });
});
