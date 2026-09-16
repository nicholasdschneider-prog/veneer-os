import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import Database from 'better-sqlite3';
import express from 'express';
import { WebSocket } from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  attachLanViewer,
  authorizeLanViewer,
  authorizeLanViewerPage,
  certificateDaysLeft,
  createViewerTicketStore,
  lanViewerPageUrl,
} from '../src/channels/lanViewer.js';
import { loadConfig } from '../src/config.js';
import { cdpDesktopPageHtml } from '../src/routes/cdpDesktopPage.js';
import { createVeneerBrowserRouter } from '../src/routes/veneerBrowser.js';
import type { AppContext } from '../src/context.js';
import type { UserRow } from '../src/db/db.js';

function usersDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT, display_name TEXT, role TEXT, status TEXT, created_at TEXT, last_seen_at TEXT)`);
  db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL)');
  db.prepare("INSERT INTO users VALUES (1, 'a@x.test', 'A', 'owner', 'active', '2026-01-01', NULL)").run();
  db.prepare("INSERT INTO users VALUES (2, 'b@x.test', 'B', 'member', 'disabled', '2026-01-01', NULL)").run();
  return db;
}

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

describe('viewer ticket store', () => {
  it('issues single-use tickets bound to a user and chat that expire', () => {
    let now = 1_000_000;
    const store = createViewerTicketStore({ ttlMs: 60_000, sessionTtlMs: 3_600_000, now: () => now });
    const token = store.issue(1, 'chat-1', 'https://pro.test');
    expect(token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(store.redeem('nope')).toBeNull();
    const ticket = store.redeem(token);
    expect(ticket).toEqual({ userId: 1, conversationId: 'chat-1', appOrigin: 'https://pro.test' });
    // Second use is refused.
    expect(store.redeem(token)).toBeNull();

    // A page that presented a ticket gets a reusable session for its socket.
    const session = store.openSession(ticket!);
    expect(store.session(session)).toEqual(ticket);
    expect(store.session(session)).toEqual(ticket);
    now += 3_600_001;
    expect(store.session(session)).toBeNull();

    const stale = store.issue(1, 'chat-1', 'https://pro.test');
    now += 60_001;
    expect(store.redeem(stale)).toBeNull();
    store.issue(1, 'chat-2', 'https://pro.test');
    store.sweep();
    expect(store.size).toBe(1);
  });
});

describe('LAN viewer authorization', () => {
  it('admits the viewer page for a live ticket and the socket for its session, for an active user', () => {
    const db = usersDb();
    cleanups.push(() => db.close());
    const store = createViewerTicketStore();
    const good = store.issue(1, 'chat-1', 'https://pro.test');
    const page = authorizeLanViewerPage(store, db, `/veneer-browser?ticket=${good}&chrome=off`);
    expect(page).toMatchObject({ user: { id: 1 }, conversationId: 'chat-1', appOrigin: 'https://pro.test' });
    // Consumed.
    expect(authorizeLanViewerPage(store, db, `/veneer-browser?ticket=${good}`)).toBeNull();
    expect(authorizeLanViewerPage(store, db, '/veneer-browser')).toBeNull();
    expect(authorizeLanViewerPage(store, db, `/api/anything?ticket=${store.issue(1, 'chat-1', 'https://pro.test')}`)).toBeNull();
    // A disabled or unknown account's ticket is refused even when fresh.
    expect(authorizeLanViewerPage(store, db, `/veneer-browser?ticket=${store.issue(2, 'chat-1', 'https://pro.test')}`)).toBeNull();
    expect(authorizeLanViewerPage(store, db, `/veneer-browser?ticket=${store.issue(9, 'chat-1', 'https://pro.test')}`)).toBeNull();

    const session = store.openSession({ userId: 1, conversationId: 'chat-1', appOrigin: 'https://pro.test' });
    expect(authorizeLanViewer(store, db, `/ws/veneer-browser?session=${session}&viewer=full`)).toMatchObject({ user: { id: 1 }, conversationId: 'chat-1' });
    // Sessions are reusable (the page reconnects), tickets are not sockets.
    expect(authorizeLanViewer(store, db, `/ws/veneer-browser?session=${session}`)).toMatchObject({ conversationId: 'chat-1' });
    expect(authorizeLanViewer(store, db, `/ws/veneer-browser?ticket=${store.issue(1, 'chat-1', 'https://pro.test')}`)).toBeNull();
    expect(authorizeLanViewer(store, db, '/ws/veneer-browser')).toBeNull();
  });

  it('builds the page address the panel embeds', () => {
    expect(lanViewerPageUrl({ host: 'studio-lan.veneer.app', port: 3443, certFile: 'c', keyFile: 'k' }, 'a+b'))
      .toBe('https://studio-lan.veneer.app:3443/veneer-browser?ticket=a%2Bb');
  });
});

describe('LAN viewer listener', () => {
  const hasOpenssl = (() => {
    try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); return true; } catch { return false; }
  })();

  it.skipIf(!hasOpenssl)('serves nothing but the ticketed upgrade', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lan-viewer-'));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const certFile = path.join(dir, 'cert.pem');
    const keyFile = path.join(dir, 'key.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '30', '-subj', '/CN=localhost',
      '-keyout', keyFile, '-out', certFile], { stdio: 'ignore' });
    expect(certificateDaysLeft(fs.readFileSync(certFile, 'utf8'))).toBeGreaterThan(28);
    expect(certificateDaysLeft('garbage')).toBeNull();

    const db = usersDb();
    cleanups.push(() => db.close());
    const store = createViewerTicketStore();
    const veneerBrowserConversationTicket = vi.fn(async () => ({ ticket: 'https://browser.test/cdp/t', caFile: null }));
    const ctx = { db, config: { dataDir: dir }, manager: { veneerBrowserConversationTicket } } as unknown as AppContext;
    const server = attachLanViewer(ctx, { host: 'localhost', port: 0, certFile, keyFile }, store);
    await new Promise((resolve) => server.once('listening', resolve));
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const port = (server.address() as AddressInfo).port;

    const get = (p: string) => new Promise<{ status: number; body: string; headers: Record<string, unknown> }>((resolve, reject) => {
      https.get({ host: '127.0.0.1', port, path: p, rejectUnauthorized: false }, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
      }).on('error', reject);
    });
    // Plain HTTP learns nothing; the page without a ticket is refused.
    expect((await get('/api/me')).status).toBe(404);
    expect((await get('/veneer-browser?chrome=off')).status).toBe(403);

    // A live ticket returns the viewer page, embeddable only by the minting app,
    // wired to a session socket on this same origin.
    const pageTicket = store.issue(1, 'chat-1', 'https://pro.test');
    const page = await get(`/veneer-browser?ticket=${pageTicket}&chrome=off&tabs=off&host=desktop`);
    expect(page.status).toBe(200);
    expect(page.headers['content-security-policy']).toBe('frame-ancestors https://pro.test');
    expect(page.headers['cache-control']).toBe('no-store');
    const sessionPath = page.body.match(/"\/ws\/veneer-browser\?session=([A-Za-z0-9_-]+)"/);
    expect(sessionPath).toBeTruthy();
    expect(page.body).toContain('const hostOrigin = "https://pro.test" || window.location.origin;');
    // The ticket is spent.
    expect((await get(`/veneer-browser?ticket=${pageTicket}`)).status).toBe(403);

    // No session: refused before any browser work happens.
    const refused = new WebSocket(`wss://127.0.0.1:${port}/ws/veneer-browser`, { rejectUnauthorized: false });
    await new Promise<void>((resolve) => { refused.once('error', () => resolve()); refused.once('close', () => resolve()); });
    expect(veneerBrowserConversationTicket).not.toHaveBeenCalled();

    // The page's session reaches the viewer flow for its user and chat.
    const admitted = new WebSocket(`wss://127.0.0.1:${port}/ws/veneer-browser?session=${sessionPath![1]}`, { rejectUnauthorized: false });
    await new Promise<void>((resolve) => { admitted.once('error', () => resolve()); admitted.once('close', () => resolve()); admitted.once('open', () => resolve()); });
    try { admitted.close(); } catch { /* done */ }
    await vi.waitFor(() => expect(veneerBrowserConversationTicket).toHaveBeenCalledWith(1, 'chat-1'));
  });
});

