import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { appServerArgs, AppServerClient } from '../src/providers/codexAppServer/protocol.js';
import { createCodexAdapter } from '../src/providers/codexAppServer/adapter.js';
import { codexMcpServers } from '../src/providers/agentsMcp.js';
import type { BrowserRunResult } from '../src/mcp/agentBrowser.js';
import type { TurnSpec } from '../src/providers/types.js';
import type { ConversationEvent } from '../src/runtime/events.js';
import { _setMediaDirForTest, mediaFilePath } from '../src/runtime/media.js';
import { sharedDesktopUrl } from '../src/mcp/agentBrowser.js';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/fake-app-server.mjs');
const silent = { warn() {}, error() {} };
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TEST_DEVELOPER_INSTRUCTIONS = '# Core Veneer rules\n\n# Fixed chat context';

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  message: string,
  // Generous by default: these predicates wait on real child processes, and
  // under the full suite a node spawn can take a second on its own.
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error(message);
    await delay(20);
  }
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codex-app-server-test-'));
}

function turnSpec(over: Partial<TurnSpec> = {}): TurnSpec {
  return {
    cwd: os.tmpdir(),
    nativeSessionId: 't1',
    firstTurn: true,
    prompt: 'hi',
    turnId: 'turn-1',
    dangerous: true,
    developerInstructions: TEST_DEVELOPER_INSTRUCTIONS,
    ...over,
  };
}

