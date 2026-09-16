import http from 'node:http';
import type { LocalAppManager } from './manager.js';

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(data)) });
  res.end(data);
}

async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > 64 * 1024) throw new Error('IPC body too large');
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

export function createAppRunnerIpcServer(manager: LocalAppManager | null): http.Server {
  return http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/healthz') {
        sendJson(res, 200, { ok: true });
        return;
      }
      const appMatch = url.pathname.match(/^\/apps\/([^/]+)(\/.*)?$/);
      if (appMatch) {
        if (!manager) {
          res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('Local app hosting requires VP_APPS_PUBLIC_ORIGIN.');
          return;
        }
        const appId = decodeURIComponent(appMatch[1]!);
        const targetPath = `${appMatch[2] || '/'}${url.search}`;
        await manager.proxy(appId, req, res, targetPath);
        return;
      }

      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' });
        return;
      }
      if (!manager) {
        sendJson(res, 503, { ok: false, error: 'VP_APPS_PUBLIC_ORIGIN is required for local app hosting' });
        return;
      }
      const body = await readBody(req);
      const appId = String(body.appId ?? '');
      if (url.pathname === '/rpc/deploy') {
        await manager.deploy(appId);
        sendJson(res, 200, { ok: true });
      } else if (url.pathname === '/rpc/remove') {
        await manager.remove(appId);
        sendJson(res, 200, { ok: true });
      } else if (url.pathname === '/rpc/statuses') {
        const appIds = Array.isArray(body.appIds) ? body.appIds.slice(0, 500).map(String) : [];
        sendJson(res, 200, { ok: true, statuses: manager.statuses(appIds) });
      } else {
        sendJson(res, 404, { ok: false, error: 'unknown endpoint' });
      }
    })().catch((error: Error) => {
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: error.message });
      else res.destroy(error);
    });
  });
}
