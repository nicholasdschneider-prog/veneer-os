import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  bridgeNodeOptions,
  codexMcpServers,
  codexThreadConfig,
  MCP_REMOTE_STARTUP_TIMEOUT_SEC,
} from '../src/providers/agentsMcp.js';
import { markInitializeUncacheable, MCP_REMOTE_VERSION, resolveMcpRemoteProxy } from '../src/mcp/mcpRemoteBridge.js';

const BRIDGE_SOURCE = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/mcp/mcpRemoteBridge.ts');
const CACHE_FLAG = 'codex/tool-catalog-cache';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-mcp-bridge-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeConfig(servers: Record<string, unknown>): string {
  const configPath = path.join(tmpDir(), 'mcp.json');
  fs.writeFileSync(configPath, JSON.stringify({ mcpServers: servers }));
  return configPath;
}

describe('codexMcpServers mcp-remote bridge shaping', () => {
  it('launches the pinned bridge with node, header values in env and a startup timeout', () => {
    const servers = codexMcpServers(
      writeConfig({
        'gmail-help': {
          type: 'http',
          url: 'https://backend.composio.dev/v3/mcp/abc',
          headers: { 'x-api-key': 'secret-value', 'x-user-id': 'user-1' },
        },
      }),
    );
    const bridge = servers['gmail-help']!;
    expect(bridge.command).toBe(process.execPath);
    const args = bridge.args as string[];
    expect(path.basename(args[0]!)).toBe('mcpRemoteBridge.js');
    expect(args.slice(1)).toEqual([
      'https://backend.composio.dev/v3/mcp/abc',
      '--header',
      'x-api-key:${MCP_HEADER_0}',
      '--header',
      'x-user-id:${MCP_HEADER_1}',
    ]);
    expect(JSON.stringify(args)).not.toContain('secret-value');
    expect(JSON.stringify(bridge)).not.toContain('npx');
    const env = bridge.env as Record<string, string>;
    expect(env.MCP_HEADER_0).toBe('secret-value');
    expect(env.MCP_HEADER_1).toBe('user-1');
    expect(env.NODE_OPTIONS).toContain('--network-family-autoselection-attempt-timeout=2000');
    expect(bridge.startup_timeout_sec).toBe(MCP_REMOTE_STARTUP_TIMEOUT_SEC);
  });

  it('merges the connect-attempt timeout into existing NODE_OPTIONS without duplicating it', () => {
    expect(bridgeNodeOptions(undefined)).toBe('--network-family-autoselection-attempt-timeout=2000');
    expect(bridgeNodeOptions('--max-old-space-size=4096')).toBe(
      '--max-old-space-size=4096 --network-family-autoselection-attempt-timeout=2000',
    );
    expect(bridgeNodeOptions('--network-family-autoselection-attempt-timeout=5000')).toBe(
      '--network-family-autoselection-attempt-timeout=5000',
    );
  });

  it('waits for bridged startup only when a bridged server is present', () => {
    const bridged = codexThreadConfig(
      writeConfig({
        agents: { command: 'node', args: ['agents.js'], env: {} },
        runway: { type: 'http', url: 'http://127.0.0.1:3101/mcp/runway', headers: { Authorization: 'Bearer x' } },
      }),
    );
    expect(bridged?.mcp_optional_startup_grace_ms).toBe(0);
    expect(Object.keys(bridged?.mcp_servers as object)).toEqual(['agents', 'runway']);

    const plain = codexThreadConfig(writeConfig({ agents: { command: 'node', args: ['agents.js'], env: {} } }));
    expect(plain).not.toHaveProperty('mcp_optional_startup_grace_ms');
    expect(codexThreadConfig(writeConfig({}))).toBeUndefined();
  });
});

describe('markInitializeUncacheable', () => {
  it('opts an initialize result out of the Codex tool-catalog cache, keeping its capabilities', () => {
    const line = JSON.stringify({
      jsonrpc: '2.0',
      id: 0,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: { listChanged: true }, experimental: { other: { a: 1 } } },
        serverInfo: { name: 'composio', version: '1' },
      },
    });
    const out = JSON.parse(markInitializeUncacheable(line));
    expect(out.result.capabilities.tools).toEqual({ listChanged: true });
    expect(out.result.capabilities.experimental).toEqual({ other: { a: 1 }, [CACHE_FLAG]: { cacheable: false } });
    expect(out.result.serverInfo).toEqual({ name: 'composio', version: '1' });
  });

  it('passes every other line through byte for byte', () => {
    const lines = [
      '{"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"GMAIL_GET_PROFILE"}]}}',
      '{"jsonrpc":"2.0","method":"initialize","id":0,"params":{"protocolVersion":"2025-06-18"}}',
      '{"jsonrpc":"2.0","method":"notifications/tools/list_changed"}',
      'not json "protocolVersion"',
    ];
    for (const line of lines) expect(markInitializeUncacheable(line)).toBe(line);
  });
});