describe('AppServerClient cleanup (BUG 5)', () => {
  it('gates the code-mode disable flags on the codex version', () => {
    const legacy = [
      'app-server',
      '--stdio',
      '--disable',
      'code_mode_host',
      '--disable',
      'tool_search_always_defer_mcp_tools',
    ];
    // 0.147+ owns its code-mode host process; disabling it breaks every exec
    // call ("code-mode host is disabled") instead of hiding the tool.
    expect(appServerArgs('codex-cli 0.147.0')).toEqual(['app-server', '--stdio']);
    expect(appServerArgs('codex-cli 0.153.4')).toEqual(['app-server', '--stdio']);
    expect(appServerArgs('codex-cli 1.0.0')).toEqual(['app-server', '--stdio']);
    // Older still needs the client-hosted wrapper disabled, and an unreadable
    // version must keep the previously shipped behavior.
    expect(appServerArgs('codex-cli 0.146.0')).toEqual(legacy);
    expect(appServerArgs('codex-cli 0.139.0')).toEqual(legacy);
    expect(appServerArgs(null)).toEqual(legacy);
    expect(appServerArgs('not a version')).toEqual(legacy);
  });

  it('rejects pending requests on spawn failure instead of hanging forever', async () => {
    // Binary missing → Node fires 'error'/'close' but never 'exit'; the request
    // must still settle (reject), not await a dead promise.
    const client = new AppServerClient({ codexBin: '/no/such/codex-binary-xyz', log: silent });
    await expect(client.request('thread/start', {})).rejects.toThrow();
    // `starting` was reset, so a subsequent request tries again and also rejects
    // (rather than resolving against the first, already-dead start).
    await expect(client.request('thread/start', {})).rejects.toThrow();
  });

  it('gives Agents and NetSuite MCP tools bounded Codex timeouts', () => {
    const dir = tmpDir();
    const configPath = path.join(dir, 'mcp.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        mcpServers: {
          netsuite: { command: 'node', args: ['netsuite.js'], env: {} },
          'netsuite-finance': { command: 'node', args: ['netsuite.js'], env: {} },
          agents: { command: 'node', args: ['agents.js'], env: {} },
          other: { command: 'node', args: ['other.js'], env: {} },
        },
      }),
    );
    const servers = codexMcpServers(configPath);
    expect(servers.netsuite?.tool_timeout_sec).toBe(45);
    expect(servers['netsuite-finance']?.tool_timeout_sec).toBe(45);
    expect(servers.agents?.tool_timeout_sec).toBe(960);
    expect(servers.agents?.tools).toEqual({
      schedule_wakeup: { approval_mode: 'approve' },
      list_wakeups: { approval_mode: 'approve' },
      cancel_wakeup: { approval_mode: 'approve' },
    });
    expect(servers.other).not.toHaveProperty('tool_timeout_sec');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('routes veneer_browser through the token-file proxy instead of mcp-remote', () => {
    const dir = tmpDir();
    const configPath = path.join(dir, 'mcp.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        mcpServers: {
          agents: {
            command: 'node',
            args: ['agents.js'],
            env: { VP_AGENT_TOKEN: 'turn-token', VP_CONVERSATION_ID: 'conv-1', VP_AGENT_TOKEN_FILE: '/tmp/tokens/conv-1' },
          },
          veneer_browser: {
            type: 'http',
            url: 'http://127.0.0.1:3101/mcp/veneer-browser',
            headers: { 'X-VP-Agent-Token': 'turn-token' },
          },
          other_headered: { type: 'http', url: 'http://example.test/mcp', headers: { Authorization: 'Bearer abc' } },
        },
      }),
    );
    const servers = codexMcpServers(configPath);
    const browser = servers.veneer_browser!;
    expect(browser.command).toBe(process.execPath);
    expect((browser.args as string[]).map((a) => path.basename(a))).toEqual(['veneerBrowserProxy.js']);
    expect(browser.env).toEqual({
      VP_VENEER_BROWSER_URL: 'http://127.0.0.1:3101/mcp/veneer-browser',
      VP_AGENT_TOKEN: 'turn-token',
      VP_CONVERSATION_ID: 'conv-1',
      VP_AGENT_TOKEN_FILE: '/tmp/tokens/conv-1',
    });
    expect(browser.tool_timeout_sec).toBe(960);
    expect(JSON.stringify(browser)).not.toContain('mcp-remote');
    // Other headered remote servers keep the mcp-remote wrapper.
    expect(servers.other_headered?.command).toBe('npx');
    expect(servers.other_headered?.args).toEqual(['-y', 'mcp-remote', 'http://example.test/mcp', '--header', 'Authorization:${MCP_HEADER_0}']);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('canonical Codex App Server adapter', () => {
  const dirs: string[] = [];
  afterEach(() => {
    delete process.env.HANG_START;
    delete process.env.RESPOND_TURN_START;
    delete process.env.EMIT_COLLAB_EVENTS;
    delete process.env.EMIT_COLLAB_RUNNING;
    delete process.env.EMIT_PERMISSION_APPROVAL;
    delete process.env.EMIT_UNKNOWN_REQUEST;
    delete process.env.EMIT_BROWSER_TOOL_CALL;
    delete process.env.EMIT_USER_INPUT;
    delete process.env.INTERRUPT_RELEASE_FILE;
    delete process.env.INTERRUPT_COMPLETION_DELAY_MS;
    delete process.env.OMIT_INTERRUPT_COMPLETION;
    delete process.env.OMIT_FIRST_INTERRUPT_COMPLETION;
    delete process.env.EMIT_LATE_PRIOR_ON_SECOND_TURN;
    delete process.env.EMIT_COLLAB_WAIT;
    delete process.env.EMIT_TOKEN_USAGE;
    delete process.env.REQUEST_LOG;
    delete process.env.SERVER_RESPONSE_LOG;
    delete process.env.COMPACT_MODE;
    _setMediaDirForTest(null);
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it('persists whole-turn usage without double-counting cached Codex input', async () => {
    const dir = tmpDir();
    dirs.push(dir);
    process.env.EMIT_COLLAB_WAIT = '1';
    process.env.EMIT_TOKEN_USAGE = '1';
    const adapter = createCodexAdapter({ codexBin: FAKE, turnTimeoutMs: 5_000, transcriptsDir: dir, log: silent });

    const handle = adapter.runTurn(turnSpec(), () => undefined);
    await handle.done;

    const persisted = fs.readFileSync(path.join(dir, 't1.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line)) as ConversationEvent[];
    expect(persisted.at(-1)).toMatchObject({
      type: 'turn_done',
      turnId: 'turn-1',
      outcome: 'completed',
      usage: {
        inputTokens: 38_068,
        outputTokens: 220,
        totalInputTokens: 69_960,
        totalOutputTokens: 648,
        totalTokens: 70_608,
        // Both updates carried the same cached figure on `total` and `last`,
        // so the pre-turn cached baseline is 0 and the whole 61,952 is ours.
        cachedInputTokens: 61_952,
      },
    });
  });

  it('compacts an existing thread through the native app-server lifecycle', async () => {
    const dir = tmpDir();
    dirs.push(dir);
    const requestLog = path.join(dir, 'requests.jsonl');
    process.env.REQUEST_LOG = requestLog;
    const adapter = createCodexAdapter({ codexBin: FAKE, turnTimeoutMs: 5_000, transcriptsDir: dir, log: silent });

    const result = await adapter.compactSession!({
      cwd: dir,
      nativeSessionId: 't1',
      dangerous: true,
    }).done;

    expect(result).toEqual({ contextTokens: null });
    const requests = fs.readFileSync(requestLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(requests.map((request) => request.method)).toEqual(
      expect.arrayContaining(['thread/resume', 'thread/compact/start']),
    );
    expect(requests.find((request) => request.method === 'thread/compact/start')?.params).toEqual({ threadId: 't1' });
    expect(fs.readFileSync(path.join(dir, 't1.jsonl'), 'utf8').trim()).toBe(
      JSON.stringify({ type: 'notice', message: 'Context compacted.' }),
    );
  });

  it('rejects native compaction failures and app-server disconnects', async () => {
    const dir = tmpDir();
    dirs.push(dir);
    process.env.COMPACT_MODE = 'stale';
    const stale = createCodexAdapter({ codexBin: FAKE, turnTimeoutMs: 5_000, transcriptsDir: dir, log: silent });
    await expect(stale.compactSession!({ cwd: dir, nativeSessionId: 'missing-thread' }).done)
      .rejects.toThrow(/thread not found/i);

    process.env.COMPACT_MODE = 'fail';
    const failed = createCodexAdapter({ codexBin: FAKE, turnTimeoutMs: 5_000, transcriptsDir: dir, log: silent });
    await expect(failed.compactSession!({ cwd: dir, nativeSessionId: 't1' }).done)
      .rejects.toThrow('Native compaction failed safely');

    process.env.COMPACT_MODE = 'disconnect';
    const disconnected = createCodexAdapter({ codexBin: FAKE, turnTimeoutMs: 5_000, transcriptsDir: dir, log: silent });
    await expect(disconnected.compactSession!({ cwd: dir, nativeSessionId: 't1' }).done)
      .rejects.toThrow(/disconnected/i);
    expect(fs.existsSync(path.join(dir, 't1.jsonl'))).toBe(false);
  });

  it('interrupts a compaction by its native turn id', async () => {
    const dir = tmpDir();
    dirs.push(dir);
    const requestLog = path.join(dir, 'requests.jsonl');
    process.env.REQUEST_LOG = requestLog;
    process.env.COMPACT_MODE = 'hang';
    const adapter = createCodexAdapter({
      codexBin: FAKE,
      turnTimeoutMs: 5_000,
      interruptCompletionTimeoutMs: 1_000,
      transcriptsDir: dir,
      log: silent,
    });
    const handle = adapter.compactSession!({ cwd: dir, nativeSessionId: 't1' });
    await waitFor(
      () => fs.existsSync(requestLog) && fs.readFileSync(requestLog, 'utf8').includes('thread/compact/start'),
      'Codex did not start compaction',
    );

    handle.kill();
    await expect(handle.done).rejects.toThrow(/interrupted/i);
    const requests = fs.readFileSync(requestLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(requests.find((request) => request.method === 'turn/interrupt')?.params).toEqual({
      threadId: 't1',
      turnId: 'native-compact-turn',
    });
  });

  it('waits for the matching native completion after turn/interrupt is acknowledged', async () => {
    const dir = tmpDir();
    dirs.push(dir);
    const requestLog = path.join(dir, 'requests.jsonl');
    const releaseFile = path.join(dir, 'release-interrupt');
    process.env.REQUEST_LOG = requestLog;
    process.env.INTERRUPT_RELEASE_FILE = releaseFile;
    const adapter = createCodexAdapter({
      codexBin: FAKE,
      turnTimeoutMs: 60_000,
      interruptCompletionTimeoutMs: 1_000,
      transcriptsDir: dir,
      log: silent,
    });
    expect(adapter.id).toBe('codex');
    const events: ConversationEvent[] = [];
    const handle = adapter.runTurn(turnSpec(), (e) => events.push(e));
    await waitFor(
      () => fs.existsSync(requestLog) && fs.readFileSync(requestLog, 'utf8').includes('"method":"turn/start"'),
      'Codex did not start the turn',
    );
    handle.kill();
    await waitFor(
      () => fs.readFileSync(requestLog, 'utf8').includes('"method":"turn/interrupt"'),
      'Codex did not receive turn/interrupt',
    );
    let doneSettled = false;
    void handle.done.then(() => { doneSettled = true; });
    await delay(30);
    expect(doneSettled).toBe(false);

    fs.writeFileSync(releaseFile, 'release');
    await handle.done;
    expect(events.find((e) => e.type === 'turn_done')).toMatchObject({
      type: 'turn_done',
      outcome: 'interrupted_by_user',
    });
    const requests = fs.readFileSync(requestLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(requests.find((request) => request.method === 'turn/interrupt')?.params).toEqual({
      threadId: 't1',
      turnId: 'native-turn-1',
    });
  });

  it('uses a bounded fallback when app-server omits the interrupt completion', async () => {
    process.env.OMIT_INTERRUPT_COMPLETION = '1';
    const dir = tmpDir();
    dirs.push(dir);
    const requestLog = path.join(dir, 'requests.jsonl');
    process.env.REQUEST_LOG = requestLog;
    const adapter = createCodexAdapter({
      codexBin: FAKE,
      turnTimeoutMs: 60_000,
      interruptCompletionTimeoutMs: 30,
      transcriptsDir: dir,
      log: silent,
    });
    const events: ConversationEvent[] = [];
    const handle = adapter.runTurn(turnSpec(), (event) => events.push(event));
    await waitFor(
      () => fs.existsSync(requestLog) && fs.readFileSync(requestLog, 'utf8').includes('"method":"turn/start"'),
      'Codex did not start the turn',
    );
    handle.kill();
    await handle.done;
    expect(events.filter((event) => event.type === 'turn_done')).toEqual([
      expect.objectContaining({ outcome: 'interrupted_by_user' }),
    ]);
  });

  it('quarantines late events from a fallback-interrupted native turn', async () => {
    process.env.OMIT_FIRST_INTERRUPT_COMPLETION = '1';
    process.env.EMIT_LATE_PRIOR_ON_SECOND_TURN = '1';
    const dir = tmpDir();
    dirs.push(dir);
    const requestLog = path.join(dir, 'requests.jsonl');
    process.env.REQUEST_LOG = requestLog;
    const adapter = createCodexAdapter({
      codexBin: FAKE,
      turnTimeoutMs: 60_000,
      interruptCompletionTimeoutMs: 30,
      transcriptsDir: dir,
      log: silent,
    });

    const first = adapter.runTurn(turnSpec(), () => undefined);
    await waitFor(
      () => fs.existsSync(requestLog) && fs.readFileSync(requestLog, 'utf8').includes('"method":"turn/start"'),
      'Codex did not start the first turn',
    );
    first.kill();
    await first.done;

    const events: ConversationEvent[] = [];
    const second = adapter.runTurn(
      turnSpec({ firstTurn: false, nativeSessionId: 't1', turnId: 'turn-2' }),
      (event) => events.push(event),
    );
    await waitFor(
      () => (fs.readFileSync(requestLog, 'utf8').match(/"method":"turn\/start"/g) ?? []).length === 2,
      'Codex did not start the second turn',
    );
    await delay(30);
    expect(events.some((event) => event.type === 'text_delta' && event.text.includes('stale-prior-turn'))).toBe(false);
    expect(events.some((event) => event.type === 'turn_done')).toBe(false);

    second.kill();
    await second.done;
    const done = events.filter((event) => event.type === 'turn_done');
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ turnId: 'turn-2', outcome: 'interrupted_by_user' });
    expect((done[0] as { usage?: unknown }).usage).toBeUndefined();
  });

  it('steers an active native turn with its expected turn id', async () => {
    process.env.RESPOND_TURN_START = '1';
    const dir = tmpDir();
    dirs.push(dir);
    const requestLog = path.join(dir, 'requests.jsonl');
    process.env.REQUEST_LOG = requestLog;
    const adapter = createCodexAdapter({ codexBin: FAKE, turnTimeoutMs: 60_000, transcriptsDir: dir, log: silent });
    const events: ConversationEvent[] = [];
    const handle = adapter.runTurn(turnSpec(), (event) => events.push(event));

    let steered = false;
    await waitFor(async () => {
      steered = (await handle.steer?.('new coordination detail')) ?? false;
      return steered;
    }, 'Codex turn did not become ready for steering');
    expect(steered).toBe(true);
    expect(events.some((event) => event.type === 'turn_started' && event.text === 'new coordination detail')).toBe(true);
    handle.kill();
    await handle.done;

    const requests = fs
      .readFileSync(requestLog, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> });
    expect(requests.find((request) => request.method === 'turn/steer')?.params).toMatchObject({
      threadId: 't1',
      expectedTurnId: 'native-turn-1',
      input: [{ type: 'text', text: 'new coordination detail' }],
    });
  });

  it('registers the scoped browser host tool with experimental app-server capability', async () => {
    const dir = tmpDir();
    dirs.push(dir);
    const requestLog = path.join(dir, 'requests.jsonl');
    process.env.REQUEST_LOG = requestLog;
    const adapter = createCodexAdapter({ codexBin: FAKE, turnTimeoutMs: 60_000, transcriptsDir: dir, log: silent });
    const handle = adapter.runTurn(turnSpec({ conversationId: 'conv-browser' }), () => undefined);
    await waitFor(
      () => fs.existsSync(requestLog) && fs.readFileSync(requestLog, 'utf8').includes('"method":"thread/start"'),
      'Codex did not write the thread/start request',
    );
    handle.kill();
    await handle.done;

    const requests = fs
      .readFileSync(requestLog, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> });
    expect(requests.find((request) => request.method === 'initialize')?.params).toMatchObject({
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    expect(requests.find((request) => request.method === 'thread/start')?.params).toMatchObject({
      dynamicTools: [
        {
          type: 'function',
          name: 'agent_browser',
          inputSchema: {
            required: ['args'],
            properties: { shared: { type: 'boolean' } },
          },
        },
      ],
    });
  });

  it('passes shared mode and persists screenshot media on live and rehydrated tool events', async () => {
    process.env.EMIT_BROWSER_TOOL_CALL = JSON.stringify({
      args: ['screenshot', '--full'],
      shared: true,
    });
    const dir = tmpDir();
    dirs.push(dir);
    const mediaDir = path.join(dir, 'media');
    const screenshotPath = path.join(dir, 'screenshot.png');
    const responseLog = path.join(dir, 'responses.jsonl');
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      'base64',
    );
    fs.writeFileSync(screenshotPath, png);
    process.env.SERVER_RESPONSE_LOG = responseLog;
    _setMediaDirForTest(mediaDir);

    const browserCalls: Array<{ input: unknown; options: Record<string, unknown> }> = [];
    const runBrowser = async (input: unknown, options: Record<string, unknown>): Promise<BrowserRunResult> => {
      browserCalls.push({ input, options });
      return {
        args: ['screenshot', screenshotPath, '--full'],
        screenshotPath,
        stdout: 'Screenshot captured.',
        stderr: '',
        exitCode: 0,
      };
    };
    const adapter = createCodexAdapter({
      codexBin: FAKE,
      turnTimeoutMs: 60_000,
      transcriptsDir: dir,
      log: silent,
      runBrowser,
    });
    const events: ConversationEvent[] = [];
    const handle = adapter.runTurn(
      turnSpec({ cwd: dir, conversationId: 'conv-browser' }),
      (event) => events.push(event),
    );
    await handle.done;

    expect(browserCalls).toEqual([
      {
        input: ['screenshot', '--full'],
        options: expect.objectContaining({ conversationId: 'conv-browser', workspaceDir: dir, shared: true }),
      },
    ]);
    const finished = events.find((event) => event.type === 'tool_finished');
    expect(finished).toMatchObject({
      type: 'tool_finished',
      toolId: 'browser-call-1',
      ok: true,
      images: [expect.stringMatching(/^[a-f0-9]{32}\.png$/)],
    });
    if (!finished || finished.type !== 'tool_finished' || !finished.images?.[0]) {
      throw new Error('Expected screenshot media id');
    }
    expect(fs.readFileSync(mediaFilePath(finished.images[0])!)).toEqual(png);
    expect(finished.resultPreview).toContain(`Live view: ${sharedDesktopUrl()}`);

    const response = JSON.parse(fs.readFileSync(responseLog, 'utf8').trim()) as {
      result?: { contentItems?: Array<{ type?: string; text?: string }> };
    };
    expect(response.result?.contentItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'inputText', text: expect.stringContaining(`Live view: ${sharedDesktopUrl()}`) }),
        expect.objectContaining({ type: 'inputImage', imageUrl: expect.stringMatching(/^data:image\/png;base64,/) }),
      ]),
    );

    const rehydrated = await adapter.readTranscript({ cwd: dir, nativeSessionId: 't1' });
    expect(rehydrated.find((event) => event.type === 'tool_finished')).toMatchObject({
      images: finished.images,
    });
  });

  it('keeps browser failures text-only and marks the tool failed', async () => {
    process.env.EMIT_BROWSER_TOOL_CALL = JSON.stringify({
      args: ['open', 'https://example.com'],
      shared: true,
    });
    const dir = tmpDir();
    dirs.push(dir);
    const responseLog = path.join(dir, 'responses.jsonl');
    process.env.SERVER_RESPONSE_LOG = responseLog;
    const adapter = createCodexAdapter({
      codexBin: FAKE,
      turnTimeoutMs: 60_000,
      transcriptsDir: dir,
      log: silent,
      runBrowser: async () => {
        throw new Error('shared browser unavailable');
      },
    });
    const events: ConversationEvent[] = [];
    const handle = adapter.runTurn(turnSpec({ cwd: dir }), (event) => events.push(event));
    await handle.done;

    expect(events.find((event) => event.type === 'tool_finished')).toMatchObject({
      type: 'tool_finished',
      toolId: 'browser-call-1',
      ok: false,
      resultPreview: 'shared browser unavailable',
    });
    const response = JSON.parse(fs.readFileSync(responseLog, 'utf8').trim()) as {
      result?: { success?: boolean; contentItems?: unknown[] };
    };
    expect(response.result).toMatchObject({
      success: false,
      contentItems: [{ type: 'inputText', text: 'Agent Browser error: shared browser unavailable' }],
    });
  });

  it('stores oversized screenshots for the UI without sending them back into the model', async () => {
    process.env.EMIT_BROWSER_TOOL_CALL = JSON.stringify({ args: ['screenshot'] });
    const dir = tmpDir();
    dirs.push(dir);
    const screenshotPath = path.join(dir, 'large-screenshot.png');
    const responseLog = path.join(dir, 'responses.jsonl');
    fs.writeFileSync(screenshotPath, Buffer.alloc(5 * 1024 * 1024 + 1, 1));
    process.env.SERVER_RESPONSE_LOG = responseLog;
    _setMediaDirForTest(path.join(dir, 'media'));

    const adapter = createCodexAdapter({
      codexBin: FAKE,
      turnTimeoutMs: 60_000,
      transcriptsDir: dir,
      log: silent,
      runBrowser: async (): Promise<BrowserRunResult> => ({
        args: ['screenshot', screenshotPath],
        screenshotPath,
        stdout: 'Screenshot captured.',
        stderr: '',
        exitCode: 0,
      }),
    });
    const events: ConversationEvent[] = [];
    const handle = adapter.runTurn(turnSpec({ cwd: dir }), (event) => events.push(event));
    await handle.done;

    expect(events.find((event) => event.type === 'tool_finished')).toMatchObject({
      images: [expect.stringMatching(/^[a-f0-9]{32}\.png$/)],
    });
    const response = JSON.parse(fs.readFileSync(responseLog, 'utf8').trim()) as {
      result?: { contentItems?: Array<{ type?: string }> };
    };
    expect(response.result?.contentItems?.map((item) => item.type)).toEqual(['inputText']);
  });

  it('maps Full Access to Codex danger-full-access and never approvals', async () => {
    const dir = tmpDir();
    dirs.push(dir);
    const requestLog = path.join(dir, 'requests.jsonl');
    process.env.REQUEST_LOG = requestLog;
    const adapter = createCodexAdapter({ codexBin: FAKE, turnTimeoutMs: 60_000, transcriptsDir: dir, log: silent });
    const handle = adapter.runTurn(turnSpec({ dangerous: true }), () => undefined);
    await waitFor(
      () => fs.existsSync(requestLog) && fs.readFileSync(requestLog, 'utf8').includes('"method":"thread/start"'),
      'Codex did not write the thread/start request',
    );
    handle.kill();
    await handle.done;

    const requests = fs
      .readFileSync(requestLog, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> });
    expect(requests.find((request) => request.method === 'thread/start')?.params).toMatchObject({
      sandbox: 'danger-full-access',
      approvalPolicy: 'never',
      developerInstructions: TEST_DEVELOPER_INSTRUCTIONS,
    });
  });

  it('keeps the normal Codex sandbox and approval behavior when Full Access is off', async () => {
    const dir = tmpDir();
    dirs.push(dir);
    const requestLog = path.join(dir, 'requests.jsonl');
    process.env.REQUEST_LOG = requestLog;
    const adapter = createCodexAdapter({ codexBin: FAKE, turnTimeoutMs: 60_000, transcriptsDir: dir, log: silent });
    const handle = adapter.runTurn(turnSpec({ dangerous: false }), () => undefined);
    await waitFor(
      () => fs.existsSync(requestLog) && fs.readFileSync(requestLog, 'utf8').includes('"method":"thread/start"'),
      'Codex did not write the thread/start request',
    );
    handle.kill();
    await handle.done;

    const requests = fs
      .readFileSync(requestLog, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> });
    expect(requests.find((request) => request.method === 'thread/start')?.params).toMatchObject({
      sandbox: 'workspace-write',
      approvalPolicy: 'on-request',
      developerInstructions: TEST_DEVELOPER_INSTRUCTIONS,
    });
  });

  it('handles the Codex 0.144.4 permission approval request with its exact response shape', async () => {
    process.env.EMIT_PERMISSION_APPROVAL = '1';
    const dir = tmpDir();
    dirs.push(dir);
    const responseLog = path.join(dir, 'responses.jsonl');
    process.env.SERVER_RESPONSE_LOG = responseLog;
    const adapter = createCodexAdapter({ codexBin: FAKE, turnTimeoutMs: 60_000, transcriptsDir: dir, log: silent });
    const events: ConversationEvent[] = [];
    const handle = adapter.runTurn(turnSpec({ dangerous: false }), (event) => events.push(event));
    await waitFor(
      () => events.some((event) => event.type === 'approval_requested' && event.requestId === 'permission-1'),
      'Codex did not request permission approval',
    );

    const approval = events.find((event) => event.type === 'approval_requested');
    expect(approval).toMatchObject({
      type: 'approval_requested',
      requestId: 'permission-1',
      toolName: 'permissions',
      displayName: 'Allow network and file access',
    });
    expect(handle.respondToApproval('permission-1', { behavior: 'allow' })).toBe(true);
    await handle.done;

    const response = JSON.parse(fs.readFileSync(responseLog, 'utf8').trim()) as Record<string, unknown>;
    expect(response).toEqual({
      id: 'permission-1',
      result: {
        permissions: {
          network: { enabled: true },
          fileSystem: {
            read: ['/tmp/netsuite-input'],
            write: null,
            globScanMaxDepth: 2,
          },
        },
        scope: 'turn',
      },
    });
    expect(JSON.stringify(response)).not.toContain('danger-full-access');
    expect(JSON.stringify(response)).not.toContain('decision');
  });

  it('denies and expires generic permission requests with an empty scoped grant', async () => {
    process.env.EMIT_PERMISSION_APPROVAL = '1';
    const dir = tmpDir();
    dirs.push(dir);
    const responseLog = path.join(dir, 'responses.jsonl');
    process.env.SERVER_RESPONSE_LOG = responseLog;
    const adapter = createCodexAdapter({ codexBin: FAKE, turnTimeoutMs: 60_000, transcriptsDir: dir, log: silent });
    const events: ConversationEvent[] = [];
    const handle = adapter.runTurn(turnSpec({ dangerous: false }), (event) => events.push(event));
    await waitFor(
      () => events.some((event) => event.type === 'approval_requested' && event.requestId === 'permission-1'),
      'Codex did not request permission approval',
    );

    expect(handle.respondToApproval('permission-1', { behavior: 'deny', message: 'Approval expired.' })).toBe(true);
    await handle.done;
    const response = JSON.parse(fs.readFileSync(responseLog, 'utf8').trim()) as Record<string, unknown>;
    expect(response).toEqual({
      id: 'permission-1',
      result: { permissions: {}, scope: 'turn' },
    });
  });

  it('normalizes native structured questions and maps answers back to native ids', async () => {
    process.env.EMIT_USER_INPUT = JSON.stringify({
      questions: [
        {
          id: 'native-channel-id',
          header: 'Channel',
          question: 'Which release channel?',
          isOther: false,
          isSecret: false,
          options: [{ label: 'Stable', description: 'Use the proven channel.' }],
        },
        {
          id: 'native-note-id',
          header: 'Note',
          question: 'Anything else?',
          isOther: true,
          isSecret: false,
          options: null,
        },
      ],
    });
    const dir = tmpDir();
    dirs.push(dir);
    const responseLog = path.join(dir, 'responses.jsonl');
    process.env.SERVER_RESPONSE_LOG = responseLog;
    const adapter = createCodexAdapter({ codexBin: FAKE, turnTimeoutMs: 60_000, transcriptsDir: dir, log: silent });
    const events: ConversationEvent[] = [];
    const handle = adapter.runTurn(turnSpec({ dangerous: false }), (event) => events.push(event));
    await waitFor(
      () => events.some((event) => event.type === 'question_asked'),
      'Codex did not surface its native structured question',
    );

    const asked = events.find((event) => event.type === 'question_asked');
    expect(asked).toMatchObject({
      type: 'question_asked',
      responseMode: 'provider',
      questions: [
        {
          id: 'q1',
          header: 'Channel',
          question: 'Which release channel?',
          options: [{ label: 'Stable', value: 'Stable', description: 'Use the proven channel.' }],
          allowOther: false,
        },
        {
          id: 'q2',
          header: 'Note',
          question: 'Anything else?',
          options: [],
          allowOther: true,
        },
      ],
    });
    expect(JSON.stringify(asked)).not.toContain('native-channel-id');
    expect(JSON.stringify(asked)).not.toContain('native-note-id');
    expect(asked?.type === 'question_asked' && handle.respondToQuestion?.(asked.requestId, {
      q1: ['Stable'],
      q2: ['Deploy after lunch'],
    })).toBe(true);
    await handle.done;

    const response = JSON.parse(fs.readFileSync(responseLog, 'utf8').trim()) as Record<string, unknown>;
    expect(response).toEqual({
      id: 'native-user-input-request',
      result: {
        answers: {
          'native-channel-id': { answers: ['Stable'] },
          'native-note-id': { answers: ['Deploy after lunch'] },
        },
      },
    });
  });

  it('rejects secret native questions before they reach events, storage, or logs', async () => {
    process.env.EMIT_USER_INPUT = JSON.stringify({
      questions: [{
        id: 'native-secret-id',
        header: 'Credential',
        question: 'Enter the sensitive value',
        isOther: true,
        isSecret: true,
        options: null,
      }],
    });
    const dir = tmpDir();
    dirs.push(dir);
    const responseLog = path.join(dir, 'responses.jsonl');
    process.env.SERVER_RESPONSE_LOG = responseLog;
    const warnings: string[] = [];
    const adapter = createCodexAdapter({
      codexBin: FAKE,
      turnTimeoutMs: 60_000,
      transcriptsDir: dir,
      log: { warn: (message) => warnings.push(String(message)), error() {} },
    });
    const events: ConversationEvent[] = [];
    const handle = adapter.runTurn(turnSpec({ dangerous: false }), (event) => events.push(event));
    await handle.done;

    expect(events.some((event) => event.type === 'question_asked')).toBe(false);
    expect(JSON.stringify(warnings)).not.toContain('native-secret-id');
    expect(JSON.parse(fs.readFileSync(responseLog, 'utf8').trim())).toEqual({
      id: 'native-user-input-request',
      error: { code: -32602, message: 'Sensitive input is not supported in chat questions' },
    });
  });

  it('cancels a pending generic permission request before interrupting the turn', async () => {
    process.env.EMIT_PERMISSION_APPROVAL = '1';
    const dir = tmpDir();
    dirs.push(dir);
    const responseLog = path.join(dir, 'responses.jsonl');
    process.env.SERVER_RESPONSE_LOG = responseLog;
    const adapter = createCodexAdapter({ codexBin: FAKE, turnTimeoutMs: 60_000, transcriptsDir: dir, log: silent });
    const events: ConversationEvent[] = [];
    const handle = adapter.runTurn(turnSpec({ dangerous: false }), (event) => events.push(event));
    await waitFor(
      () => events.some((event) => event.type === 'approval_requested' && event.requestId === 'permission-1'),
      'Codex did not request permission approval',
    );
    handle.kill();
    await handle.done;

    const responses = fs.readFileSync(responseLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(responses).toContainEqual({
      id: 'permission-1',
      result: { permissions: {}, scope: 'turn' },
    });
  });

  it('answers future unhandled server requests with a fail-closed JSON-RPC error', async () => {
    process.env.EMIT_UNKNOWN_REQUEST = '1';
    const dir = tmpDir();
    dirs.push(dir);
    const responseLog = path.join(dir, 'responses.jsonl');
    process.env.SERVER_RESPONSE_LOG = responseLog;
    const warnings: string[] = [];
    const adapter = createCodexAdapter({
      codexBin: FAKE,
      turnTimeoutMs: 60_000,
      transcriptsDir: dir,
      log: { warn: (message) => warnings.push(String(message)), error() {} },
    });
    const handle = adapter.runTurn(turnSpec({ dangerous: false }), () => undefined);
    await handle.done;

    const response = JSON.parse(fs.readFileSync(responseLog, 'utf8').trim()) as Record<string, unknown>;
    expect(response).toEqual({
      id: 'future-1',
      error: { code: -32601, message: 'Unsupported server request: item/future/requestApproval' },
    });
    expect(warnings).toEqual(['[codex] rejected unsupported server request: item/future/requestApproval']);
    expect(JSON.stringify(warnings)).not.toContain('sensitivePayload');
  });

  it('settles done when Stop lands before a thread id is resolved (no interrupt possible)', async () => {
    process.env.HANG_START = '1'; // fake never answers thread/start
    const dir = tmpDir();
    dirs.push(dir);
    const requestLog = path.join(dir, 'requests.jsonl');
    process.env.REQUEST_LOG = requestLog;
    const adapter = createCodexAdapter({ codexBin: FAKE, turnTimeoutMs: 60_000, transcriptsDir: dir, log: silent });
    const events: ConversationEvent[] = [];
    const handle = adapter.runTurn(turnSpec(), (e) => events.push(e));
    await waitFor(
      () => fs.existsSync(requestLog) && fs.readFileSync(requestLog, 'utf8').includes('"method":"thread/start"'),
      'Codex did not write the thread/start request',
    );
    handle.kill();
    await handle.done; // pre-fix: killed is set but start() runs on forever → hang
    expect(events.find((e) => e.type === 'turn_done')).toMatchObject({
      type: 'turn_done',
      outcome: 'interrupted_by_user',
    });
  });

  it('resumes a pre-consolidation Codex thread id through App Server', async () => {
    const dir = tmpDir();
    dirs.push(dir);
    const requestLog = path.join(dir, 'requests.jsonl');
    process.env.REQUEST_LOG = requestLog;
    const adapter = createCodexAdapter({ codexBin: FAKE, turnTimeoutMs: 60_000, transcriptsDir: dir, log: silent });
    const handle = adapter.runTurn(
      turnSpec({ firstTurn: false, nativeSessionId: 'legacy-exec-thread' }),
      () => undefined,
    );
    await waitFor(
      () => fs.existsSync(requestLog) && fs.readFileSync(requestLog, 'utf8').includes('"method":"thread/resume"'),
      'Codex did not write the thread/resume request',
    );
    handle.kill();
    await handle.done;

    const requests = fs
      .readFileSync(requestLog, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { method?: string; params?: { threadId?: string; developerInstructions?: string } });
    expect(requests.find((request) => request.method === 'thread/resume')).toMatchObject({
      params: {
        threadId: 'legacy-exec-thread',
        developerInstructions: TEST_DEVELOPER_INSTRUCTIONS,
      },
    });
  });

  it('forks a resumed thread once when its developer context must refresh', async () => {
    const dir = tmpDir();
    dirs.push(dir);
    const requestLog = path.join(dir, 'requests.jsonl');
    process.env.REQUEST_LOG = requestLog;
    const adapter = createCodexAdapter({ codexBin: FAKE, turnTimeoutMs: 60_000, transcriptsDir: dir, log: silent });
    const nativeIds: string[] = [];
    fs.writeFileSync(path.join(dir, 'stale-thread.jsonl'), `${JSON.stringify({ type: 'text_final', turnId: 'earlier', markdown: 'Earlier visible reply', at: '2026-09-08T12:00:00Z' })}\n`);
    const handle = adapter.runTurn(
      turnSpec({ firstTurn: false, nativeSessionId: 'stale-thread', refreshDeveloperInstructions: true }),
      () => undefined,
      (id) => nativeIds.push(id),
    );
    // Wait for the request this test actually asserts on, not just the fork
    // that precedes it: killing between the two leaves no turn/start to find.
    await waitFor(
      () => fs.existsSync(requestLog) && fs.readFileSync(requestLog, 'utf8').includes('"method":"turn/start"'),
      'Codex did not start a turn on the forked thread',
    );
    handle.kill();
    await handle.done;

    const requests = fs
      .readFileSync(requestLog, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> });
    expect(requests.find((request) => request.method === 'thread/fork')?.params).toMatchObject({
      threadId: 'stale-thread',
      developerInstructions: TEST_DEVELOPER_INSTRUCTIONS,
    });
    expect(requests.find((request) => request.method === 'turn/start')?.params).toMatchObject({
      threadId: 't-forked',
    });
    expect(nativeIds).toEqual(['t-forked']);
    expect((await adapter.readTranscript({ cwd: dir, nativeSessionId: 't-forked' }))[0]).toMatchObject({ markdown: 'Earlier visible reply' });
  }, 60_000);

  it('checkpoints visible events before a running turn ends and never duplicates them at finish', async () => {
    const dir = tmpDir();
    dirs.push(dir);
    process.env.EMIT_COLLAB_RUNNING = '1';
    const adapter = createCodexAdapter({ codexBin: FAKE, turnTimeoutMs: 60_000, transcriptsDir: dir, log: silent });
    const handle = adapter.runTurn(turnSpec(), () => undefined);
    try {
      await waitFor(async () => (await adapter.readTranscript({ cwd: dir, nativeSessionId: 't1' })).some((event) => event.type === 'subagent_started'), 'Running events were not durable');
      const before = await adapter.readTranscript({ cwd: dir, nativeSessionId: 't1' });
      expect(before.filter((event) => event.type === 'turn_started')).toHaveLength(1);
      handle.kill();
      await handle.done;
      const after = await adapter.readTranscript({ cwd: dir, nativeSessionId: 't1' });
      expect(after.slice(0, before.length)).toEqual(before);
      expect(after.filter((event) => event.type === 'turn_started')).toHaveLength(1);
    } finally {
      handle.kill();
      await handle.done;
    }
  });

  it('rehydrates legacy exec history before new App Server turns', async () => {
    const dir = tmpDir();
    dirs.push(dir);
    const currentDir = path.join(dir, 'current');
    const legacyDir = path.join(dir, 'legacy');
    fs.mkdirSync(currentDir);
    fs.mkdirSync(legacyDir);
    fs.writeFileSync(
      path.join(legacyDir, 'shared-thread.jsonl'),
      `${JSON.stringify({ type: 'text_final', turnId: 'old', markdown: 'old exec turn', at: '2026-07-01T00:00:00Z' })}\n`,
    );
    fs.writeFileSync(
      path.join(currentDir, 'shared-thread.jsonl'),
      `${JSON.stringify({ type: 'text_final', turnId: 'new', markdown: 'new app-server turn', at: '2026-07-02T00:00:00Z' })}\n`,
    );
    const adapter = createCodexAdapter({
      codexBin: FAKE,
      turnTimeoutMs: 60_000,
      transcriptsDir: currentDir,
      legacyTranscriptsDir: legacyDir,
      log: silent,
    });

    const events = await adapter.readTranscript({ cwd: dir, nativeSessionId: 'shared-thread' });
    expect(events.filter((event) => event.type === 'text_final').map((event) => event.markdown)).toEqual([
      'old exec turn',
      'new app-server turn',
    ]);
  });

  it('normalizes and persists spawned-agent lifecycle without leaking Codex internals', async () => {
    process.env.EMIT_COLLAB_EVENTS = '1';
    const dir = tmpDir();
    dirs.push(dir);
    const adapter = createCodexAdapter({ codexBin: FAKE, turnTimeoutMs: 60_000, transcriptsDir: dir, log: silent });
    const events: ConversationEvent[] = [];
    const handle = adapter.runTurn(turnSpec(), (event) => events.push(event));
    await handle.done;

    const activity = events.filter((event) => event.type === 'subagent_started' || event.type === 'subagent_updated');
    expect(activity[0]).toMatchObject({
      type: 'subagent_started',
      turnId: 'turn-1',
      model: 'gpt-5.6-sol',
      effort: 'medium',
      status: 'running',
    });
    expect(activity.some((event) => event.type === 'subagent_started' && event.status === 'queued')).toBe(true);
    expect(activity.some((event) => event.type === 'subagent_updated' && event.currentAction === 'Running tests')).toBe(true);
    expect(activity.some((event) => event.type === 'subagent_updated' && event.resultLabel === 'Tests passed')).toBe(true);
    expect(activity.some((event) => (
      event.type === 'subagent_updated'
      && event.status === 'completed'
      && event.actionCount === 2
      && event.filesChanged === 1
      && event.linesAdded === 2
      && event.linesRemoved === 1
    ))).toBe(true);
    const latestByAgent = new Map<string, (typeof activity)[number]>();
    for (const event of activity) latestByAgent.set(event.agentKey, event);
    expect([...latestByAgent.values()].map((event) => event.status).sort()).toEqual([
      'completed',
      'completed',
      'failed',
      'stopped',
    ]);
    expect(events.some((event) => event.type === 'tool_started')).toBe(false);

    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain('thread-secret');
    expect(serialized).not.toContain('child-thread-secret');
    expect(serialized).not.toContain('parent-thread-secret');
    expect(serialized).not.toContain('raw child prompt');
    expect(serialized).not.toContain('raw child result');
    expect(serialized).not.toContain('raw-private-suite');
    expect(serialized).not.toContain('raw private passing test log');
    expect(serialized).not.toContain('/private/client/Chat.tsx');
    expect(serialized).not.toContain('old private line');

    const persisted = fs.readFileSync(path.join(dir, 't1.jsonl'), 'utf8');
    expect(persisted).toContain('"type":"subagent_started"');
    expect(persisted).toContain('"status":"completed"');
    expect(persisted).not.toContain('thread-secret');
    expect(persisted).not.toContain('child-thread-secret');
    expect(persisted).not.toContain('raw child prompt');
    expect(persisted).toContain('"actionCount":2');
    expect(persisted).toContain('"filesChanged":1');

    const rehydrated = await adapter.readTranscript({ cwd: dir, nativeSessionId: 't1' });
    expect(rehydrated.some((event) => (
      event.type === 'subagent_updated'
      && event.status === 'completed'
      && event.actionCount === 2
      && event.filesChanged === 1
    ))).toBe(true);
  });

  it('leaves running Codex sub-agents alone when the parent turn is interrupted', async () => {
    // Interrupting the parent says nothing about the delegated work: Codex
    // still owns those children and reports their real state on a later
    // wait/close. Claiming 'stopped' here invented a status Codex never sent.
    process.env.EMIT_COLLAB_RUNNING = '1';
    const dir = tmpDir();
    dirs.push(dir);
    const adapter = createCodexAdapter({ codexBin: FAKE, turnTimeoutMs: 60_000, transcriptsDir: dir, log: silent });
    const events: ConversationEvent[] = [];
    const handle = adapter.runTurn(turnSpec(), (event) => events.push(event));
    await waitFor(
      () => events.some((event) => event.type === 'subagent_started' && event.status === 'running'),
      'Codex did not report the running sub-agent',
    );
    handle.kill();
    await handle.done;
    const activity = events.filter((event) => event.type === 'subagent_started' || event.type === 'subagent_updated');
    expect(activity.map((event) => event.status)).toEqual(['running']);
    expect(JSON.stringify(events)).not.toContain('running-child-secret');
  });
});
