import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ACP_ARGS, AcpClient, isAuthenticationError } from '../src/providers/grok/protocol.js';
import { createGrokAdapter, grokToolIdentity, toModelOptions } from '../src/providers/grok/adapter.js';
import { readLegacyOutboxFiles, writeShadowModel } from '../src/providers/grok/transcript.js';
import { DISABLED_COMPAT_SCANNERS, ensureGrokProfile } from '../src/providers/grok/profile.js';
import { grokMcpServers } from '../src/providers/agentsMcp.js';
import type { TurnSpec } from '../src/providers/types.js';
import type { ConversationEvent } from '../src/runtime/events.js';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/fake-acp-server.mjs');
const silent = { warn() {}, error() {} };
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TEST_DEVELOPER_INSTRUCTIONS = '# Core Veneer rules\n\n# Fixed chat context';

const ENV_KEYS = [
  'REQUEST_LOG',
  'CLIENT_RESPONSE_LOG',
  'REQUIRE_AUTH',
  'HANG_SESSION_NEW',
  'HANG_INITIALIZE',
  'HANG_TURN',
  'AWAIT_CANCEL',
  'OMIT_CANCEL_RESPONSE',
  'CANCEL_RESPONSE_DELAY_MS',
  'DIE_MID_TURN',
  'DIE_ONCE_MARKER',
  'EARLY_UPDATE',
  'EMIT_PERMISSION_REQUEST',
  'EMIT_UNKNOWN_REQUEST',
  'REJECT_SET_MODEL',
  'STOP_REASON',
  'FAKE_SESSION_ID',
  'GENERIC_TOOL_KINDS',
] as const;

async function waitFor(predicate: () => boolean, message: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await delay(20);
  }
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'grok-acp-test-'));
}

function turnSpec(over: Partial<TurnSpec> = {}): TurnSpec {
  return {
    cwd: os.tmpdir(),
    nativeSessionId: 's1',
    firstTurn: true,
    prompt: 'hi',
    turnId: 'turn-1',
    dangerous: false,
    developerInstructions: TEST_DEVELOPER_INSTRUCTIONS,
    ...over,
  };
}

function readLog(file: string): { method?: string; params?: Record<string, unknown> }[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

describe('Grok MCP config shaping', () => {
  it('uses the ACP name/value array encoding for stdio env and HTTP headers', () => {
    const dir = tmpDir();
    const configPath = path.join(dir, 'mcp.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        mcpServers: {
          agents: { command: 'node', args: ['agents.js'], env: { VP_AGENT_TOKEN: 'tok-1' } },
          plain_stdio: { command: 'node', args: [] },
          veneer_browser: {
            url: 'https://localhost:7301/mcp',
            headers: { 'X-VP-Agent-Token': 'tok-2' },
          },
          open_remote: { url: 'https://example.com/mcp' },
          'bad name': { command: 'node', args: [] },
        },
      }),
    );

    const servers = grokMcpServers(configPath);
    expect(servers.map((s) => s.name).sort()).toEqual(['agents', 'open_remote', 'plain_stdio', 'veneer_browser']);
    expect(servers.find((s) => s.name === 'agents')).toEqual({
      name: 'agents',
      command: 'node',
      args: ['agents.js'],
      env: [{ name: 'VP_AGENT_TOKEN', value: 'tok-1' }],
    });
    // `env` is a required field of the ACP stdio variant, so it is always sent.
    expect(servers.find((s) => s.name === 'plain_stdio')).toEqual({
      name: 'plain_stdio',
      command: 'node',
      args: [],
      env: [],
    });
    // Headered remote servers pass natively — no mcp-remote wrap, unlike Codex.
    expect(servers.find((s) => s.name === 'veneer_browser')).toEqual({
      name: 'veneer_browser',
      type: 'http',
      url: 'https://localhost:7301/mcp',
      headers: [{ name: 'X-VP-Agent-Token', value: 'tok-2' }],
    });
    expect(JSON.stringify(servers)).not.toContain('mcp-remote');
    expect(servers.find((s) => s.name === 'open_remote')).toEqual({
      name: 'open_remote',
      type: 'http',
      url: 'https://example.com/mcp',
      headers: [],
    });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns nothing without a materialized config', () => {
    expect(grokMcpServers(null)).toEqual([]);
    expect(grokMcpServers('/no/such/mcp-config.json')).toEqual([]);
  });
});

