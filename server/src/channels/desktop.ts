import net from 'node:net';
import type { Server } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import type { AppContext } from '../context.js';
import { findUserByEmail } from '../context.js';
import { desktopUpgradeAllowed } from './desktopAuth.js';

export { desktopUpgradeAllowed };

/**
 * VNC bridge at /ws/desktop: a raw byte pipe between a noVNC client and the
 * loopback x11vnc server (127.0.0.1:5901) that mirrors the visible desktop
 * Chrome. Full control of the user's browser — owner/consultant only, the same
 * gate as the terminal. NEVER log payload data (it is the user's screen and
 * keystrokes); lifecycle logs only.
 */

const VNC_HOST = '127.0.0.1';
const VNC_PORT = 5901;
// Backpressure on the heavy TCP→WS direction (framebuffer updates): pause the
// VNC socket when this much is queued to a slow client, resume once it drains.
const SEND_HIGH_WATER = 4 * 1024 * 1024;
const RESUME_LOW_WATER = 1 * 1024 * 1024;
const RESUME_POLL_MS = 50;

export function attachDesktop(server: Server, ctx: AppContext): void {
  const wss = new WebSocketServer({
    noServer: true,
    // noVNC offers the 'binary' subprotocol and aborts the connection if it is
    // not negotiated back.
    handleProtocols: (protocols) => (protocols.has('binary') ? 'binary' : false),
  });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/ws/desktop') return; // let other WS listeners handle their paths
    // Without this, a client reset during the async auth below emits 'error' on
    // a listener-less socket — an uncaught exception that would crash the server.
    socket.on('error', () => socket.destroy());
    void (async () => {
      const identity = await ctx.resolveIdentity(req);
      const user = identity ? findUserByEmail(ctx.db, identity.email) : undefined;
      // Full control of the user's browser — owner/consultant only, same gate
      // as the terminal.
      if (!desktopUpgradeAllowed(user)) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws));
    })().catch(() => socket.destroy());
  });

  wss.on('connection', (ws: WebSocket) => {
    const tcp = net.connect(VNC_PORT, VNC_HOST);
    let paused = false;

    const teardown = (): void => {
      try {
        tcp.destroy();
      } catch {
        /* already gone */
      }
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        try {
          ws.close();
        } catch {
          /* already closing */
        }
      }
    };

    tcp.on('connect', () => {
      // TCP→WS (framebuffer, the heavy direction): forward as binary and apply
      // backpressure so a slow/backgrounded client can't grow the send buffer
      // without bound.
      tcp.on('data', (chunk: Buffer) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        ws.send(chunk, { binary: true });
        if (!paused && ws.bufferedAmount > SEND_HIGH_WATER) {
          paused = true;
          tcp.pause();
          const drain = (): void => {
            if (ws.readyState !== WebSocket.OPEN) return;
            if (ws.bufferedAmount < RESUME_LOW_WATER) {
              paused = false;
              tcp.resume();
              return;
            }
            setTimeout(drain, RESUME_POLL_MS).unref?.();
          };
          setTimeout(drain, RESUME_POLL_MS).unref?.();
        }
      });
    });

    // WS→TCP (keyboard/mouse, tiny): no backpressure needed — input events are a
    // trickle of bytes, not framebuffer frames.
    ws.on('message', (data: Buffer) => {
      if (!tcp.destroyed) tcp.write(data);
    });

    tcp.on('error', () => {
      // VNC service down / connection refused → close with an internal-error code.
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        try {
          ws.close(1011);
        } catch {
          /* already closing */
        }
      }
      try {
        tcp.destroy();
      } catch {
        /* already gone */
      }
    });
    tcp.on('close', teardown);
    ws.on('close', teardown);
    ws.on('error', teardown);
  });
}
