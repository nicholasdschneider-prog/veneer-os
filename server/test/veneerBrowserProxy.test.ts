import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeCurrentAgentToken } from '../src/runtime/agentTokenFile.js';
import { forwardMessage, resolveProxyToken } from '../src/mcp/veneerBrowserProxy.js';

describe('veneer browser stdio proxy', () => {
  const dirs: string[] = [];
  const servers: http.Server[] = [];

  afterEach(async () => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
    for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));
  });

  function listen(handler: http.RequestListener): Promise<string> {
    const server = http.createServer(handler);
    servers.push(server);
    return new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as { port: number };
        resolve(`http://127.0.0.1:${addr.port}/mcp/veneer-browser`);
      });
    });
  }

  it('prefers the per-conversation token file and falls back to the env token', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-browser-proxy-'));
    dirs.push(dir);
    const file = writeCurrentAgentToken('conversation-1', 'fresh-token', dir)!;
    expect(resolveProxyToken({ VP_AGENT_TOKEN: 'stale-token', VP_CONVERSATION_ID: 'conversation-1', VP_AGENT_TOKEN_FILE: file })).toBe('fresh-token');
    expect(resolveProxyToken({ VP_AGENT_TOKEN: 'env-token', VP_CONVERSATION_ID: 'conversation-2', VP_AGENT_TOKEN_FILE: path.join(dir, 'missing') })).toBe('env-token');
    expect(resolveProxyToken({ VP_AGENT_TOKEN: 'env-token' })).toBe('env-token');
  });

  it('sends the current token on every request and relays the JSON-RPC response', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-browser-proxy-'));
    dirs.push(dir);
    const file = writeCurrentAgentToken('conversation-1', 'first-token', dir)!;
    const seen: string[] = [];
    const url = await listen((req, res) => {
      seen.push(String(req.headers['x-vp-agent-token']));
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const msg = JSON.parse(body) as { id?: number; method: string };
        if (msg.method === 'notifications/initialized') { res.writeHead(202); res.end(); return; }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { echoed: msg.method } }));
      });
    });
    const env = { VP_VENEER_BROWSER_URL: url, VP_AGENT_TOKEN: 'stale-token', VP_CONVERSATION_ID: 'conversation-1', VP_AGENT_TOKEN_FILE: file };

    const first = await forwardMessage(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), env);
    expect(JSON.parse(first!)).toEqual({ jsonrpc: '2.0', id: 1, result: { echoed: 'tools/list' } });

    expect(await forwardMessage(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }), env)).toBeNull();

    writeCurrentAgentToken('conversation-1', 'second-token', dir);
    const second = await forwardMessage(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call' }), env);
    expect(JSON.parse(second!).id).toBe(2);
    expect(seen).toEqual(['first-token', 'first-token', 'second-token']);
  });

  it('turns a non-2xx status into a JSON-RPC error carrying the server message', async () => {
    const url = await listen((_req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Veneer Browser requires an authenticated chat.' }));
    });
    const out = await forwardMessage(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list' }), { VP_VENEER_BROWSER_URL: url, VP_AGENT_TOKEN: 'x' });
    expect(JSON.parse(out!)).toEqual({
      jsonrpc: '2.0',
      id: 7,
      error: { code: -32000, message: 'Veneer Browser MCP returned HTTP 401: Veneer Browser requires an authenticated chat.' },
    });
  });
});
