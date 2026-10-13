import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { guardSetTypeOfService } from '../src/net/typeOfServiceGuard.js';
import { createRunnerClient, READ_ONLY_RPCS, runnerUnreachableMessage } from '../src/runner/client.js';
import { probeRunnerRpc, RUNNER_RPC_PROBE_ID } from '../src/runner/rpcProbe.js';

const errno = (code: string, syscall: string) => Object.assign(new Error(`${syscall} ${code}`), { code, syscall });
const guardModule = fileURLToPath(new URL('../src/net/typeOfServiceGuard.ts', import.meta.url));

describe('setTypeOfService guard', () => {
  it('converts only setTypeOfService EINVAL into a no-op and rethrows everything else', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const socket = {} as net.Socket;
    const einval = guardSetTypeOfService(() => { throw errno('EINVAL', 'setTypeOfService'); });
    expect(einval.call(socket, 0)).toBe(socket);
    expect(() => guardSetTypeOfService(() => { throw errno('EPERM', 'setTypeOfService'); }).call(socket, 0)).toThrow('EPERM');
    expect(() => guardSetTypeOfService(() => { throw errno('EINVAL', 'write'); }).call(socket, 0)).toThrow('write EINVAL');
    const ok = guardSetTypeOfService(function (this: net.Socket) { return this; });
    expect(ok.call(socket, 0)).toBe(socket);
  });

  // The crash needs the reset to land while the client's event loop is busy, so
  // the client runs in its own process and stalls between requests, like web
  // during a synchronous SQLite busy wait.
  it('keeps a process alive when peers reset connections during an event-loop stall', async () => {
    const server = net.createServer((socket) => socket.resetAndDestroy());
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tos-guard-'));
    try {
      const script = path.join(dir, 'client.mjs');
      fs.writeFileSync(script, `
        (await import(${JSON.stringify(guardModule)})).installTypeOfServiceGuard();
        process.on('uncaughtException', (e) => { console.log('UNCAUGHT', e.code, e.syscall); process.exit(3); });
        const results = new Set();
        for (let i = 0; i < 120; i++) {
          const p = fetch('http://127.0.0.1:${(server.address() as net.AddressInfo).port}/rpc/status').then(() => 'ok', () => 'rejected');
          for (let k = 0; k < i % 4; k++) await new Promise((r) => setImmediate(r));
          const until = Date.now() + 20; while (Date.now() < until) {}
          results.add(await p);
        }
        console.log('done ' + [...results].join(','));
      `);
      const child = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      child.stdout.on('data', (d) => (output += d));
      const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
      expect(output).not.toContain('UNCAUGHT');
      expect(code).toBe(0);
      expect(output).toContain('done rejected');
      expect(output).not.toContain('ok');
    } finally {
      server.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('runner RPC client socket failures', () => {
  let server: http.Server | undefined;
  let dataDir: string | undefined;
  afterEach(async () => {
    if (server) await new Promise((resolve) => server!.close(resolve));
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
    server = undefined;
    dataDir = undefined;
  });

  async function runner(handler: (path: string, attempt: number, req: http.IncomingMessage, res: http.ServerResponse) => void) {
    const attempts = new Map<string, number>();
    server = http.createServer((req, res) => {
      const p = (req.url ?? '').split('?')[0]!;
      const n = (attempts.get(p) ?? 0) + 1;
      attempts.set(p, n);
      req.resume();
      req.on('end', () => handler(p, n, req, res));
    });
    server.on('upgrade', (_req, socket) => socket.destroy());
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-client-'));
    const client = createRunnerClient({ baseUrl: `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`, dataDir });
    return { client, attempts };
  }

  it('retries a read-only RPC once after a reset socket', async () => {
    const { client, attempts } = await runner((p, n, req, res) => {
      if (n === 1) return req.socket.resetAndDestroy();
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ status: 'idle' }));
    });
    try {
      await expect(client.statusOf('chat')).resolves.toBe('idle');
      expect(attempts.get('/rpc/status')).toBe(2);
    } finally {
      client.close();
    }
  });

  it('never re-sends an effectful RPC and reports its outcome as unknown', async () => {
    const { client, attempts } = await runner((_p, _n, req) => req.socket.resetAndDestroy());
    try {
      await expect(client.enqueueBuild('chat', 'title', 'brief', 1)).rejects.toThrow(/runner unreachable \(\/rpc\/enqueueBuild\).*outcome unknown/);
      expect(attempts.get('/rpc/enqueueBuild')).toBe(1);
    } finally {
      client.close();
    }
  });

  it('labels refused connections as not delivered and keeps reads free of UNKNOWN wording', () => {
    const refused = new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
    expect(runnerUnreachableMessage('/rpc/postMessage', refused)).toBe('runner unreachable (/rpc/postMessage): fetch failed (ECONNREFUSED); not delivered');
    expect(runnerUnreachableMessage('/rpc/status', refused)).toBe('runner unreachable (/rpc/status): fetch failed (ECONNREFUSED)');
    for (const effectful of ['/rpc/postMessage', '/rpc/enqueueBuild', '/rpc/interrupt', '/rpc/restart', '/rpc/resolveApproval', '/rpc/usage'])
      expect(READ_ONLY_RPCS.has(effectful)).toBe(false);
  });
});

describe('runner RPC reachability probe', () => {
  it('reports the authenticated RPC path apart from /healthz', async () => {
    const statusOf = vi.fn(async () => 'idle');
    await expect(probeRunnerRpc(statusOf)).resolves.toMatchObject({ ok: true, runner_rpc: 'healthy' });
    expect(statusOf).toHaveBeenCalledWith(RUNNER_RPC_PROBE_ID);
    await expect(probeRunnerRpc(async () => { throw new Error('runner unreachable (/rpc/status): fetch failed (ECONNRESET)'); }))
      .resolves.toMatchObject({ ok: false, runner_rpc: 'unavailable', error: expect.stringContaining('ECONNRESET') });
    await expect(probeRunnerRpc(() => new Promise(() => {}), 20)).resolves.toMatchObject({ ok: false, error: 'runner RPC timed out after 20 ms' });
  });

  it('is served by web as its own endpoint next to /healthz', () => {
    const source = fs.readFileSync(fileURLToPath(new URL('../src/index.ts', import.meta.url)), 'utf8');
    expect(source).toContain("app.get('/healthz/runner-rpc'");
    for (const entry of ['index.ts', 'runner/index.ts', 'appRunner/index.ts', 'terminalService/index.ts'])
      expect(fs.readFileSync(fileURLToPath(new URL(`../src/${entry}`, import.meta.url)), 'utf8')).toMatch(/installTypeOfServiceGuard\(\);\nloadEnvFile\(\);/);
  });
});
