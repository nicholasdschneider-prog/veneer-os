import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';

interface Bridge {
  target: string;
  certificate: string;
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
export async function pinnedCdpAddress(session: string, target: string, caFile: string): Promise<string> {
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
  server.on('upgrade', (req, socket, head) => {
    if (req.url !== capability || req.headers.origin || req.headers.host !== new URL(bridge.url).host) {
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
      if (socket.destroyed) { upstream.terminate(); return; }
      wss.handleUpgrade(req, socket, head, (client) => {
        downstream = client;
        client.on('error', abort);
        client.on('close', () => upstream.terminate());
        client.on('message', (data, isBinary) => {
          if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
        });
        upstream.on('message', (data, isBinary) => {
          if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
        });
      });
    });
  });
  const bridge: Bridge = {
    target, certificate, url: '',
    close: () => {
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
