import fs from 'node:fs';
import { WebSocket } from 'ws';
import { Agent } from 'undici';

/**
 * A minimal Chrome DevTools Protocol client: JSON-RPC over one WebSocket, with
 * flat session multiplexing (`sessionId` on every message) so a single browser
 * connection can drive many targets.
 *
 * Deliberately not a library. We use four domains — Target, Page, Input,
 * Emulation — and a dependency would bring a session/target abstraction we would
 * then have to work around.
 */

const CALL_TIMEOUT_MS = 15_000;

export interface CdpEvent {
  method: string;
  params: Record<string, any>;
  sessionId?: string;
}

export interface CdpConnection {
  send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<any>;
  /** Fire-and-forget: for high-rate calls (frame acks, input) where awaiting adds latency. */
  post(method: string, params?: Record<string, unknown>, sessionId?: string): void;
  on(handler: (event: CdpEvent) => void): void;
  onClose(handler: () => void): void;
  close(): void;
  readonly closed: boolean;
}

/** Resolve the browser-level debugger URL from a CDP HTTP endpoint. */
export async function browserWebSocketUrl(port: number, host = '127.0.0.1'): Promise<string> {
  const res = await fetch(`http://${host}:${port}/json/version`, { signal: AbortSignal.timeout(5_000) });
  if (!res.ok) throw new Error(`CDP /json/version returned ${res.status}`);
  const body = (await res.json()) as { webSocketDebuggerUrl?: string };
  if (!body.webSocketDebuggerUrl) throw new Error('CDP endpoint exposed no webSocketDebuggerUrl');
  return body.webSocketDebuggerUrl;
}

/** Resolve a browser WebSocket from a short-lived remote CDP HTTP ticket. */
export async function remoteBrowserWebSocketUrl(baseUrl: string, caFile?: string | null): Promise<string> {
  const base = new URL(baseUrl);
  if (base.protocol !== 'https:' || !base.pathname.startsWith('/cdp/')) {
    throw new Error('Remote browser control address is not trusted');
  }
  const endpoint = `${base.toString().replace(/\/+$/, '')}/json/version`;
  // A LAN address presents the manager's own certificate, which only this
  // pinned file vouches for; the tunnel is covered by the public roots.
  const dispatcher = caFile ? new Agent({ connect: { ca: fs.readFileSync(caFile, 'utf8') } }) : undefined;
  const res = await fetch(endpoint, {
    signal: AbortSignal.timeout(5_000),
    ...(dispatcher ? { dispatcher } : {}),
  } as RequestInit);
  if (!res.ok) throw new Error(`Remote CDP returned ${res.status}`);
  const body = (await res.json()) as { webSocketDebuggerUrl?: string };
  if (!body.webSocketDebuggerUrl) throw new Error('Remote CDP exposed no browser socket');
  const ws = new URL(body.webSocketDebuggerUrl);
  if (ws.protocol !== 'wss:' || ws.origin.replace(/^wss:/, 'https:') !== base.origin) {
    throw new Error('Remote browser socket is not trusted');
  }
  return ws.toString();
}

export async function connectCdp(wsUrl: string, options: { caFile?: string | null; timeoutMs?: number; maxPayloadBytes?: number } = {}): Promise<CdpConnection> {
  const ws = new WebSocket(wsUrl, {
    ...(options.caFile ? { ca: fs.readFileSync(options.caFile, 'utf8') } : {}),
    // Screencast frames are large; the default 100MB cap is fine but the
    // per-message deflate negotiation is pure overhead on already-compressed JPEG.
    perMessageDeflate: false,
    handshakeTimeout: options.timeoutMs ?? 15_000,
    maxPayload: options.maxPayloadBytes ?? 256 * 1024 * 1024,
  });

  await new Promise<void>((resolve, reject) => {
    const onOpen = (): void => {
      ws.off('error', onError);
      resolve();
    };
    const onError = (err: Error): void => {
      ws.off('open', onOpen);
      reject(new Error(`CDP connect failed: ${err.message}`));
    };
    ws.once('open', onOpen);
    ws.once('error', onError);
  });

  let nextId = 1;
  const callTimeoutMs = Math.min(CALL_TIMEOUT_MS, options.timeoutMs ?? CALL_TIMEOUT_MS);
  let closed = false;
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  const eventHandlers: ((event: CdpEvent) => void)[] = [];
  const closeHandlers: (() => void)[] = [];

  ws.on('message', (raw: Buffer) => {
    let message: any;
    try {
      message = JSON.parse(raw.toString('utf8'));
    } catch {
      return;
    }
    if (typeof message.id === 'number') {
      const call = pending.get(message.id);
      if (!call) return;
      pending.delete(message.id);
      clearTimeout(call.timer);
      if (message.error) call.reject(new Error(`${message.error.message ?? 'CDP error'} (${message.error.code ?? '?'})`));
      else call.resolve(message.result ?? {});
      return;
    }
    if (typeof message.method === 'string') {
      const event: CdpEvent = { method: message.method, params: message.params ?? {}, sessionId: message.sessionId };
      for (const handler of eventHandlers) {
        try {
          handler(event);
        } catch {
          /* a bad handler must not kill the connection */
        }
      }
    }
  });

  const shutdown = (): void => {
    if (closed) return;
    closed = true;
    for (const [, call] of pending) {
      clearTimeout(call.timer);
      call.reject(new Error('CDP connection closed'));
    }
    pending.clear();
    for (const handler of closeHandlers) {
      try {
        handler();
      } catch {
        /* ignore */
      }
    }
  };
  ws.on('close', shutdown);
  ws.on('error', shutdown);

  function post(method: string, params: Record<string, unknown> = {}, sessionId?: string): void {
    if (closed || ws.readyState !== WebSocket.OPEN) return;
    const id = nextId++;
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    // No pending entry: the reply is ignored, and unmatched ids are dropped above.
  }

  function send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> {
    if (closed || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('CDP connection closed'));
    }
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP ${method} timed out after ${callTimeoutMs}ms`));
      }, callTimeoutMs);
      timer.unref();
      pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  return {
    send,
    post,
    on: (handler) => void eventHandlers.push(handler),
    onClose: (handler) => void closeHandlers.push(handler),
    close: () => {
      shutdown();
      try {
        ws.close();
      } catch {
        /* already closing */
      }
    },
    get closed(): boolean {
      return closed;
    },
  };
}
