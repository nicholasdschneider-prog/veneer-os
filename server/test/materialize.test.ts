import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import {
  CORE_INSTRUCTIONS_VERSION,
  isMemoryWrappedPromptFor,
  promptWithMemoryReference,
} from '../src/instructions/context.js';
import { createMaterializer } from '../src/toolbox/materialize.js';
import { writeDopplerMetadata } from '../src/secrets/doppler.js';
import { writeClaudePreferences } from '../src/providers/claude/preferences.js';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/db/migrations');
const silent = { warn: () => undefined, error: () => undefined };
const INTERNAL_BASE_URL = 'http://127.0.0.1:9999';

describe('materializer', () => {
  let dir: string;
  let dataDir: string;
  let workspaceDir: string;
  let db: Database.Database;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-materialize-'));
    dataDir = path.join(dir, 'data');
    workspaceDir = path.join(dir, 'workspace');
    fs.mkdirSync(workspaceDir, { recursive: true });
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db, MIGRATIONS);
    db.prepare("INSERT INTO users (id, email, display_name, role) VALUES (1, 'u@example.com', 'User', 'owner')").run();
    db.prepare("UPDATE assistants SET instructions = 'Be kind to the customer.' WHERE id = 1").run();
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function addConversation(
    id: string,
    provider: 'claude' | 'openrouter' | 'codex' = 'codex',
    projectId: string | null = null,
    assistantId = 1,
  ) {
    db.prepare(
      `INSERT INTO conversations (id, assistant_id, user_id, project_id, provider, native_session_id)
       VALUES (?, ?, 1, ?, ?, ?)`,
    ).run(id, assistantId, projectId, provider, `${id}-native`);
  }

  const PROJECT_DOPPLER_CLI = { binDir: '/tmp/project-cli', configDir: '/tmp/.doppler', userHome: '/tmp' };

  function materializer(options: {
    desktopCdpPort?: number;
    publicOrigin?: string;
    projectDopplerCli?: { binDir: string; configDir: string; userHome: string } | null;
    veneerBrowserAvailable?: () => boolean;
  } = {}) {
    return createMaterializer({
      db,
      dataDir,
      internalBaseUrl: INTERNAL_BASE_URL,
      log: silent,
      ...options,
    });
  }

  function target(overrides: Record<string, unknown> = {}) {
    return { workspaceDir, assistantSlug: 'assistant', elevated: false, ...overrides };
  }

  it.each([
    ['codex', 'codex-developer-instructions'],
    ['claude', 'claude-appended-system-prompt'],
  ] as const)('delivers core rules and one fixed snapshot through the %s instruction channel', (provider, delivery) => {
    const conversationId = `${provider}-chat`;
    addConversation(conversationId, provider);
    const result = materializer().prepare(target(), 'test-token', conversationId, 1);

    expect(result.developerInstructions).toContain(`# Core Veneer rules (v${CORE_INSTRUCTIONS_VERSION})`);
    expect(result.developerInstructions).toContain('Localhost and other loopback URLs are internal verification targets');
    expect(result.developerInstructions).toContain('# Fixed chat context (v1)');
    expect(result.developerInstructions).toContain('Be kind to the customer.');
    expect(result.instructionHash).toMatch(/^[a-f0-9]{64}$/);
    expect(fs.existsSync(path.join(workspaceDir, 'AGENTS.md'))).toBe(false);
    expect(fs.existsSync(path.join(workspaceDir, 'CLAUDE.md'))).toBe(false);

    const receipt = JSON.parse(
      fs.readFileSync(path.join(dataDir, 'spawn', 'assistant', conversationId, 'debug-context.json'), 'utf8'),
    );
    expect(receipt.delivery).toBe(delivery);
    expect(receipt.core).toMatchObject({ source: 'Veneer Pro', role: 'system/developer', version: CORE_INSTRUCTIONS_VERSION, current: true });
    expect(receipt.chatSnapshot).toMatchObject({
      source: 'Agent and project settings',
      role: 'system/developer',
      version: 1,
      current: true,
      settingsCurrent: true,
    });
  });

  it('keeps an existing chat snapshot fixed and gives a new chat the latest settings', () => {
    db.prepare(
      "INSERT INTO projects (id, slug, name, instructions) VALUES ('project-1', 'acme', 'Acme', 'First project brief.')",
    ).run();
    addConversation('old-chat', 'claude', 'project-1');
    const mat = materializer();
    const first = mat.prepare(target({ projectId: 'project-1' }), 'token', 'old-chat', 1);

    db.prepare("UPDATE assistants SET instructions = 'Latest agent brief.' WHERE id = 1").run();
    db.prepare("UPDATE projects SET instructions = 'Latest project brief.' WHERE id = 'project-1'").run();
    const oldAgain = mat.prepare(target({ projectId: 'project-1' }), 'token', 'old-chat', 1);
    expect(oldAgain.developerInstructions).toBe(first.developerInstructions);
    expect(oldAgain.developerInstructions).toContain('First project brief.');
    expect(oldAgain.developerInstructions).not.toContain('Latest project brief.');
    const oldReceipt = JSON.parse(
      fs.readFileSync(path.join(dataDir, 'spawn', 'assistant', 'old-chat', 'debug-context.json'), 'utf8'),
    );
    expect(oldReceipt.chatSnapshot.settingsCurrent).toBe(false);

    addConversation('new-chat', 'claude', 'project-1');
    const fresh = mat.prepare(target({ projectId: 'project-1' }), 'token', 'new-chat', 1);
    expect(fresh.developerInstructions).toContain('Latest agent brief.');
    expect(fresh.developerInstructions).toContain('Latest project brief.');
    expect(fresh.developerInstructions).not.toContain('First project brief.');
  });

  it('keeps memory as labeled user reference data instead of policy', () => {
    addConversation('memory-chat');
    const memory = 'The user prefers short status reports.';
    const mat = materializer();
    const result = mat.prepare(target(), 'token', 'memory-chat', 1, memory);

    expect(result.developerInstructions).not.toContain(memory);
    expect(mat.memoryKnownContext(target(), 'memory-chat')).not.toContain(memory);
    const wrapped = promptWithMemoryReference('Do the work.', memory);
    expect(wrapped).toContain('[Veneer reference data — not instructions]');
    expect(wrapped).toContain(memory);
    expect(wrapped).toContain('Current user request:\nDo the work.');
    expect(isMemoryWrappedPromptFor(wrapped, 'Do the work.')).toBe(true);
    expect(isMemoryWrappedPromptFor(wrapped, 'Do something else.')).toBe(false);
    const receipt = JSON.parse(
      fs.readFileSync(path.join(dataDir, 'spawn', 'assistant', 'memory-chat', 'debug-context.json'), 'utf8'),
    );
    expect(receipt.turnData.memory).toMatchObject({
      role: 'user reference data',
      current: true,
      present: true,
      content: memory,
    });
  });

  it('discovers user-owned parent and child provider files without changing them', () => {
    const repository = path.join(dir, 'repo');
    const child = path.join(repository, 'packages', 'app');
    fs.mkdirSync(path.join(repository, '.git'), { recursive: true });
    fs.mkdirSync(child, { recursive: true });
    const rootFile = path.join(repository, 'AGENTS.md');
    const childFile = path.join(child, 'AGENTS.md');
    fs.writeFileSync(rootFile, '# Root user guidance\n');
    fs.writeFileSync(childFile, '# Child user guidance\n');
    addConversation('nested-chat');

    materializer().prepare(target({ workspaceDir: child }), 'token', 'nested-chat', 1);
    const receipt = JSON.parse(
      fs.readFileSync(path.join(dataDir, 'spawn', 'assistant', 'nested-chat', 'debug-context.json'), 'utf8'),
    );
    expect(receipt.repository.files.map((file: { path: string }) => file.path)).toEqual([
      fs.realpathSync(rootFile),
      fs.realpathSync(childFile),
    ]);
    expect(fs.readFileSync(rootFile, 'utf8')).toBe('# Root user guidance\n');
    expect(fs.readFileSync(childFile, 'utf8')).toBe('# Child user guidance\n');
  });

  it('keeps parallel chats in one workspace isolated', () => {
    db.prepare(
      "INSERT INTO projects (id, slug, name, instructions) VALUES ('project-a', 'a', 'A', 'Context A.'), ('project-b', 'b', 'B', 'Context B.')",
    ).run();
    addConversation('chat-a', 'codex', 'project-a');
    addConversation('chat-b', 'codex', 'project-b');
    const mat = materializer();
    const a = mat.prepare(target({ projectId: 'project-a' }), 'a-token', 'chat-a', 1);
    const b = mat.prepare(target({ projectId: 'project-b' }), 'b-token', 'chat-b', 1);

    expect(a.developerInstructions).toContain('Context A.');
    expect(a.developerInstructions).not.toContain('Context B.');
    expect(b.developerInstructions).toContain('Context B.');
    expect(b.developerInstructions).not.toContain('Context A.');
    expect(fs.existsSync(path.join(dataDir, 'spawn', 'assistant', 'chat-a', 'debug-context.json'))).toBe(true);
    expect(fs.existsSync(path.join(dataDir, 'spawn', 'assistant', 'chat-b', 'debug-context.json'))).toBe(true);
    expect(fs.existsSync(path.join(workspaceDir, 'AGENTS.md'))).toBe(false);
  });

  it('preserves user-authored files in a custom project root byte-for-byte', () => {
    const customRoot = path.join(dir, 'custom-root');
    fs.mkdirSync(customRoot);
    const claudeFile = path.join(customRoot, 'CLAUDE.md');
    const agentsFile = path.join(customRoot, 'AGENTS.md');
    fs.writeFileSync(claudeFile, '# User Claude guidance\nKeep this.\n', { mode: 0o640 });
    fs.writeFileSync(agentsFile, '# User Codex guidance\nKeep this too.\n', { mode: 0o640 });
    addConversation('custom-chat');

    materializer().prepare(
      target({ workspaceDir: customRoot, customRoot: true }),
      'token',
      'custom-chat',
      1,
    );
    expect(fs.readFileSync(claudeFile, 'utf8')).toBe('# User Claude guidance\nKeep this.\n');
    expect(fs.readFileSync(agentsFile, 'utf8')).toBe('# User Codex guidance\nKeep this too.\n');
    expect(fs.statSync(claudeFile).mode & 0o777).toBe(0o640);
    expect(fs.statSync(agentsFile).mode & 0o777).toBe(0o640);
  });

  it('uses actual MCP configuration as connector truth without connector prose', () => {
    db.prepare(
      `INSERT INTO connections (name, slug, config_json, policy_json, enabled)
       VALUES ('Shopify', 'shopify', ?, ?, 1)`,
    ).run(
      JSON.stringify({ transport: 'stdio', command: 'shopify-mcp', args: [], env: {} }),
      JSON.stringify({ default: 'approve', rules: [{ match: 'mcp__shopify__get_*', action: 'allow' }] }),
    );
    addConversation('connector-chat');
    const result = materializer().prepare(target(), 'token', 'connector-chat', 1);
    const mcp = JSON.parse(fs.readFileSync(result.mcpConfigPath!, 'utf8'));
    const permissions = JSON.parse(fs.readFileSync(result.settingsPath!, 'utf8')).permissions;

    expect(mcp.mcpServers.shopify).toEqual({ command: 'shopify-mcp', args: [], env: {} });
    expect(permissions.allow).toContain('mcp__shopify__get_*');
    expect(result.developerInstructions.toLowerCase()).not.toContain('shopify');
  });

  it('materializes personal connectors for the turn actor and shared connectors for collaborators', () => {
    db.prepare(
      "INSERT INTO users (id, email, display_name, role) VALUES (2, 'member@example.com', 'Member', 'member')",
    ).run();
    addConversation('team-chat');
    const insert = db.prepare(
      `INSERT INTO user_connectors
         (user_id, connector_slug, label, status, sharing, config_json)
       VALUES (?, 'gmail', ?, 'connected', ?, ?)`,
    );
    const config = (url: string) => JSON.stringify({
      sessionId: url,
      connectedAccountId: url,
      mcp: { type: 'http', url },
    });
    insert.run(1, 'Owner', 'personal', config('https://owner.example/mcp'));
    insert.run(2, 'Member', 'personal', config('https://member.example/mcp'));
    insert.run(1, 'Team', 'shared', config('https://team.example/mcp'));

    const result = materializer().prepare(target(), 'member-token', 'team-chat', 2);
    const servers = JSON.parse(fs.readFileSync(result.mcpConfigPath!, 'utf8')).mcpServers;

    expect(servers['gmail-member']).toMatchObject({ url: 'https://member.example/mcp' });
    expect(servers['gmail-team-everyone-3']).toMatchObject({ url: 'https://team.example/mcp' });
    expect(servers['gmail-owner']).toBeUndefined();
  });

  // Paper Desktop serves MCP from whichever machine runs the app, so an install
  // with no URL must still reach this host's loopback rather than materialize
  // nothing, and a configured host must survive verbatim.
  it('materializes the Paper connector at its default and configured endpoints', () => {
    addConversation('paper-chat');
    const insert = db.prepare(
      `INSERT INTO user_connectors
         (user_id, connector_slug, label, status, sharing, config_json)
       VALUES (1, 'paper', ?, 'connected', 'personal', ?)`,
    );
    insert.run('Local', JSON.stringify({ settings: {} }));
    insert.run('Studio', JSON.stringify({ settings: { url: 'http://100.78.101.60:29979/mcp' } }));

    const result = materializer().prepare(target(), 'token', 'paper-chat', 1);
    const servers = JSON.parse(fs.readFileSync(result.mcpConfigPath!, 'utf8')).mcpServers;

    expect(servers['paper-local']).toMatchObject({ type: 'http', url: 'http://127.0.0.1:29979/mcp' });
    expect(servers['paper-studio']).toMatchObject({ type: 'http', url: 'http://100.78.101.60:29979/mcp' });
  });

  it('writes conversation-scoped built-in tool and browser settings', () => {
    addConversation('tools-chat', 'openrouter');
    const result = materializer({ desktopCdpPort: 9333, publicOrigin: 'https://pro.example.com' }).prepare(
      target(),
      'test-token',
      'tools-chat',
      1,
    );
    const mcp = JSON.parse(fs.readFileSync(result.mcpConfigPath!, 'utf8'));
    const settings = JSON.parse(fs.readFileSync(result.settingsPath!, 'utf8')).permissions;

    expect(mcp.mcpServers.agents.env).toEqual(expect.objectContaining({
      VP_AGENT_TOKEN: 'test-token',
      VP_INTERNAL_BASE_URL: INTERNAL_BASE_URL,
      VP_CONVERSATION_ID: 'tools-chat',
    }));
    expect(mcp.mcpServers.agent_browser.env).toEqual(expect.objectContaining({
      VP_CONVERSATION_ID: 'tools-chat',
      VP_WORKSPACE_DIR: workspaceDir,
      VP_DESKTOP_CDP_PORT: '9333',
      VP_APPS_PUBLIC_ORIGIN: 'https://pro.example.com',
      VP_AGENT_BROWSER_RETURN_IMAGES: '0',
    }));
    expect(settings.allow).toEqual(expect.arrayContaining(['mcp__agents__*', 'mcp__agent_browser__*']));
    expect(settings.deny).toContain('Bash');
  });

  it('forwards the configured pages public base to the agents server, and omits it when unset', () => {
    addConversation('pages-chat', 'claude');

    const configured = materializer({ pagesPublicBase: 'https://pages.example.com' }).prepare(
      target(),
      'test-token',
      'pages-chat',
      1,
    );
    const withPages = JSON.parse(fs.readFileSync(configured.mcpConfigPath!, 'utf8'));
    expect(withPages.mcpServers.agents.env.VP_PAGES_PUBLIC_BASE).toBe('https://pages.example.com');

    const unconfigured = materializer().prepare(target(), 'test-token', 'pages-chat', 1);
    const withoutPages = JSON.parse(fs.readFileSync(unconfigured.mcpConfigPath!, 'utf8'));
    expect(withoutPages.mcpServers.agents.env).not.toHaveProperty('VP_PAGES_PUBLIC_BASE');
  });

  it('scopes output style to Claude and keeps Full Access free of permission settings', () => {
    writeClaudePreferences(db, { outputStyle: 'Concise' });
    addConversation('claude-style', 'claude');
    addConversation('openrouter-style', 'openrouter');

    const normal = materializer().prepare(target(), 'token', 'claude-style', 1);
    const normalSettings = JSON.parse(fs.readFileSync(normal.settingsPath!, 'utf8'));
    expect(normalSettings.outputStyle).toBe('Concise');
    expect(normalSettings.permissions).toMatchObject({ allow: expect.any(Array), deny: expect.any(Array) });

    const fullAccess = materializer().prepare(target({ fullAccess: true }), 'token', 'claude-style', 1);
    expect(JSON.parse(fs.readFileSync(fullAccess.settingsPath!, 'utf8'))).toEqual({ outputStyle: 'Concise' });

    const openrouter = materializer().prepare(target(), 'token', 'openrouter-style', 1);
    expect(JSON.parse(fs.readFileSync(openrouter.settingsPath!, 'utf8'))).not.toHaveProperty('outputStyle');
  });

  describe('Doppler tool visibility by owner role', () => {
    beforeEach(() => {
      // Doppler connected with a read/write agent token available to agents.
      writeDopplerMetadata(db, {
        project: 'lps',
        config: 'prd',
        connectedAt: '2026-08-11T00:00:00.000Z',
        runtimeConfigured: true,
        agentConfigured: true,
      });
      db.prepare(
        "INSERT INTO users (id, email, display_name, role) VALUES (2, 'member@example.com', 'Member', 'member')",
      ).run();
      db.prepare(
        "INSERT INTO users (id, email, display_name, role) VALUES (3, 'consultant@example.com', 'Consultant', 'consultant')",
      ).run();
    });

    function addOwnedConversation(id: string, userId: number) {
      db.prepare(
        `INSERT INTO conversations (id, assistant_id, user_id, project_id, provider, native_session_id)
         VALUES (?, 1, ?, NULL, 'codex', ?)`,
      ).run(id, userId, `${id}-native`);
    }

    function dopplerView(conversationId: string, actorUserId?: number) {
      const owner = db.prepare('SELECT user_id FROM conversations WHERE id = ?').get(conversationId) as
        | { user_id: number }
        | undefined;
      const result = materializer().prepare(target(), 'tok', conversationId, actorUserId ?? owner?.user_id ?? 1);
      const mcp = JSON.parse(fs.readFileSync(result.mcpConfigPath!, 'utf8'));
      const allow = JSON.parse(fs.readFileSync(result.settingsPath!, 'utf8')).permissions.allow as string[];
      return {
        hasServer: Boolean(mcp.mcpServers.doppler),
        dopplerAllows: allow.filter((entry) => entry.startsWith('mcp__doppler__')),
      };
    }

    it('hides the Doppler server and tools from a member-owned conversation', () => {
      addOwnedConversation('member-chat', 2);
      const view = dopplerView('member-chat');
      expect(view.hasServer).toBe(false);
      expect(view.dopplerAllows).toEqual([]);
    });

    it('keeps Doppler visible for an owner-owned conversation', () => {
      addOwnedConversation('owner-chat', 1);
      const view = dopplerView('owner-chat');
      expect(view.hasServer).toBe(true);
      expect(view.dopplerAllows).toEqual(
        expect.arrayContaining(['mcp__doppler__status', 'mcp__doppler__list_secret_names']),
      );
    });

    it('disables request_secret / reveal_secret for a member turn, and keeps them for an admin', () => {
      addOwnedConversation('member-secret-chat', 2);
      addOwnedConversation('consultant-secret-chat', 3);
      addOwnedConversation('owner-secret-chat', 1);
      const mat = materializer({ projectDopplerCli: PROJECT_DOPPLER_CLI });
      const agentsEnv = (conversationId: string, actorUserId: number) => {
        const result = mat.prepare(target(), 'tok', conversationId, actorUserId);
        return JSON.parse(fs.readFileSync(result.mcpConfigPath!, 'utf8')).mcpServers.agents.env;
      };
      expect(agentsEnv('member-secret-chat', 2).VP_SECRET_TOOLS_DISABLED).toBe('1');
      // A member steering an owner's Team chat is still the turn actor.
      expect(agentsEnv('owner-secret-chat', 2).VP_SECRET_TOOLS_DISABLED).toBe('1');
      // 'consultant' is the legacy admin role, so it keeps full access.
      expect(agentsEnv('consultant-secret-chat', 3)).not.toHaveProperty('VP_SECRET_TOOLS_DISABLED');
      expect(agentsEnv('owner-secret-chat', 1)).not.toHaveProperty('VP_SECRET_TOOLS_DISABLED');
    });

    it('disables request_secret / reveal_secret when no authenticated Doppler CLI exists', () => {
      addOwnedConversation('no-cli-chat', 1);
      const withoutCli = materializer().prepare(target(), 'tok', 'no-cli-chat', 1);
      const env = JSON.parse(fs.readFileSync(withoutCli.mcpConfigPath!, 'utf8')).mcpServers.agents.env;
      expect(env.VP_SECRET_TOOLS_DISABLED).toBe('1');
    });

    it('hides Doppler when a member initiates a turn in an owner Team chat', () => {
      addOwnedConversation('owner-team-chat', 1);
      expect(dopplerView('owner-team-chat', 2)).toMatchObject({ hasServer: false, dopplerAllows: [] });
    });

    it('keeps Doppler visible for a consultant-owned conversation', () => {
      addOwnedConversation('consultant-chat', 3);
      expect(dopplerView('consultant-chat').hasServer).toBe(true);
    });

    it('keeps Doppler for a boot/system materialization with no conversation', () => {
      expect(dopplerView('').hasServer).toBe(true);
    });
  });

  it('mounts Veneer Browser for an unfiled chat when the client has it configured', () => {
    addConversation('unfiled-browser-chat', 'claude');
    const result = materializer({ veneerBrowserAvailable: () => true }).prepare(
      target(),
      'test-token',
      'unfiled-browser-chat',
    );
    const mcp = JSON.parse(fs.readFileSync(result.mcpConfigPath!, 'utf8'));
    const settings = JSON.parse(fs.readFileSync(result.settingsPath!, 'utf8')).permissions;

    expect(mcp.mcpServers.veneer_browser).toEqual(expect.objectContaining({
      type: 'http',
      headers: { 'X-VP-Agent-Token': 'test-token' },
    }));
    expect(settings.allow).toContain('mcp__veneer_browser__*');
    expect(result.developerInstructions).toContain(
      'Use the `veneer_browser` tools as the default browser for web tasks.',
    );
  });

  it('omits the Veneer Browser steering rule when the client has no browser', () => {
    addConversation('no-browser-chat', 'claude');
    const result = materializer().prepare(target(), 'test-token', 'no-browser-chat', 1);
    const mcp = JSON.parse(fs.readFileSync(result.mcpConfigPath!, 'utf8'));

    expect(mcp.mcpServers.veneer_browser).toBeUndefined();
    expect(result.developerInstructions).not.toContain('veneer_browser');
  });
});
