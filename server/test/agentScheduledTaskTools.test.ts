import { spawn, type ChildProcess } from 'node:child_process';
import http, { type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const SOURCE = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/mcp/agentToolsServer.ts');

// Each tool call is a fresh `node --import tsx` process, and a test that makes
// five of them in sequence needs far more than Vitest's stock 5s budget once
// the rest of the suite is competing for the machine.
const SPAWN_HEAVY_TIMEOUT_MS = 90_000;

type CapturedRequest = { method: string; path: string; body: Record<string, unknown> };
type RpcResponse = {
  result: {
    tools?: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
    content?: Array<{ type: string; text: string }>;
    isError?: boolean;
  };
};

describe('scheduled-agent MCP tools', () => {
  let server: Server;
  let baseUrl: string;
  let requests: CapturedRequest[];
  // Every rpc() spawns a real `node --import tsx` child. If one is still alive
  // when its test ends it keeps calling the capture server, and its late
  // requests land in the *next* test's array — which is how one slow test used
  // to fail two. Nothing outlives the test that started it.
  const children: ChildProcess[] = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let raw = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        const body = raw ? JSON.parse(raw) as Record<string, unknown> : {};
        const requestPath = req.url ?? '';
        requests.push({ method: req.method ?? 'GET', path: requestPath, body });
        res.setHeader('content-type', 'application/json');
        if (req.method === 'POST' && requestPath === '/api/scheduled-tasks') {
          res.end(JSON.stringify({ ok: true, scheduledTask: taskView(body) }));
        } else if (req.method === 'PATCH' && requestPath === '/api/scheduled-tasks/task-1') {
          res.end(JSON.stringify({ ok: true, scheduledTask: taskView(body) }));
        } else if (req.method === 'GET' && requestPath === '/api/scheduled-tasks/task-1/runs') {
          res.end(JSON.stringify({ ok: true, runs: [runView()] }));
        } else if (req.method === 'PATCH' && requestPath === '/api/scheduled-tasks/task-1/runs/run-1') {
          res.end(JSON.stringify({ ok: true, run: runView({ important: body.important }) }));
        } else if (req.method === 'POST' && requestPath === '/api/scheduled-tasks/task-1/run-now') {
          res.end(JSON.stringify({ ok: true, runId: 'run-new', conversationId: 'chat-new' }));
        } else if (req.method === 'DELETE' && requestPath === '/api/scheduled-tasks/task-1/runs/run-1') {
          res.end(JSON.stringify({ ok: true, archivedConversationId: 'chat-1' }));
        } else if (req.method === 'DELETE' && requestPath === '/api/scheduled-tasks/task-1') {
          res.end(JSON.stringify({ ok: true }));
        } else if (req.method === 'POST' && requestPath === '/api/memory') {
          res.end(JSON.stringify({ ok: true, memory: { id: 'memory-1', content: body.content } }));
        } else {
          res.statusCode = 404;
          res.end(JSON.stringify({ ok: false, error: `Unhandled ${req.method} ${requestPath}` }));
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => { requests = []; });

  afterEach(() => {
    for (const child of children.splice(0)) child.kill('SIGKILL');
  });

  function taskView(patch: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: 'task-1',
      name: 'Review',
      prompt: 'Review the report',
      assistantSlug: 'data-analyst',
      assistantName: 'Data Analyst',
      scheduleText: 'Every day at 9:00 AM',
      schedule: { type: 'daily', time: '09:00' },
      timezone: 'UTC',
      assistant: 'data-analyst',
      provider: 'codex',
      model: 'gpt-test',
      effort: 'high',
      projectId: 'project-1',
      projectName: 'Project 1',
      pinned: true,
      enabled: true,
      nextRunAt: '2026-08-15T09:00:00.000Z',
      upcomingRuns: ['2026-08-15T09:00:00.000Z'],
      ...patch,
    };
  }

  function runView(patch: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: 'run-1',
      status: 'completed',
      trigger: 'scheduled',
      scheduledFor: '2026-08-14T09:00:00.000Z',
      startedAt: '2026-08-14T09:00:00.000Z',
      finishedAt: '2026-08-14T09:01:00.000Z',
      important: false,
      conversationId: 'chat-1',
      conversationTitle: 'Review run',
      error: null,
      ...patch,
    };
  }

  async function rpc(
    method: string,
    params?: Record<string, unknown>,
    extraEnv: NodeJS.ProcessEnv = {},
  ): Promise<RpcResponse> {
    return new Promise<RpcResponse>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', SOURCE], {
        env: {
          ...process.env,
          VP_AGENT_TOKEN: 'test-token',
          VP_CONVERSATION_ID: 'source-chat',
          VP_INTERNAL_BASE_URL: baseUrl,
          ...extraEnv,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      children.push(child);
      let stdout = '';
      let stderr = '';
      // `node --import tsx` on a machine running the whole suite in parallel
      // forks needs seconds, not milliseconds, to boot.
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

  async function callTool(name: string, args: Record<string, unknown>): Promise<RpcResponse> {
    return rpc('tools/call', { name, arguments: args });
  }

  it('advertises every scheduled-agent action with explicit discovery and deletion guidance', async () => {
    const response = await rpc('tools/list');
    const tools = response.result.tools ?? [];
    const names = tools.map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining([
      'schedule_task',
      'list_scheduled_tasks',
      'read_scheduled_task',
      'update_scheduled_task',
      'list_scheduled_task_runs',
      'update_scheduled_task_run',
      'run_scheduled_task_now',
      'delete_scheduled_task_run',
      'delete_scheduled_task',
    ]));
    expect(tools.find((tool) => tool.name === 'list_scheduled_tasks')?.description).toContain('inspect/delete past runs');
    expect(tools.find((tool) => tool.name === 'delete_scheduled_task_run')?.description).toContain('Archived chats');
    expect(tools.find((tool) => tool.name === 'delete_scheduled_task')?.description).toContain('clearly asks');
  }, SPAWN_HEAVY_TIMEOUT_MS);

  it('omits and refuses the secret tools when secrets tooling is unavailable', async () => {
    // toolbox/materialize.ts sets this for a member turn, and whenever there is
    // no authenticated Doppler CLI to save to.
    const off = { VP_SECRET_TOOLS_DISABLED: '1' };
    const withSecrets = await rpc('tools/list');
    const withSecretNames = (withSecrets.result.tools ?? []).map((tool) => tool.name);
    expect(withSecretNames).toEqual(expect.arrayContaining(['request_secret', 'reveal_secret']));

    const listed = await rpc('tools/list', undefined, off);
    const names = (listed.result.tools ?? []).map((tool) => tool.name);
    expect(names).not.toContain('request_secret');
    expect(names).not.toContain('reveal_secret');
    expect(names).toContain('ask_user');

    // A cached tool list must not get through either.
    const called = await rpc(
      'tools/call',
      { name: 'request_secret', arguments: { name: 'STRIPE_API_KEY', purpose: 'Invoices.' } },
      off,
    );
    expect(called.result.isError).toBe(true);
    expect(called.result.content?.[0]?.text).toContain('Secrets tooling is not available');
    expect(requests).toEqual([]);
  }, SPAWN_HEAVY_TIMEOUT_MS);

  it('creates and edits with the complete scheduled-agent field set', async () => {
    const created = await callTool('schedule_task', {
      name: 'Review',
      prompt: 'Review the report',
      schedule_type: 'daily',
      time: '09:00',
      timezone: 'UTC',
      assistant: 'data-analyst',
      provider: 'codex',
      model: 'gpt-test',
      effort: 'high',
      project_id: 'project-1',
    });
    expect(created.result.content?.[0]?.text).toContain('Task id: task-1');
    expect(requests[0]).toEqual({
      method: 'POST',
      path: '/api/scheduled-tasks',
      body: {
        name: 'Review',
        prompt: 'Review the report',
        timezone: 'UTC',
        schedule: { type: 'daily', time: '09:00' },
        sourceConversationId: 'source-chat',
        assistantSlug: 'data-analyst',
        provider: 'codex',
        model: 'gpt-test',
        effort: 'high',
        projectId: 'project-1',
      },
    });

    requests = [];
    await callTool('update_scheduled_task', {
      task_id: 'task-1',
      name: 'Revised review',
      prompt: 'Use the revised prompt',
      schedule_type: 'weekly',
      time: '14:30',
      weekday: 5,
      timezone: 'America/New_York',
      enabled: false,
      pinned: true,
      project_id: null,
      assistant: 'assistant',
      provider: 'grok',
      model: null,
      effort: null,
    });
    expect(requests[0]).toEqual({
      method: 'PATCH',
      path: '/api/scheduled-tasks/task-1',
      body: {
        name: 'Revised review',
        prompt: 'Use the revised prompt',
        timezone: 'America/New_York',
        enabled: false,
        pinned: true,
        projectId: null,
        assistantSlug: 'assistant',
        provider: 'grok',
        model: null,
        effort: null,
        schedule: { type: 'weekly', time: '14:30', weekday: 5 },
      },
    });
  }, SPAWN_HEAVY_TIMEOUT_MS);

  it('maps run history, run updates, run-now, and both delete actions to the owner-scoped API', async () => {
    const history = await callTool('list_scheduled_task_runs', { task_id: 'task-1' });
    expect(history.result.content?.[0]?.text).toContain('Run id: run-1');

    await callTool('update_scheduled_task_run', { task_id: 'task-1', run_id: 'run-1', important: true });
    await callTool('run_scheduled_task_now', { task_id: 'task-1' });
    const deletedRun = await callTool('delete_scheduled_task_run', { task_id: 'task-1', run_id: 'run-1' });
    const deletedTask = await callTool('delete_scheduled_task', { task_id: 'task-1' });

    expect(requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
      'GET /api/scheduled-tasks/task-1/runs',
      'PATCH /api/scheduled-tasks/task-1/runs/run-1',
      'POST /api/scheduled-tasks/task-1/run-now',
      'DELETE /api/scheduled-tasks/task-1/runs/run-1',
      'DELETE /api/scheduled-tasks/task-1',
    ]);
    expect(deletedRun.result.content?.[0]?.text).toContain('preserved in Archived chats');
    expect(deletedTask.result.content?.[0]?.text).toContain('previous run chats were preserved');
  }, SPAWN_HEAVY_TIMEOUT_MS);

  it('makes an omitted memory project explicitly global', async () => {
    await callTool('save_memory', { content: 'Remember this globally.' });
    expect(requests[0]).toEqual({
      method: 'POST',
      path: '/api/memory',
      body: { content: 'Remember this globally.', isStatic: false, projectId: null },
    });

    requests = [];
    await callTool('save_memory', { content: 'Remember this for one project.', project_id: 'project-1' });
    expect(requests[0]?.body.projectId).toBe('project-1');
  }, SPAWN_HEAVY_TIMEOUT_MS);
});
