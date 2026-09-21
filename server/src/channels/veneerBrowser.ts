import { isEmployee } from '../bots/employeeAccess.js';
import path from 'node:path';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket } from 'ws';
import type { AppContext } from '../context.js';
import { findUserByEmail } from '../context.js';
import type { UserRow } from '../db/db.js';
import { runViewerSession } from './cdpDesktop.js';
import { remoteBrowserWebSocketUrl } from './cdpClient.js';
import { readVeneerBrowserSettings } from '../veneerBrowser/settings.js';
import {
  VENEER_BROWSER_MAX_FRAME_PIXELS,
  VENEER_BROWSER_THUMBNAIL_LIMITS,
  veneerBrowserFrameScale,
} from '../veneerBrowser/resolution.js';

const ID = /^[A-Za-z0-9_-]{1,200}$/;

export interface ViewerUpgrade {
  req: IncomingMessage;
  socket: Duplex;
  head: Buffer;
  wss: WebSocketServer;
  url: URL;
  user: UserRow;
  conversationId: string;
  /** Where the socket came in: the public tunnel or the direct LAN listener. */
  route: 'tunnel' | 'lan';
}

/**
 * One viewer connection, whichever door it came through. The caller has
 * already established who the user is; everything from here — settings,
 * the browser-VM ticket, frame pacing — is identical for both routes.
 */
export async function openVeneerBrowserViewer(ctx: AppContext, upgrade: ViewerUpgrade): Promise<void> {
  const { req, socket, head, wss, url, user, conversationId } = upgrade;
  if (user.status !== 'active' || isEmployee(ctx.db, user.id) || !ID.test(conversationId)) throw new Error('Forbidden');
  const settings = readVeneerBrowserSettings(ctx.db);
  const thumbnail = url.searchParams.get('viewer') === 'thumbnail';
  const frameScale = thumbnail ? 1 : veneerBrowserFrameScale(settings.resolution, url.searchParams.get('dpr'));
  const { ticket, caFile } = await ctx.manager.veneerBrowserConversationTicket(user.id, conversationId);
  const cdpWebSocketUrl = await remoteBrowserWebSocketUrl(ticket, caFile);
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.pause();
    void runViewerSession(ws, {
      cdpWebSocketUrl,
      cdpCaFile: caFile,
      downloadDir: '/downloads',
      remoteDownloadDir: true,
      uploadDir: path.join(ctx.config.dataDir, 'browser-uploads'),
      label: upgrade.route === 'lan' ? 'Veneer Browser (lan)' : 'Veneer Browser',
      framePacing: 'latest',
      frameQuality: settings.quality,
      frameScale,
      frameLimits: thumbnail
        ? VENEER_BROWSER_THUMBNAIL_LIMITS
        : { maxPixels: VENEER_BROWSER_MAX_FRAME_PIXELS },
    }).catch(() => {
      try { ws.close(1011); } catch { /* closed */ }
    });
  });
}

export function attachVeneerBrowser(server: Server, ctx: AppContext): void {
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/ws/veneer-browser') return;
    socket.on('error', () => socket.destroy());
    void (async () => {
      const identity = await ctx.resolveIdentity(req);
      const user = identity ? findUserByEmail(ctx.db, identity.email) : undefined;
      const conversationId = url.searchParams.get('conversation') ?? '';
      if (!user) throw new Error('Forbidden');
      await openVeneerBrowserViewer(ctx, { req, socket, head, wss, url, user, conversationId, route: 'tunnel' });
    })().catch(() => {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
    });
  });
}
