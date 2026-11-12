import { spawn, type ChildProcess } from 'node:child_process';
import http, { type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const SOURCE = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/mcp/agentToolsServer.ts');
const SPAWN_HEAVY_TIMEOUT_MS = 90_000;

type RpcResponse = {
  result: {
    tools?: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
    content?: Array<{ type: string; text: string }>;
    isError?: boolean;
  };
};

describe('list_build_queue MCP tool', () => {
  let server: Server;
  let baseUrl: string;
  let payload: Record<string, unknown> = {};
  const children: ChildProcess[] = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(payload));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  beforeEach(() => { payload = {}; });
  afterEach(() => {
    for (const child of children.splice(0)) child.kill('SIGKILL');
  });

  async function rpc(method: string, params?: Record<string, unknown>): Promise<RpcResponse> {
    return new Promise<RpcResponse>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', SOURCE], {
        env: { ...process.env, VP_AGENT_TOKEN: 'test-token', VP_CONVERSATION_ID: 'build-chat', VP_INTERNAL_BASE_URL: baseUrl },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      children.push(child);
      let stdout = '';
      let stderr = '';
      const timeout = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`MCP response timed out: ${stderr}`));
      }, 30_000);
      child.stderr.on('data', (chunk) => { stderr += String(chunk); });
      child.stdout.on('data', (chunk) => {
        stdout += String(chunk);
        const newline = stdout.indexOf('\n');
        if (newline < 0) return;
        clearTimeout(timeout);
        const response = JSON.parse(stdout.slice(0, newline)) as RpcResponse;
        child.stdin.end();
        child.kill();
        resolve(response);
      });
      child.on('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })}\n`);
    });
  }
  const listQueue = async () => (await rpc('tools/call', { name: 'list_build_queue', arguments: {} })).result.content?.[0]?.text ?? '';
  const job = { id: 1058, position: 1, status: 'queued', title: 'Answer cards', scopeKey: 'project:p', projectName: 'ERVP' };

  it('puts the disk-low pause line above the queue so bots know why it is not starting', async () => {
    payload = { ok: true, jobs: [job], diskFloor: { line: 'Paused: disk low (10.8 GiB free, needs 12.0). Builds and bot wake-ups resume automatically once space is freed.' } };
    expect(await listQueue()).toBe('Paused: disk low (10.8 GiB free, needs 12.0). Builds and bot wake-ups resume automatically once space is freed.\nBuild queues:\nERVP 1. #1058 [queued] Answer cards');
    payload = { ok: true, jobs: [job], diskFloor: null };
    expect(await listQueue()).toBe('Build queues:\nERVP 1. #1058 [queued] Answer cards');
  }, SPAWN_HEAVY_TIMEOUT_MS);
});