/** A minimal streamable-HTTP MCP server that records the headers it was sent. */
async function fakeRemote(): Promise<{ url: string; seenKeys: string[] }> {
  const seenKeys: string[] = [];
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }
    seenKeys.push(String(req.headers['x-api-key'] ?? ''));
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const msg = JSON.parse(body) as { id?: number; method: string };
      if (msg.id === undefined) {
        res.writeHead(202).end();
        return;
      }
      const result =
        msg.method === 'initialize'
          ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } }
          : msg.method === 'tools/list'
            ? { tools: [{ name: 'GMAIL_GET_PROFILE', inputSchema: { type: 'object', properties: {} } }] }
            : msg.method === 'tools/call'
              ? { content: [{ type: 'text', text: 'help@example.test' }] }
              : {};
      res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'session-1' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, seenKeys };
}

function startBridge(url: string): { child: ChildProcessWithoutNullStreams; next: (ms: number) => Promise<Record<string, any> | null> } {
  const configDir = tmpDir();
  const child = spawn(process.execPath, ['--import', 'tsx', BRIDGE_SOURCE, url, '--header', 'x-api-key:${MCP_HEADER_0}'], {
    env: { ...process.env, MCP_HEADER_0: 'key-from-env', MCP_REMOTE_CONFIG_DIR: configDir, NODE_OPTIONS: bridgeNodeOptions('') },
  });
  cleanups.push(() => {
    child.kill('SIGKILL');
  });
  const queue: Record<string, any>[] = [];
  const waiters: Array<(m: Record<string, any> | null) => void> = [];
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    const msg = JSON.parse(line) as Record<string, any>;
    const waiter = waiters.shift();
    if (waiter) waiter(msg);
    else queue.push(msg);
  });
  child.stderr.resume();
  const next = (ms: number) =>
    queue.length
      ? Promise.resolve(queue.shift()!)
      : new Promise<Record<string, any> | null>((resolve) => {
          const timer = setTimeout(() => {
            const i = waiters.indexOf(done);
            if (i >= 0) waiters.splice(i, 1);
            resolve(null);
          }, ms);
          const done = (m: Record<string, any> | null) => {
            clearTimeout(timer);
            resolve(m);
          };
          waiters.push(done);
        });
  return { child, next };
}

const send = (child: ChildProcessWithoutNullStreams, msg: object) => child.stdin.write(`${JSON.stringify(msg)}\n`);
const initialize = {
  jsonrpc: '2.0',
  id: 0,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'codex', version: '0.162.1' } },
};

describe('mcp-remote bridge readiness harness', () => {
  it('resolves the pinned mcp-remote install', () => {
    const proxy = resolveMcpRemoteProxy();
    expect(proxy).toBeTruthy();
    const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(proxy!), '..', 'package.json'), 'utf8')) as { version: string };
    expect(pkg.version).toBe(MCP_REMOTE_VERSION);
  });

  it('marks the live initialize uncacheable, then lists and calls tools with the env header', async () => {
    const remote = await fakeRemote();
    const { child, next } = startBridge(remote.url);
    send(child, initialize);
    const init = await next(20_000);
    expect(init?.result?.capabilities?.experimental?.[CACHE_FLAG]).toEqual({ cacheable: false });
    send(child, { jsonrpc: '2.0', method: 'notifications/initialized' });
    send(child, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    const list = await next(10_000);
    expect(list?.result?.tools?.map((t: { name: string }) => t.name)).toEqual(['GMAIL_GET_PROFILE']);
    send(child, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'GMAIL_GET_PROFILE', arguments: {} } });
    const call = await next(10_000);
    expect(call?.result?.content?.[0]?.text).toBe('help@example.test');
    expect(remote.seenKeys.length).toBeGreaterThan(0);
    expect(remote.seenKeys.every((k) => k === 'key-from-env')).toBe(true);
  }, 45_000);

  it('offers no tools when the remote never becomes ready', async () => {
    // A port with nothing listening: the bridge has no live client, so Codex
    // must get no initialize result and no tool list to bind.
    const probe = http.createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const { child, next } = startBridge(`http://127.0.0.1:${port}/mcp`);
    send(child, initialize);
    send(child, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    const seen: Record<string, any>[] = [];
    for (let m = await next(8_000); m; m = await next(2_000)) seen.push(m);
    expect(seen.some((m) => m.result?.protocolVersion || Array.isArray(m.result?.tools))).toBe(false);
  }, 45_000);
});
