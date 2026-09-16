import crypto, { X509Certificate } from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import type Database from 'better-sqlite3';
import { WebSocketServer } from 'ws';
import type { AppContext } from '../context.js';
import type { UserRow } from '../db/db.js';
import { openVeneerBrowserViewer } from './veneerBrowser.js';
import { cdpDesktopPageHtml } from '../routes/cdpDesktopPage.js';

/**
 * A direct LAN path for the Veneer Browser live view.
 *
 * The app itself stays behind Cloudflare Access at its public hostname; that is
 * where login lives. But the viewer's frames and input do not need to leave the
 * building: when a LAN hostname with a real certificate points at this machine,
 * the signed-in app mints a short-lived ticket and the viewer page opens its
 * WebSocket straight to this listener. The listener serves nothing else — no
 * pages, no API — and a ticket is the only credential it accepts.
 */

export const VIEWER_TICKET_TTL_MS = 60_000;
/** A viewer page keeps reconnecting its socket for as long as it stays open. */
export const VIEWER_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const CERT_WARN_DAYS = 14;
const ID = /^[A-Za-z0-9_-]{1,200}$/;

export interface ViewerTicket {
  userId: number;
  conversationId: string;
  /** The app origin that minted it; the viewer page posts its messages there. */
  appOrigin: string;
}

export interface ViewerTicketStore {
  /** A fresh single-use ticket for this user and chat, good for one page load. */
  issue(userId: number, conversationId: string, appOrigin: string): string;
  /** The ticket's owner and chat, or null when unknown, expired or already used. */
  redeem(token: string): ViewerTicket | null;
  /** A reusable socket credential for a page that presented a valid ticket. */
  openSession(ticket: ViewerTicket): string;
  /** The session's owner and chat, or null when unknown or expired. */
  session(token: string): ViewerTicket | null;
  /** Forget expired and used entries. */
  sweep(): void;
  readonly size: number;
}

export function createViewerTicketStore(options: { ttlMs?: number; sessionTtlMs?: number; now?: () => number } = {}): ViewerTicketStore {
  const ttlMs = options.ttlMs ?? VIEWER_TICKET_TTL_MS;
  const sessionTtlMs = options.sessionTtlMs ?? VIEWER_SESSION_TTL_MS;
  const now = options.now ?? Date.now;
  const tickets = new Map<string, ViewerTicket & { expiresAt: number }>();
  const sessions = new Map<string, ViewerTicket & { expiresAt: number }>();
  const token = () => crypto.randomBytes(32).toString('base64url');
  return {
    issue(userId, conversationId, appOrigin) {
      this.sweep();
      const value = token();
      tickets.set(value, { userId, conversationId, appOrigin, expiresAt: now() + ttlMs });
      return value;
    },
    redeem(value) {
      const ticket = tickets.get(value);
      // Single use: a redeemed ticket is gone whether or not it was still valid.
      if (ticket) tickets.delete(value);
      if (!ticket || ticket.expiresAt <= now()) return null;
      return { userId: ticket.userId, conversationId: ticket.conversationId, appOrigin: ticket.appOrigin };
    },
    openSession(ticket) {
      const value = token();
      sessions.set(value, { ...ticket, expiresAt: now() + sessionTtlMs });
      return value;
    },
    session(value) {
      const entry = sessions.get(value);
      if (!entry || entry.expiresAt <= now()) return null;
      return { userId: entry.userId, conversationId: entry.conversationId, appOrigin: entry.appOrigin };
    },
    sweep() {
      const at = now();
      for (const [value, ticket] of tickets) if (ticket.expiresAt <= at) tickets.delete(value);
      for (const [value, entry] of sessions) if (entry.expiresAt <= at) sessions.delete(value);
    },
    get size() {
      return tickets.size + sessions.size;
    },
  };
}

export interface LanViewerConfig {
  host: string;
  port: number;
  certFile: string;
  keyFile: string;
}

/** The viewer page address the panel embeds, carrying its one-shot ticket. */
export function lanViewerPageUrl(config: LanViewerConfig, token: string): string {
  return `https://${config.host}:${config.port}/veneer-browser?ticket=${encodeURIComponent(token)}`;
}

function activeUser(db: Database.Database, ticket: ViewerTicket | null): { user: UserRow; conversationId: string; appOrigin: string } | null {
  if (!ticket || !ID.test(ticket.conversationId)) return null;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(ticket.userId) as UserRow | undefined;
  if (!user || user.status !== 'active') return null;
  return { user, conversationId: ticket.conversationId, appOrigin: ticket.appOrigin };
}

