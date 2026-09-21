import { spawn, type ChildProcess } from 'node:child_process';
import http, { type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const SOURCE = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/mcp/agentToolsServer.ts');
const SPAWN_HEAVY_TIMEOUT_MS = 90_000;

type CapturedRequest = { method: string; path: string; body: Record<string, unknown> };
type RpcResponse = {
  result: {
    tools?: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
    content?: Array<{ type: string; text: string }>;
    isError?: boolean;
  };
};

describe('huddle MCP tools', () => {
  let server: Server;
  let baseUrl: string;
  let requests: CapturedRequest[];
  const children: ChildProcess[] = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let raw = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
        requests.push({ method: req.method ?? 'GET', path: req.url ?? '', body });
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ ok: true, huddle: { id: 'h-1', goal: 'Fixture goal' }, created: true }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  beforeEach(() => {
    requests = [];
  });
  afterEach(() => {
    for (const child of children.splice(0)) child.kill('SIGKILL');
  });

  async function rpc(method: string, params?: Record<string, unknown>): Promise<RpcResponse> {
    return new Promise<RpcResponse>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', SOURCE], {
        env: { ...process.env, VP_AGENT_TOKEN: 'test-token', VP_CONVERSATION_ID: 'bot-lead', VP_INTERNAL_BASE_URL: baseUrl },
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
  const callTool = (name: string, args: Record<string, unknown>) => rpc('tools/call', { name, arguments: args });

  it('advertises the huddle tools with the direct-message boundary spelled out', async () => {
    const tools = (await rpc('tools/list')).result.tools ?? [];
    const names = tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining([
      'open_huddle', 'list_huddles', 'read_huddle', 'post_huddle_message', 'invite_to_huddle',
      'update_huddle_action', 'update_huddle', 'close_huddle', 'reopen_huddle',
    ]));
    const open = tools.find((t) => t.name === 'open_huddle')!;
    expect(open.description).toContain('at least two other registered bots');
    expect(open.description).toContain('send_message');
    expect((open.inputSchema.required as string[])).toEqual(['goal', 'why', 'members', 'request_key']);
    expect(tools.find((t) => t.name === 'post_huddle_message')!.description).toContain('never to everyone');
  }, SPAWN_HEAVY_TIMEOUT_MS);

  it('routes every tool to the REST surface under the agent token, so authority is decided server-side', async () => {
    await callTool('open_huddle', { goal: 'Fixture goal', why: 'Three bots', members: ['bot-a', 'bot-b'], request_key: 'k' });
    await callTool('post_huddle_message', { huddle_id: 'h-1', text: 'Hi', mentions: ['bot-a'], kind: 'handoff', request_key: 'm' });
    await callTool('read_huddle', { huddle_id: 'h-1', after_seq: 3 });
    await callTool('update_huddle_action', { huddle_id: 'h-1', title: 'Ship it', owner: 'bot-a' });
    await callTool('update_huddle_action', { huddle_id: 'h-1', action_id: 'a-1', status: 'done' });
    await callTool('close_huddle', { huddle_id: 'h-1', verification: 'Verified end to end.' });
    expect(requests.map((r) => [r.method, r.path])).toEqual([
      ['POST', '/api/huddles'],
      ['POST', '/api/huddles/h-1/messages'],
      ['GET', '/api/huddles/h-1?ack=1&after=3'],
      ['POST', '/api/huddles/h-1/actions'],
      ['PATCH', '/api/huddles/h-1/actions/a-1'],
      ['POST', '/api/huddles/h-1/close'],
    ]);
    expect(requests[0]!.body).toMatchObject({ goal: 'Fixture goal', members: ['bot-a', 'bot-b'], request_key: 'k' });
    expect(requests[1]!.body).toMatchObject({ text: 'Hi', targets: ['bot-a'], kind: 'handoff', request_key: 'm' });
    expect(requests[3]!.body).toEqual({ title: 'Ship it', owner: 'bot-a' });
    expect(requests[4]!.body).toEqual({ status: 'done' });
  }, SPAWN_HEAVY_TIMEOUT_MS);
});