describe('Grok profile lockdown', () => {
  it('writes the Claude import marker, which env switches alone do not cover', () => {
    const dir = tmpDir();
    const home = path.join(dir, '.grok');
    ensureGrokProfile(home, silent, dir);
    expect(fs.readFileSync(path.join(home, 'config.toml'), 'utf8')).toContain('[claude_compat]\nimported = true');
    expect(fs.readFileSync(path.join(home, 'config.toml'), 'utf8')).toContain(
      '[skills]\nignore = ["~/.claude/skills","~/.agents/skills"]',
    );

    // Idempotent: a second call must not duplicate the marker.
    ensureGrokProfile(home, silent, dir);
    const config = fs.readFileSync(path.join(home, 'config.toml'), 'utf8');
    expect(config.match(/\[claude_compat\]/g)).toHaveLength(1);
    expect(config.match(/~\/\.claude\/skills/g)).toHaveLength(1);
    expect(config.match(/~\/\.agents\/skills/g)).toHaveLength(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('preserves operator skill paths and ignore entries while merging its exclusions', () => {
    const dir = tmpDir();
    const home = path.join(dir, '.grok');
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(
      path.join(home, 'config.toml'),
      '[ui]\ntheme = "dark"\n\n[skills]\npaths = ["/operator/skills"]\nignore = [\n  "/keep/ignored",\n]\n',
    );
    ensureGrokProfile(home, silent, dir);
    ensureGrokProfile(home, silent, dir);
    const config = fs.readFileSync(path.join(home, 'config.toml'), 'utf8');
    expect(config).toContain('theme = "dark"');
    expect(config).toContain('paths = ["/operator/skills"]');
    expect(config).toContain('/keep/ignored');
    expect(config.match(/~\/\.claude\/skills/g)).toHaveLength(1);
    expect(config.match(/~\/\.agents\/skills/g)).toHaveLength(1);
    expect(config).toContain('[claude_compat]');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('ignores resolved login-home symlink targets without hiding pinned Grok links', () => {
    const dir = tmpDir();
    const home = path.join(dir, '.grok');
    const ownerHome = path.join(dir, 'owner');
    const personal = path.join(dir, 'personal-skill');
    const managed = path.join(dir, 'managed-skill');
    fs.mkdirSync(personal, { recursive: true });
    fs.mkdirSync(managed, { recursive: true });
    fs.mkdirSync(path.join(ownerHome, '.agents', 'skills'), { recursive: true });
    fs.mkdirSync(path.join(ownerHome, '.claude', 'skills'), { recursive: true });
    fs.mkdirSync(path.join(home, 'skills'), { recursive: true });
    fs.symlinkSync(personal, path.join(ownerHome, '.agents', 'skills', 'personal'));
    fs.symlinkSync(managed, path.join(ownerHome, '.claude', 'skills', 'managed'));
    fs.symlinkSync(managed, path.join(home, 'skills', 'managed'));

    ensureGrokProfile(home, silent, ownerHome);
    const config = fs.readFileSync(path.join(home, 'config.toml'), 'utf8');
    expect(config).toContain(JSON.stringify(fs.realpathSync(personal)));
    expect(config).not.toContain(JSON.stringify(fs.realpathSync(managed)));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('disables foreign Claude skill scanning because globals are native in GROK_HOME', () => {
    expect(DISABLED_COMPAT_SCANNERS).toContain('GROK_CLAUDE_SKILLS_ENABLED');
    expect([...DISABLED_COMPAT_SCANNERS].sort()).toEqual([
      'GROK_CLAUDE_AGENTS_ENABLED',
      'GROK_CLAUDE_HOOKS_ENABLED',
      'GROK_CLAUDE_MCPS_ENABLED',
      'GROK_CLAUDE_RULES_ENABLED',
      'GROK_CLAUDE_SESSIONS_ENABLED',
      'GROK_CLAUDE_SKILLS_ENABLED',
      'GROK_CODEX_SESSIONS_ENABLED',
      'GROK_CURSOR_AGENTS_ENABLED',
      'GROK_CURSOR_HOOKS_ENABLED',
      'GROK_CURSOR_MCPS_ENABLED',
      'GROK_CURSOR_RULES_ENABLED',
      'GROK_CURSOR_SESSIONS_ENABLED',
      'GROK_CURSOR_SKILLS_ENABLED',
    ]);
  });
});

describe('Grok model list mapping', () => {
  it('drops the image/video endpoints and flags the current model', () => {
    const models = toModelOptions({
      _meta: {
        modelState: {
          currentModelId: 'grok-4.5',
          availableModels: [
            {
              modelId: 'grok-4.6',
              name: 'Grok 4.6',
              _meta: {
                totalContextTokens: 256000,
                reasoningEffort: 'high',
                reasoningEfforts: [
                  { id: 'xhigh', value: 'xhigh' },
                  { id: 'high', value: 'high' },
                  { id: 'medium', value: 'medium' },
                  { id: 'low', value: 'low' },
                ],
              },
            },
            { modelId: 'grok-4.5', name: 'Grok 4.5', _meta: { totalContextTokens: 500000 } },
            { modelId: 'grok-4-fast', name: 'Grok 4 Fast', _meta: { totalContextTokens: 256000 } },
            { modelId: 'grok-imagine-image', name: 'Grok Imagine' },
          ],
        },
      },
    });
    expect(models).toEqual([
      {
        id: 'grok-4.6',
        label: 'Grok 4.6 (256K)',
        efforts: ['low', 'medium', 'high', 'xhigh'],
        defaultEffort: 'high',
      },
      { id: 'grok-4.5', label: 'Grok 4.5 (500K)', isDefault: true },
      { id: 'grok-4-fast', label: 'Grok 4 Fast (256K)' },
    ]);
    expect(models.find((m) => m.id === 'grok-4.5')?.efforts).toBeUndefined();
  });

  it('survives an initialize result without a model state', () => {
    expect(toModelOptions(null)).toEqual([]);
    expect(toModelOptions({})).toEqual([]);
  });
});

describe('Grok tool identity', () => {
  it('normalizes namespaced MCP tools and falls back to the ACP kind', () => {
    expect(grokToolIdentity({ title: 'veneer_browser__navigate', kind: 'other' })).toEqual({
      toolName: 'mcp__veneer_browser__navigate',
      displayName: 'Using veneer_browser',
    });
    expect(grokToolIdentity({ title: 'mcp__agents__ask_user', kind: 'other' })).toEqual({
      toolName: 'mcp__agents__ask_user',
      displayName: 'Asking you a question',
    });
    expect(grokToolIdentity({ title: 'npm test', kind: 'execute' })).toEqual({
      toolName: 'shell',
      displayName: 'Running a command',
    });
    expect(grokToolIdentity({ title: 'Edit src/a.ts', kind: 'edit' })).toEqual({
      toolName: 'file_change',
      displayName: 'Editing a file',
    });
    expect(grokToolIdentity({ kind: 'wat' })).toEqual({ toolName: 'tool', displayName: 'Using a tool' });
  });
});

describe('AcpClient', () => {
  it('spawns an isolated, auto-approving backend', () => {
    expect(ACP_ARGS).toEqual(['agent', '--always-approve', '--no-leader', 'stdio']);
  });

  it('rejects pending requests on spawn failure instead of hanging forever', async () => {
    const client = new AcpClient({ grokBin: '/no/such/grok-binary-xyz', log: silent });
    await expect(client.request('session/new', {})).rejects.toThrow();
    // The start latch was cleared, so a later request retries and also rejects.
    await expect(client.request('session/new', {})).rejects.toThrow();
  });

  it('classifies the real pre-login JSON-RPC error as an auth failure', () => {
    expect(isAuthenticationError(new Error('Authentication required'))).toBe(true);
    expect(isAuthenticationError(new Error('grok agent exited'))).toBe(false);
  });
});

describe('canonical Grok ACP adapter', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const key of ENV_KEYS) delete process.env[key];
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  function adapterIn(dir: string, over: Record<string, unknown> = {}) {
    return createGrokAdapter({
      grokBin: FAKE,
      turnTimeoutMs: 60_000,
      transcriptsDir: dir,
      log: silent,
      buildEnv: () => ({ ...process.env, GROK_HOME: path.join(dir, 'home') }),
      ...over,
    });
  }

  it('maps a full ACP turn onto normalized events and persists them', async () => {
    const dir = tmpDir();
    dirs.push(dir);
    const requestLog = path.join(dir, 'requests.jsonl');
    process.env.REQUEST_LOG = requestLog;
    const adapter = adapterIn(dir);
    expect(adapter.id).toBe('grok');

    const events: ConversationEvent[] = [];
    const sessionIds: string[] = [];
    const handle = adapter.runTurn(turnSpec({ cwd: dir }), (e) => events.push(e), (id) => sessionIds.push(id));
    await handle.done;

    expect(sessionIds).toEqual(['s1']);
    expect(events.filter((e) => e.type === 'text_delta').map((e) => e.text)).toEqual(['Hello', ' world', 'Done.']);
    // One thinking marker per contiguous run of reasoning, not one per chunk.
    expect(events.filter((e) => e.type === 'thinking')).toHaveLength(1);
    // Text before a tool call is its own message, so interleaving is preserved.
    expect(events.filter((e) => e.type === 'text_final').map((e) => e.markdown)).toEqual(['Hello world', 'Done.']);

    const started = events.filter((e) => e.type === 'tool_started');
    expect(started.map((e) => [e.toolId, e.toolName, e.displayName])).toEqual([
      ['call-1', 'shell', 'Running a command'],
      ['call-2', 'mcp__veneer_browser__navigate', 'Using veneer_browser'],
      ['call-3', 'file_change', 'Editing a file'],
    ]);
    const finished = events.filter((e) => e.type === 'tool_finished');
    expect(finished.map((e) => [e.toolId, e.ok])).toEqual([
      ['call-1', true],
      ['call-2', false],
      ['call-3', true],
    ]);
    expect(finished[1]?.resultPreview).toBe('navigation blocked');
    expect(events.at(-1)).toMatchObject({ type: 'turn_done', turnId: 'turn-1', outcome: 'completed' });

    // Rehydration round-trips everything except the live-only deltas.
    const rehydrated = await adapter.readTranscript({ cwd: dir, nativeSessionId: 's1' });
    expect(rehydrated[0]).toMatchObject({ type: 'turn_started', text: 'hi' });
    expect(rehydrated.filter((e) => e.type === 'text_final').map((e) => e.markdown)).toEqual([
      'Hello world',
      'Done.',
    ]);
    expect(rehydrated.some((e) => e.type === 'text_delta')).toBe(false);

    // Created files: the exact `edit` location, plus the bash-heuristic path.
    const created = await adapter.listCreatedFiles!({ cwd: dir, nativeSessionId: 's1' });
    expect(created.map((c) => [path.basename(c.path), c.source]).sort()).toEqual([
      ['notes.html', 'write'],
      ['report.csv', 'bash'],
    ]);
    expect(created.every((c) => path.isAbsolute(c.path))).toBe(true);

    const requests = readLog(requestLog);
    expect(requests.find((r) => r.method === 'initialize')?.params).toEqual({
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    });
    // Developer instructions have no ACP parameter, so they ride in the prompt.
    const prompt = requests.find((r) => r.method === 'session/prompt')?.params as {
      prompt?: { text?: string }[];
    };
    expect(prompt?.prompt?.[0]?.text).toBe(`${TEST_DEVELOPER_INSTRUCTIONS}\n\n---\n\nhi`);
  });

  it('captures files when Grok labels command and edit calls generically', async () => {
    const dir = tmpDir();
    dirs.push(dir);
    process.env.GENERIC_TOOL_KINDS = '1';
    const adapter = adapterIn(dir, { legacyOutboxHomes: [] });

    await adapter.runTurn(turnSpec({ cwd: dir }), () => undefined).done;

    const created = await adapter.listCreatedFiles!({ cwd: dir, nativeSessionId: 's1' });
    expect(created.map((ref) => [path.basename(ref.path), ref.source]).sort()).toEqual([
      ['notes.html', 'write'],
      ['report.csv', 'bash'],
    ]);
  });

  it('bridges only regular files from the exact legacy File Box session', async () => {
    const home = tmpDir();
    const outside = tmpDir();
    dirs.push(home, outside);
    const sessionDir = path.join(home, '.local/share/veneer/outbox/session-1');
    fs.mkdirSync(path.join(sessionDir, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(sessionDir, 'report.csv'), 'a,b\n1,2\n');
    fs.writeFileSync(path.join(sessionDir, '.hidden.csv'), 'secret');
    fs.writeFileSync(path.join(sessionDir, 'nested', 'ignored.csv'), 'nested');
    fs.writeFileSync(path.join(outside, 'outside.csv'), 'outside');
    fs.symlinkSync(path.join(outside, 'outside.csv'), path.join(sessionDir, 'linked.csv'));

    await expect(readLegacyOutboxFiles('session-1', [home])).resolves.toEqual([
      { path: path.join(sessionDir, 'report.csv'), source: 'write' },
    ]);
    await expect(readLegacyOutboxFiles('../session-1', [home])).resolves.toEqual([]);
  });

  it('sends the MCP server array on session/new and again on session/load', async () => {
    const dir = tmpDir();
    dirs.push(dir);
    const requestLog = path.join(dir, 'requests.jsonl');
    process.env.REQUEST_LOG = requestLog;
    const mcpConfigPath = path.join(dir, 'mcp.json');
    fs.writeFileSync(
      mcpConfigPath,
      JSON.stringify({
        mcpServers: {
          agents: { command: 'node', args: ['agents.js'], env: { VP_AGENT_TOKEN: 'turn-token' } },
          veneer_browser: { url: 'https://localhost:7301/mcp', headers: { 'X-VP-Agent-Token': 'turn-token' } },
        },
      }),
    );
    const adapter = adapterIn(dir);

    const first = adapter.runTurn(turnSpec({ cwd: dir, mcpConfigPath }), () => undefined);
    await first.done;
    const second = adapter.runTurn(
      turnSpec({ cwd: dir, mcpConfigPath, firstTurn: false, nativeSessionId: 's1', turnId: 'turn-2' }),
      () => undefined,
    );
    await second.done;

    const expected = [
      { name: 'agents', command: 'node', args: ['agents.js'], env: [{ name: 'VP_AGENT_TOKEN', value: 'turn-token' }] },
      {
        name: 'veneer_browser',
        type: 'http',
        url: 'https://localhost:7301/mcp',
        headers: [{ name: 'X-VP-Agent-Token', value: 'turn-token' }],
      },
    ];
    const requests = readLog(requestLog);
    expect(requests.find((r) => r.method === 'session/new')?.params).toEqual({ cwd: dir, mcpServers: expected });
    // Agent tokens rotate per turn, so a resumed session must be re-configured.
    expect(requests.find((r) => r.method === 'session/load')?.params).toEqual({
      sessionId: 's1',
      cwd: dir,
      mcpServers: expected,
    });
  });

  it('suppresses the session/load history replay', async () => {
    const dir = tmpDir();
    dirs.push(dir);
    const adapter = adapterIn(dir);
    const events: ConversationEvent[] = [];
    const handle = adapter.runTurn(
      turnSpec({ cwd: dir, firstTurn: false, nativeSessionId: 's1', turnId: 'turn-2' }),
      (e) => events.push(e),
    );
    await handle.done;

    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain('REPLAYED-HISTORY');
    expect(serialized).not.toContain('replayed user turn');
    expect(events.some((e) => e.type === 'tool_started' && e.toolId === 'replayed-call')).toBe(false);
    // The live turn that followed the replay is still fully reported.
    expect(events.filter((e) => e.type === 'text_final').map((e) => e.markdown)).toEqual(['Hello world', 'Done.']);
    expect(events.at(-1)).toMatchObject({ type: 'turn_done', outcome: 'completed' });
    // Only the live turn was persisted — the replay must not be written twice.
    expect(fs.readFileSync(path.join(dir, 's1.jsonl'), 'utf8')).not.toContain('REPLAYED-HISTORY');
  });

  it('does not lose updates that arrive before the session id is subscribed', async () => {
    process.env.EARLY_UPDATE = '1';
    const dir = tmpDir();
    dirs.push(dir);
    const adapter = adapterIn(dir);
    const events: ConversationEvent[] = [];
    const handle = adapter.runTurn(turnSpec({ cwd: dir }), (e) => events.push(e));
    await handle.done;
    expect(events.filter((e) => e.type === 'text_delta').map((e) => e.text)).toEqual([
      'early-chunk ',
      'Hello',
      ' world',
      'Done.',
    ]);
  });

  it('turns the pre-login auth error into a friendly failure, not a crash', async () => {
    process.env.REQUIRE_AUTH = '1';
    const dir = tmpDir();
    dirs.push(dir);
    const adapter = adapterIn(dir);
    const events: ConversationEvent[] = [];
    const handle = adapter.runTurn(turnSpec({ cwd: dir }), (e) => events.push(e));
    await handle.done;

    expect(events.find((e) => e.type === 'error')).toEqual({
      type: 'error',
      message: 'Grok is not connected. Connect it in Settings → Providers.',
      fatal: true,
    });
    expect(events.at(-1)).toMatchObject({ type: 'turn_done', outcome: 'failed' });
  });

  it('cancels an active turn and waits for the cancelled stop reason', async () => {
    process.env.AWAIT_CANCEL = '1';
    process.env.CANCEL_RESPONSE_DELAY_MS = '60';
    const dir = tmpDir();
    dirs.push(dir);
    const requestLog = path.join(dir, 'requests.jsonl');
    process.env.REQUEST_LOG = requestLog;
    const adapter = adapterIn(dir, { cancelCompletionTimeoutMs: 2_000 });
    const events: ConversationEvent[] = [];
    const handle = adapter.runTurn(turnSpec({ cwd: dir }), (e) => events.push(e));
    await waitFor(
      () => readLog(requestLog).some((r) => r.method === 'session/prompt'),
      'Grok did not receive the prompt',
    );
    handle.kill();
    await waitFor(
      () => readLog(requestLog).some((r) => r.method === 'session/cancel'),
      'Grok did not receive session/cancel',
    );
    await handle.done;

    // An explicit user Stop is the one case that abandons the children too.
    expect(readLog(requestLog).find((r) => r.method === 'session/cancel')?.params).toEqual({
      sessionId: 's1',
      cancelSubagents: true,
    });
    expect(events.filter((e) => e.type === 'turn_done')).toEqual([
      expect.objectContaining({ outcome: 'interrupted_by_user' }),
    ]);
    expect(events.some((e) => e.type === 'notice' && e.message === 'Stopped.')).toBe(true);
  });

  it('uses a bounded fallback when Grok never answers the cancelled prompt', async () => {
    process.env.AWAIT_CANCEL = '1';
    process.env.OMIT_CANCEL_RESPONSE = '1';
    const dir = tmpDir();
    dirs.push(dir);
    const requestLog = path.join(dir, 'requests.jsonl');
    process.env.REQUEST_LOG = requestLog;
    const adapter = adapterIn(dir, { cancelCompletionTimeoutMs: 40 });
    const events: ConversationEvent[] = [];
    const handle = adapter.runTurn(turnSpec({ cwd: dir }), (e) => events.push(e));
    await waitFor(
      () => readLog(requestLog).some((r) => r.method === 'session/prompt'),
      'Grok did not receive the prompt',
    );
    handle.kill();
    await handle.done;
    expect(events.filter((e) => e.type === 'turn_done')).toEqual([
      expect.objectContaining({ outcome: 'interrupted_by_user' }),
    ]);
  });

  it('settles done when Stop lands before a session id exists', async () => {
    process.env.HANG_SESSION_NEW = '1';
    const dir = tmpDir();
    dirs.push(dir);
    const requestLog = path.join(dir, 'requests.jsonl');
    process.env.REQUEST_LOG = requestLog;
    const adapter = adapterIn(dir);
    const events: ConversationEvent[] = [];
    const handle = adapter.runTurn(turnSpec({ cwd: dir }), (e) => events.push(e));
    await waitFor(
      () => readLog(requestLog).some((r) => r.method === 'session/new'),
      'Grok did not receive session/new',
    );
    handle.kill();
    await handle.done;
    expect(events.find((e) => e.type === 'turn_done')).toMatchObject({ outcome: 'interrupted_by_user' });
  });

  it('reports a disconnect mid-turn and respawns for the next turn', async () => {
    const dir = tmpDir();
    dirs.push(dir);
    process.env.DIE_MID_TURN = '1';
    // The client captures its environment at construction, so the respawn is
    // told to survive through the filesystem, not through process.env.
    process.env.DIE_ONCE_MARKER = path.join(dir, 'died-once');
    const adapter = adapterIn(dir);
    const first: ConversationEvent[] = [];
    const dying = adapter.runTurn(turnSpec({ cwd: dir }), (e) => first.push(e));
    await dying.done;
    expect(first.find((e) => e.type === 'error')).toMatchObject({
      message: 'Grok disconnected unexpectedly.',
      fatal: false,
    });
    expect(first.at(-1)).toMatchObject({ type: 'turn_done', outcome: 'failed' });
    // Partial text is still preserved rather than dropped.
    expect(first.some((e) => e.type === 'text_final' && e.markdown === 'partial')).toBe(true);

    const second: ConversationEvent[] = [];
    const recovered = adapter.runTurn(turnSpec({ cwd: dir, turnId: 'turn-2' }), (e) => second.push(e));
    await recovered.done;
    expect(second.at(-1)).toMatchObject({ type: 'turn_done', outcome: 'completed' });
  });

  it('answers unexpected agent requests fail-closed without logging their payload', async () => {
    process.env.EMIT_PERMISSION_REQUEST = '1';
    process.env.EMIT_UNKNOWN_REQUEST = '1';
    const dir = tmpDir();
    dirs.push(dir);
    const responseLog = path.join(dir, 'responses.jsonl');
    process.env.CLIENT_RESPONSE_LOG = responseLog;
    const warnings: string[] = [];
    const adapter = adapterIn(dir, { log: { warn: (m: unknown) => warnings.push(String(m)), error() {} } });
    const handle = adapter.runTurn(turnSpec({ cwd: dir }), () => undefined);
    await handle.done;
    // The replies race the turn's own completion down the same pipe.
    await waitFor(() => readLog(responseLog).length >= 2, 'Grok did not receive both replies');

    const responses = readLog(responseLog) as unknown as Record<string, unknown>[];
    expect(responses).toContainEqual({
      jsonrpc: '2.0',
      id: 'perm-1',
      result: { outcome: { outcome: 'cancelled' } },
    });
    expect(responses).toContainEqual({
      jsonrpc: '2.0',
      id: 'future-1',
      error: { code: -32601, message: 'Unsupported agent request: fs/read_text_file' },
    });
    expect(warnings.join(' ')).toContain('rejected unsupported agent request: fs/read_text_file');
    expect(JSON.stringify(warnings)).not.toContain('sensitivePayload');
  });

  it('maps refusal and length stop reasons onto Veneer outcomes', async () => {
    const dir = tmpDir();
    dirs.push(dir);
    process.env.STOP_REASON = 'refusal';
    const refusedEvents: ConversationEvent[] = [];
    const refused = adapterIn(dir).runTurn(turnSpec({ cwd: dir }), (e) => refusedEvents.push(e));
    await refused.done;
    expect(refusedEvents.find((e) => e.type === 'error')).toMatchObject({
      message: 'Grok declined to complete this request.',
    });
    expect(refusedEvents.at(-1)).toMatchObject({ type: 'turn_done', outcome: 'failed' });

    process.env.STOP_REASON = 'max_tokens';
    const cappedEvents: ConversationEvent[] = [];
    const capped = adapterIn(dir).runTurn(turnSpec({ cwd: dir, turnId: 'turn-2' }), (e) => cappedEvents.push(e));
    await capped.done;
    expect(cappedEvents.some((e) => e.type === 'notice' && e.message.includes('response length limit'))).toBe(true);
    expect(cappedEvents.at(-1)).toMatchObject({ type: 'turn_done', outcome: 'completed' });
  });

  it('selects the model per session and records it for readModel', async () => {
    const dir = tmpDir();
    dirs.push(dir);
    const requestLog = path.join(dir, 'requests.jsonl');
    process.env.REQUEST_LOG = requestLog;
    const adapter = adapterIn(dir);
    const handle = adapter.runTurn(turnSpec({ cwd: dir, model: 'grok-4-fast' }), () => undefined);
    await handle.done;

    expect(readLog(requestLog).find((r) => r.method === 'session/set_model')?.params).toEqual({
      sessionId: 's1',
      modelId: 'grok-4-fast',
    });
    expect(await adapter.readModel!({ cwd: dir, nativeSessionId: 's1' })).toBe('grok-4-fast');
  });

  it('still runs the turn when the model cannot be selected', async () => {
    process.env.REJECT_SET_MODEL = '1';
    const dir = tmpDir();
    dirs.push(dir);
    const adapter = adapterIn(dir);
    const events: ConversationEvent[] = [];
    const handle = adapter.runTurn(turnSpec({ cwd: dir, model: 'nope' }), (e) => events.push(e));
    await handle.done;
    expect(events.at(-1)).toMatchObject({ type: 'turn_done', outcome: 'completed' });
    expect(await adapter.readModel!({ cwd: dir, nativeSessionId: 's1' })).toBeNull();
  });

  it('gates listModels on a subscription login and filters the image models', async () => {
    const dir = tmpDir();
    dirs.push(dir);
    const home = path.join(dir, 'home');
    const adapter = adapterIn(dir);
    // No auth.json → the picker must stay empty, and no agent is spawned.
    expect(await adapter.listModels!()).toEqual([]);

    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, 'auth.json'), '{}');
    expect(await adapter.listModels!()).toEqual([
      {
        id: 'grok-4.5',
        label: 'Grok 4.5 (500K)',
        isDefault: true,
        efforts: ['low', 'medium', 'high'],
        defaultEffort: 'high',
      },
      { id: 'grok-4-fast', label: 'Grok 4 Fast (256K)' },
    ]);
  });

  it('sends camelCase reasoningEffort with the selected model', async () => {
    const dir = tmpDir();
    dirs.push(dir);
    const requestLog = path.join(dir, 'requests.jsonl');
    process.env.REQUEST_LOG = requestLog;
    const adapter = adapterIn(dir);
    const handle = adapter.runTurn(turnSpec({ cwd: dir, model: 'grok-4.6', effort: 'low' }), () => undefined);
    await handle.done;

    expect(readLog(requestLog).find((r) => r.method === 'session/set_model')?.params).toEqual({
      sessionId: 's1',
      modelId: 'grok-4.6',
      _meta: { reasoningEffort: 'low' },
    });
  });

  it('uses the shadowed model when only effort is set', async () => {
    const dir = tmpDir();
    dirs.push(dir);
    const requestLog = path.join(dir, 'requests.jsonl');
    process.env.REQUEST_LOG = requestLog;
    writeShadowModel(dir, 's1', 'grok-4.5');
    const adapter = adapterIn(dir);
    const handle = adapter.runTurn(
      turnSpec({ cwd: dir, firstTurn: false, nativeSessionId: 's1', effort: 'medium' }),
      () => undefined,
    );
    await handle.done;

    expect(readLog(requestLog).find((r) => r.method === 'session/set_model')?.params).toEqual({
      sessionId: 's1',
      modelId: 'grok-4.5',
      _meta: { reasoningEffort: 'medium' },
    });
  });

  it('skips set_model when effort is set but no model is known', async () => {
    const dir = tmpDir();
    dirs.push(dir);
    const requestLog = path.join(dir, 'requests.jsonl');
    process.env.REQUEST_LOG = requestLog;
    const adapter = adapterIn(dir);
    const handle = adapter.runTurn(turnSpec({ cwd: dir, effort: 'low' }), () => undefined);
    await handle.done;

    expect(readLog(requestLog).find((r) => r.method === 'session/set_model')).toBeUndefined();
  });

  it('strips XAI_API_KEY and pins one sandbox profile per access level', async () => {
    const dir = tmpDir();
    dirs.push(dir);
    const envLog = path.join(dir, 'child-env.jsonl');
    const adapter = createGrokAdapter({
      grokBin: FAKE,
      turnTimeoutMs: 60_000,
      transcriptsDir: dir,
      log: silent,
      // An XAI_API_KEY really is present in the Veneer service environment, and
      // Grok would silently bill it instead of the subscription login.
      buildEnv: () => ({
        ...process.env,
        CHILD_ENV_LOG: envLog,
        XAI_API_KEY: 'secret-api-key',
        GROK_CODE_XAI_API_KEY: 'secret-api-key-alias',
        GROK_HOME: path.join(dir, 'home'),
      }),
    });

    const safe = adapter.runTurn(turnSpec({ cwd: dir, dangerous: false }), () => undefined);
    await safe.done;
    const full = adapter.runTurn(turnSpec({ cwd: dir, dangerous: true, turnId: 'turn-2' }), () => undefined);
    await full.done;

    const childEnvs = readLog(envLog) as unknown as Record<string, string>[];
    expect(childEnvs).toHaveLength(2); // one long-lived process per access level
    for (const env of childEnvs) {
      expect(env.XAI_API_KEY).toBeUndefined();
      expect(env.GROK_CODE_XAI_API_KEY).toBeUndefined();
      expect(env.GROK_HOME).toBe(path.join(dir, 'home'));
      expect(env.GROK_DISABLE_AUTOUPDATER).toBe('1');
      // Every Claude/Cursor compatibility scanner is off — they default to ON
      // and would import the login account's hooks, permission rules, MCP
      // servers and instruction files into the turn.
      for (const key of DISABLED_COMPAT_SCANNERS) expect(env[key]).toBe('false');
    }
    // Sandbox is off by default in the CLI, so it is set explicitly both ways.
    expect(childEnvs.map((env) => env.GROK_SANDBOX)).toEqual(['workspace', 'off']);
    expect(fs.readFileSync(envLog, 'utf8')).not.toContain('secret-api-key');
  });
});
