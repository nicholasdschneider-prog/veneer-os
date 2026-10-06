import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';

export interface BridgeProvenance {
  conversationId: string; actorUserId: number; clientScope: string; cloneId: string;
  sourceProfileId: string; sourceGeneration: number; runtimeId: string; processGeneration: string;
}

interface Bridge {
  provenance?: BridgeProvenance;
  target: string;
  certificate: string;
  caFile: string;
  url: string;
  close(): void;
}

const bridges = new Map<string, Bridge>();

/** The native CLI cannot add private TLS roots. Terminate its local connection
 * here, then validate the manager's WSS connection against its pinned PEM.
 * This never connects directly to Chrome or relaxes the manager's CDP gates.
 * The listener is loopback-only, capability protected, and rejects browser
 * Origins so a web page cannot use it. Tickets and traffic stay in memory.
 */
export async function pinnedCdpAddress(session: string, target: string, caFile: string, provenance?: BridgeProvenance): Promise<string> {
  const upstreamUrl = new URL(target);
  if (upstreamUrl.protocol !== 'wss:' || !upstreamUrl.pathname.startsWith('/cdp/')) {
    throw new Error('The pinned browser control address must use WSS.');
  }
  const certificate = fs.readFileSync(caFile, 'utf8');
  const held = bridges.get(session);
  if (held?.target === target && held.certificate === certificate) return held.url;
  closePinnedCdpBridge(session);

  const capability = `/cdp/${crypto.randomBytes(32).toString('hex')}/ws`;
  const server = http.createServer((_req, res) => { res.writeHead(404).end(); });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
  const upstreams = new Set<WebSocket>();
  let closed = false;
  server.on('upgrade', (req, socket, head) => {
    if (closed || req.url !== capability || req.headers.origin || req.headers.host !== new URL(bridge.url).host) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    const upstream = new WebSocket(target, {
      ca: certificate,
      rejectUnauthorized: true,
      followRedirects: false,
      handshakeTimeout: 10_000,
      maxPayload: 64 * 1024 * 1024,
    });
    upstreams.add(upstream);
    let downstream: WebSocket | undefined;
    const abort = (): void => {
      upstream.terminate();
      downstream?.terminate();
      socket.destroy();
    };
    // Never expose the upstream error: it may contain a control ticket.
    upstream.on('error', abort);
    upstream.on('close', () => {
      upstreams.delete(upstream);
      downstream?.terminate();
      if (!downstream) socket.destroy();
    });
    socket.on('error', abort);
    socket.on('close', () => upstream.terminate());
    upstream.once('open', () => {
      if (closed || socket.destroyed) { upstream.terminate(); return; }
      wss.handleUpgrade(req, socket, head, (client) => {
        downstream = client;
        client.on('error', abort);
        client.on('close', () => upstream.terminate());
        client.on('message', (data, isBinary) => {
          if (!closed && upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
        });
        upstream.on('message', (data, isBinary) => {
          if (!closed && client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
        });
      });
    });
  });
  const bridge: Bridge = {
    target, certificate, caFile, url: '', ...(provenance ? { provenance: { ...provenance } } : {}),
    close: () => {
      closed = true;
      for (const socket of upstreams) socket.terminate();
      for (const socket of wss.clients) socket.terminate();
      wss.close();
      server.close();
    },
  };
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  server.unref();
  const address = server.address();
  if (!address || typeof address === 'string') { bridge.close(); throw new Error('Browser adapter could not listen.'); }
  bridge.url = `ws://127.0.0.1:${address.port}${capability}`;
  bridges.set(session, bridge);
  return bridge.url;
}

export function closePinnedCdpBridge(session: string): void {
  bridges.get(session)?.close();
  bridges.delete(session);
}

/** Fail closed unless this process owns the exact controller's pinned bridge. */
export function disconnectPinnedCdpBridge(session: string): boolean {
  if (!bridges.has(session)) return false;
  closePinnedCdpBridge(session);
  return true;
}

/** Fixed metadata read on the EXISTING pinned bridge. No ticket, bridge creation,
 * CLI, target attachment, navigation, script or recovery is permitted here.
 * Legacy bridges cannot acquire provenance retroactively by inspection.
 */
export async function inspectPinnedTabs(session: string, expected: BridgeProvenance, beforeRead: () => Promise<void> = async () => {}): Promise<Array<{target_id:string; title:string; url:string}>> {
  const bridge = bridges.get(session);
  const matches = () => {
    try {
      return bridges.get(session) === bridge && bridge?.provenance
        && fs.readFileSync(bridge.caFile, 'utf8') === bridge.certificate
        && JSON.stringify(bridge.provenance) === JSON.stringify(expected);
    } catch { return false; }
  };
  if (!matches() || !bridge) throw new Error('Authenticated existing bridge provenance unavailable.');
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(bridge.url, {handshakeTimeout: 3000, maxPayload: 1024 * 1024});
    let finished = false;
    const finish = (tabs?: Array<{target_id:string;title:string;url:string}>) => {
      if (finished) return;
      finished = true; clearTimeout(timer); socket.terminate();
      if (tabs && matches()) resolve(tabs);
      else reject(new Error('Read-only bridge inspection unavailable.'));
    };
    const timer = setTimeout(() => finish(), 5000);
    socket.on('error', () => finish());
    socket.on('close', () => finish());
    socket.once('open', async () => {
      try {
        await beforeRead();
        if (finished || !matches()) return finish();
        socket.send(JSON.stringify({id:1, method:'Target.getTargets'}));
      } catch { finish(); }
    });
    socket.on('message', data => {
      try {
        const response = JSON.parse(data.toString());
        if (response.id !== 1) return;
        if (response.error || !Array.isArray(response.result?.targetInfos)) return finish();
        const tabs = response.result.targetInfos.filter((t: {type?:string}) => t.type === 'page').slice(0, 100)
          .map((t: {targetId?:unknown;title?:unknown;url?:unknown}) => {
            if (typeof t.targetId !== 'string' || typeof t.title !== 'string' || typeof t.url !== 'string') throw new Error();
            const url = new URL(t.url);
            // Never return credentials, query tokens, fragment links or internal pages.
            if (!['https:', 'http:'].includes(url.protocol)) return null;
            url.username = ''; url.password = ''; url.search = ''; url.hash = '';
            return {target_id:t.targetId.slice(0,200), title:t.title.slice(0,500), url:url.toString()};
          }).filter((t: unknown) => t !== null);
        finish(tabs);
      } catch { finish(); }
    });
  });
}