describe('LAN viewer configuration', () => {
  const base = { VP_IDENTITY: 'dev' };
  it('is off unless host, cert and key are all present', () => {
    expect(loadConfig({ ...base }).lanViewer).toBeNull();
    expect(loadConfig({ ...base, VP_LAN_VIEWER_HOST: 'studio-lan.veneer.app', VP_LAN_VIEWER_CERT: '/c.pem', VP_LAN_VIEWER_KEY: '/k.pem' }).lanViewer)
      .toEqual({ host: 'studio-lan.veneer.app', port: 3443, certFile: '/c.pem', keyFile: '/k.pem' });
    expect(() => loadConfig({ ...base, VP_LAN_VIEWER_HOST: 'studio-lan.veneer.app' })).toThrow(/must all be set/);
  });
});

describe('LAN viewer route and page', () => {
  it('mints a ticket for the signed-in user, and 404s where there is no LAN listener', async () => {
    const store = createViewerTicketStore();
    const make = (lan: boolean) => {
      const app = express();
      app.use((req, _res, next) => {
        req.user = { id: 7, email: 'o@x.test', display_name: 'O', role: 'owner', status: 'active', created_at: '', last_seen_at: null } satisfies UserRow;
        next();
      });
      app.use('/api/veneer-browser', createVeneerBrowserRouter({
        db: new Database(':memory:'),
        manager: {},
        config: { lanViewer: lan ? { host: 'studio-lan.veneer.app', port: 3443, certFile: 'c', keyFile: 'k' } : null },
        viewerTickets: lan ? store : undefined,
      } as unknown as AppContext));
      return app;
    };
    const on = make(true).listen(0, '127.0.0.1');
    const off = make(false).listen(0, '127.0.0.1');
    await Promise.all([on, off].map((server) => new Promise((resolve) => server.once('listening', resolve))));
    cleanups.push(() => new Promise<void>((r) => on.close(() => r())), () => new Promise<void>((r) => off.close(() => r())));
    const url = (server: typeof on) => `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/veneer-browser/conversations/chat-9/lan-viewer`;

    const minted = await fetch(url(on), { method: 'POST', headers: { 'x-forwarded-host': 'veneer.example', 'x-forwarded-proto': 'https' } });
    expect(minted.status).toBe(200);
    const body = (await minted.json()) as { viewerUrl: string };
    expect(body.viewerUrl).toMatch(/^https:\/\/studio-lan\.veneer\.app:3443\/veneer-browser\?ticket=/);
    const token = new URL(body.viewerUrl).searchParams.get('ticket')!;
    expect(store.redeem(token)).toEqual({ userId: 7, conversationId: 'chat-9', appOrigin: 'https://veneer.example' });

    expect((await fetch(url(off), { method: 'POST' })).status).toBe(404);
  });

  it('trusts and addresses the minting app when the page is served from the LAN door', () => {
    const lan = cdpDesktopPageHtml({ websocketPath: '/ws/veneer-browser?session=s', appOrigin: 'https://veneer.example', reportViewerHints: true });
    expect(lan).toContain('const hostOrigin = "https://veneer.example" || window.location.origin;');
    expect(lan).toContain('window.parent.postMessage(msg, hostOrigin)');
    expect(lan).toContain('event.origin === hostOrigin');
    const plain = cdpDesktopPageHtml({ websocketPath: '/ws/veneer-browser?conversation=c', reportViewerHints: true });
    expect(plain).toContain('const hostOrigin = null || window.location.origin;');
  });
});