/**
 * Who may open this socket, or null. The URL must be the viewer socket path
 * carrying the session a viewer page was given, and that session's user must
 * still be an active account.
 */
export function authorizeLanViewer(
  store: ViewerTicketStore,
  db: Database.Database,
  rawUrl: string | undefined,
): { user: UserRow; conversationId: string; appOrigin: string } | null {
  const url = new URL(rawUrl ?? '/', 'https://lan');
  if (url.pathname !== '/ws/veneer-browser') return null;
  const session = url.searchParams.get('session') ?? '';
  if (!session) return null;
  return activeUser(db, store.session(session));
}

/** Who may load the viewer page, or null; the ticket is spent either way. */
export function authorizeLanViewerPage(
  store: ViewerTicketStore,
  db: Database.Database,
  rawUrl: string | undefined,
): { user: UserRow; conversationId: string; appOrigin: string } | null {
  const url = new URL(rawUrl ?? '/', 'https://lan');
  if (url.pathname !== '/veneer-browser') return null;
  const ticket = url.searchParams.get('ticket') ?? '';
  if (!ticket) return null;
  return activeUser(db, store.redeem(ticket));
}

/** Days until the certificate expires, for the startup warning. */
export function certificateDaysLeft(certPem: string, now = Date.now()): number | null {
  try {
    const cert = new X509Certificate(certPem);
    return (Date.parse(cert.validTo) - now) / 86_400_000;
  } catch {
    return null;
  }
}

export function attachLanViewer(ctx: AppContext, config: LanViewerConfig, store: ViewerTicketStore): https.Server {
  const cert = fs.readFileSync(config.certFile, 'utf8');
  const key = fs.readFileSync(config.keyFile, 'utf8');
  const daysLeft = certificateDaysLeft(cert);
  if (daysLeft !== null && daysLeft < CERT_WARN_DAYS) {
    console.warn(`[veneer-pro] LAN viewer certificate for ${config.host} expires in ${Math.max(0, Math.floor(daysLeft))} day(s)`);
  }
  const wss = new WebSocketServer({ noServer: true });
  // Two things live here and nothing else: the viewer page for a one-shot
  // ticket, and the socket for the session that page was given. Anything else
  // gets a 404 and learns nothing about the app behind the public hostname.
  const server = https.createServer({ cert, key }, (req, res) => {
    const admitted = req.method === 'GET' ? authorizeLanViewerPage(store, ctx.db, req.url) : null;
    if (!admitted) {
      res.writeHead(req.method === 'GET' && (req.url ?? '').startsWith('/veneer-browser') ? 403 : 404, { 'Content-Type': 'text/plain' });
      res.end(res.statusCode === 403 ? 'Forbidden' : 'Not found');
      return;
    }
    const session = store.openSession({ userId: admitted.user.id, conversationId: admitted.conversationId, appOrigin: admitted.appOrigin });
    const page = new URL(req.url ?? '/', 'https://lan');
    // The panel's layout flags travel with the page, exactly as on the tunnel.
    const passthrough = new URLSearchParams();
    for (const name of ['chrome', 'tabs', 'host', 'view']) {
      const value = page.searchParams.get(name);
      if (value) passthrough.set(name, value);
    }
    const html = cdpDesktopPageHtml({
      websocketPath: `/ws/veneer-browser?session=${encodeURIComponent(session)}`,
      title: 'Veneer Browser',
      subtitle: 'This chat browser',
      reportViewerHints: true,
      appOrigin: admitted.appOrigin,
    });
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      // Only the app that minted the ticket may embed this page.
      'Content-Security-Policy': `frame-ancestors ${admitted.appOrigin}`,
      'X-Content-Type-Options': 'nosniff',
    });
    // The flags are read from the page's own URL, which still carries them.
    void passthrough;
    res.end(html);
  });
  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => socket.destroy());
    const authorized = authorizeLanViewer(store, ctx.db, req.url);
    if (!authorized) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    const url = new URL(req.url ?? '/', 'https://lan');
    openVeneerBrowserViewer(ctx, { req, socket, head, wss, url, user: authorized.user, conversationId: authorized.conversationId, route: 'lan' }).catch(() => {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
    });
  });
  server.listen(config.port, '0.0.0.0', () => {
    console.log(`[veneer-pro] LAN viewer listening on https://${config.host}:${config.port} (viewer socket only)`);
  });
  const sweeper = setInterval(() => store.sweep(), VIEWER_TICKET_TTL_MS);
  sweeper.unref();
  return server;
}
