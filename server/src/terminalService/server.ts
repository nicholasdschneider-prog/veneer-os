import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { loginHome } from '../homes.js';
import type { IncomingMessage } from 'node:http';
import type Database from 'better-sqlite3';
import { WebSocketServer, WebSocket } from 'ws';
import { z } from 'zod';
import {
  createSessionStore,
  REAP_INTERVAL_MS,
  type ServerFrame,
  type SessionStore,
  type TermClient,
} from './sessions.js';

/**
 * Terminal service IPC: a loopback HTTP server exposing the pty sessions at
 * /attach (WebSocket) and /healthz. The web process is the only client — it
 * authenticates the browser, then relays frames here (channels/terminal.ts),
 * so this server binds 127.0.0.1 and that bind is the trust boundary, exactly
 * like the runner and app-runner IPC servers.
 *
 * The frame protocol is the browser's own, relayed verbatim; the only extra is
 * the query string, which carries the already-authenticated user id.
 */

const ClientFrameSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('input'), data: z.string() }),
  z.object({ t: z.literal('resize'), cols: z.number().int(), rows: z.number().int() }),
  z.object({ t: z.literal('ping') }),
  z.object({ t: z.literal('restart') }),
]);

export interface TerminalServerOptions {
  db: Database.Database;
  dataDir: string;
  /** Injectable for tests. */
  store?: SessionStore;
}

export function createTerminalServer({ db, dataDir, store }: TerminalServerOptions): {
  server: http.Server;
  shutdown(): void;
} {
  const sessions = store ?? createSessionStore();
  const wss = new WebSocketServer({ noServer: true });

  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && (req.url === '/healthz' || req.url?.startsWith('/healthz?'))) {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
      return;
    }
    res.writeHead(404).end();
  });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/attach') {
      socket.destroy();
      return;
    }
    // Without this, a reset during the handshake emits 'error' on a
    // listener-less socket — an uncaught exception that would crash us.
    socket.on('error', () => socket.destroy());
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const userId = url.searchParams.get('user') ?? '';
    let cols = clampDim(url.searchParams.get('cols'), 80, 10, 500);
    let rows = clampDim(url.searchParams.get('rows'), 24, 4, 300);
    if (!userId) {
      fail(ws, 'Invalid scope');
      return;
    }

    const scope = resolveScope(db, dataDir, url.searchParams.get('scope'), url.searchParams.get('project'));
    if ('error' in scope) {
      fail(ws, scope.error);
      return;
    }

    const key = `${userId}:${scope.scopeKey}`;
    const client = wsClient(ws);
    const attached = sessions.attach(key, client, scope.cwd, cols, rows);
    if (!attached) {
      fail(ws, 'Failed to start terminal');
      return;
    }
    send(ws, { t: 'ready', replay: attached.replay, cols, rows });

    ws.on('message', (data) => {
      let frame: z.infer<typeof ClientFrameSchema>;
      try {
        frame = ClientFrameSchema.parse(JSON.parse(String(data)));
      } catch {
        return; // ignore malformed frames
      }
      sessions.markSeen(key, client);

      if (frame.t === 'ping') {
        send(ws, { t: 'pong' });
        return;
      }
      // A taken-over socket is CLOSING; drop its in-flight frames so a late
      // restart/input can't rebind or drive the session after the handoff.
      if (ws.readyState !== WebSocket.OPEN) return;

      if (frame.t === 'input') {
        sessions.write(key, client, frame.data);
        return;
      }
      if (frame.t === 'resize') {
        cols = clampDim(frame.cols, 80, 10, 500);
        rows = clampDim(frame.rows, 24, 4, 300);
        sessions.resize(key, client, cols, rows);
        return;
      }
      const fresh = sessions.restart(key, client, scope.cwd, cols, rows);
      if (!fresh) {
        fail(ws, 'Failed to start terminal');
        return;
      }
      send(ws, { t: 'ready', replay: fresh.replay, cols, rows });
    });

    const detach = (): void => sessions.detach(key, client);
    ws.on('close', detach);
    ws.on('error', detach);
  });

  const reaper = setInterval(() => sessions.reap(), REAP_INTERVAL_MS);
  reaper.unref();

  return {
    server,
    shutdown(): void {
      clearInterval(reaper);
      sessions.killAll();
    },
  };
}

type Scope = { scopeKey: string; cwd: string } | { error: string };

/** Where a scope's shell opens. Mirrors the pre-split web implementation. */
export function resolveScope(
  db: Database.Database,
  dataDir: string,
  scope: string | null,
  projectId: string | null,
): Scope {
  // The universal shell opens in the machine account's real home, which is what
  // the owner sees when they open Terminal themselves.
  if (scope === 'universal') return { scopeKey: 'universal', cwd: loginHome() };
  if (scope !== 'project') return { error: 'Invalid scope' };

  const row = projectId
    ? (db.prepare('SELECT slug, root_dir FROM projects WHERE id = ?').get(projectId) as
        | { slug: string; root_dir: string | null }
        | undefined)
    : undefined;
  // Validate before touching disk (same guard as removeProjectFolder).
  if (!row || !/^[a-z0-9-]+$/.test(row.slug)) return { error: 'Project not found' };
  // Custom-root projects open their chosen folder; others the default workspace.
  const cwd = row.root_dir ?? path.join(dataDir, 'workspaces', 'projects', row.slug);
  try {
    fs.mkdirSync(cwd, { recursive: true });
  } catch {
    return { error: 'Could not open project workspace' };
  }
  return { scopeKey: `project:${projectId}`, cwd };
}

function wsClient(ws: WebSocket): TermClient {
  return {
    get bufferedAmount() {
      return ws.bufferedAmount;
    },
    get isOpen() {
      return ws.readyState === WebSocket.OPEN;
    },
    send: (frame) => send(ws, frame),
    close: () => {
      try {
        ws.close();
      } catch {
        /* already closing */
      }
    },
    terminate: () => {
      try {
        ws.terminate();
      } catch {
        /* already gone */
      }
    },
  };
}

export function clampDim(raw: string | number | null, fallback: number, min: number, max: number): number {
  // Number(null) and Number('') are both 0 (finite), which would clamp to the
  // min instead of the fallback — guard the empty cases explicitly.
  if (raw === null || raw === '') return fallback;
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function send(ws: WebSocket, frame: ServerFrame): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify(frame));
  } catch {
    /* socket died mid-send */
  }
}

/** Fatal per protocol: send {"t":"error"} then close the socket. */
function fail(ws: WebSocket, message: string): void {
  send(ws, { t: 'error', message });
  try {
    ws.close();
  } catch {
    /* already closing */
  }
}
