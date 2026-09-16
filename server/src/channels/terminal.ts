import type { IncomingMessage, Server } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import type { AppContext } from '../context.js';
import { findUserByEmail } from '../context.js';
import type { UserRow } from '../db/db.js';

/**
 * Browser terminal at /ws/term. The web process authenticates the request and
 * then relays frames verbatim to the terminal service (veneer-pro-term), which
 * owns the ptys. Keeping the shells in that separate supervised process is what
 * lets them survive a web restart: shipping web/UI code swaps this process
 * while the shells keep running, and the browser's own reconnect re-attaches.
 *
 * Owner/consultant only (this is a real shell on the box). The gate stays here,
 * with the identity; the terminal service trusts its loopback bind, like the
 * runner and app-runner IPC servers.
 *
 * NEVER log frame payloads — they can contain secrets. Lifecycle only.
 */

// Mirrors the pty-side flow control: when the browser stops draining, stop
// reading from the terminal service. TCP backpressure then reaches the pty,
// which pauses the shell rather than growing a send buffer without bound.
const SEND_HIGH_WATER = 4 * 1024 * 1024;
const RESUME_POLL_MS = 50;

export function attachTerminal(server: Server, ctx: AppContext): { shutdown(): void } {
  const wss = new WebSocketServer({ noServer: true });
  const relays = new Set<{ client: WebSocket; upstream: WebSocket }>();

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/ws/term') return; // let other WS listeners handle their paths
    // Without this, a client reset during the async auth below emits 'error' on
    // a listener-less socket — an uncaught exception that would crash the server.
    socket.on('error', () => socket.destroy());
    void (async () => {
      const identity = await ctx.resolveIdentity(req);
      const user = identity ? findUserByEmail(ctx.db, identity.email) : undefined;
      // A shell on the box — owner/consultant only, same gate as /api/admin.
      if (!user || user.status !== 'active' || user.role === 'member') {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req, user));
    })().catch(() => socket.destroy());
  });

  wss.on('connection', (client: WebSocket, req: IncomingMessage, user: UserRow) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const query = new URLSearchParams();
    query.set('user', String(user.id));
    query.set('scope', url.searchParams.get('scope') ?? '');
    const projectId = url.searchParams.get('project');
    if (projectId) query.set('project', projectId);
    query.set('cols', url.searchParams.get('cols') ?? '');
    query.set('rows', url.searchParams.get('rows') ?? '');

    let upstream: WebSocket;
    try {
      upstream = new WebSocket(`ws://127.0.0.1:${ctx.config.termPort}/attach?${query.toString()}`);
    } catch {
      client.close();
      return;
    }
    const relay = { client, upstream };
    relays.add(relay);

    // Frames typed before the upstream handshake finishes (the client sends its
    // first resize immediately) would otherwise be dropped.
    const pending: string[] = [];
    let closed = false;
    let paused = false;
    const closeBoth = (): void => {
      if (closed) return;
      closed = true;
      relays.delete(relay);
      // No error frame: the client treats {t:'error'} as fatal and stops
      // reconnecting. A terminal-service restart must stay recoverable, so let
      // the plain close drive its normal backoff instead.
      try {
        client.close();
      } catch {
        /* already closing */
      }
      try {
        upstream.close();
      } catch {
        /* already closing */
      }
    };

    upstream.on('open', () => {
      for (const frame of pending.splice(0)) upstream.send(frame);
    });
    upstream.on('message', (data) => {
      if (client.readyState !== WebSocket.OPEN) return;
      client.send(String(data));
      if (!paused && client.bufferedAmount > SEND_HIGH_WATER) {
        paused = true;
        pauseUntilDrained(client, upstream, () => {
          paused = false;
        });
      }
    });
    upstream.on('close', closeBoth);
    upstream.on('error', closeBoth);

    client.on('message', (data) => {
      const frame = String(data);
      if (upstream.readyState === WebSocket.OPEN) upstream.send(frame);
      else if (upstream.readyState === WebSocket.CONNECTING) pending.push(frame);
    });
    client.on('close', closeBoth);
    client.on('error', closeBoth);
  });

  return {
    shutdown(): void {
      // Only the relays go; the shells live in the terminal service and are
      // still there when the browser reconnects to the respawned web process.
      for (const { client, upstream } of relays) {
        try {
          client.close();
        } catch {
          /* already closing */
        }
        try {
          upstream.close();
        } catch {
          /* already closing */
        }
      }
      relays.clear();
    },
  };
}

/** Stop reading the terminal service until the browser's queue drains. */
function pauseUntilDrained(client: WebSocket, upstream: WebSocket, onResumed: () => void): void {
  upstream.pause();
  const check = (): void => {
    if (client.readyState !== WebSocket.OPEN || client.bufferedAmount < SEND_HIGH_WATER / 2) {
      upstream.resume();
      onResumed();
      return;
    }
    setTimeout(check, RESUME_POLL_MS).unref?.();
  };
  setTimeout(check, RESUME_POLL_MS).unref?.();
}
