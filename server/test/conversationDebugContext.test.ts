import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readConversationDebugContext } from '../src/conversationDebugContext.js';
import type { ConversationRow } from '../src/db/db.js';
import { migrate } from '../src/db/migrate.js';
import { createMaterializer } from '../src/toolbox/materialize.js';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/db/migrations');
const silent = { warn: () => undefined, error: () => undefined };

describe('conversation debug context', () => {
  let root: string;
  let dataDir: string;
  let workspaceDir: string;
  let db: Database.Database;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-context-'));
    dataDir = path.join(root, 'data');
    workspaceDir = path.join(dataDir, 'workspaces', 'assistant');
    fs.mkdirSync(workspaceDir, { recursive: true });
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db, MIGRATIONS);
    db.prepare("INSERT INTO users (id, email, display_name, role) VALUES (1, 'owner@example.com', 'Owner', 'owner')").run();
  });

  afterEach(() => {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  function conversation(id: string): ConversationRow {
    return db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as ConversationRow;
  }

  it('returns the exact per-chat instructions and never serializes MCP secrets', () => {
    db.prepare(
      "INSERT INTO conversations (id, assistant_id, user_id, provider, native_session_id) VALUES ('conv-1', 1, 1, 'codex', 'native-1')",
    ).run();
    db.prepare(
      `INSERT INTO connections (name, slug, config_json, policy_json, enabled)
       VALUES ('Private tool', 'private-tool', ?, ?, 1)`,
    ).run(
      JSON.stringify({ transport: 'stdio', command: 'private-mcp', args: [], env: { TOKEN: 'super-secret' } }),
      JSON.stringify({ default: 'approve', rules: [{ match: 'mcp__private-tool__read', action: 'allow' }] }),
    );

    createMaterializer({ db, dataDir, internalBaseUrl: 'http://127.0.0.1:9999', log: silent }).prepare(
      { workspaceDir, assistantSlug: 'assistant', elevated: false },
      'agent-secret',
      'conv-1',
      1,
      '## Remembered context\nThe user likes concise answers.',
    );

    const result = readConversationDebugContext(db, { dataDir, sourceDir: path.join(root, 'source') }, conversation('conv-1'));
    expect(result.instructions.exactReceipt).toBe(true);
    expect(result.instructions.delivery).toBe('codex-developer-instructions');
    expect(result.instructions.core?.role).toBe('system/developer');
    expect(result.instructions.chatSnapshot?.content).not.toContain('The user likes concise answers.');
    expect(result.instructions.memory).toMatchObject({
      role: 'user reference data',
      present: true,
      content: '## Remembered context\nThe user likes concise answers.',
    });
    expect(result.tooling.mcpServers).toContain('private-tool');
    expect(result.tooling.allowedPermissions).toContain('mcp__private-tool__read');
    expect(JSON.stringify(result)).not.toContain('super-secret');
    expect(JSON.stringify(result)).not.toContain('agent-secret');
  });

  it('reports fixed project context and provider-native custom-root sources separately', () => {
    const customRoot = path.join(root, 'custom-project');
    fs.mkdirSync(customRoot);
    fs.writeFileSync(path.join(customRoot, 'AGENTS.md'), '# User AGENTS\nCodex-specific guidance.\n');
    fs.writeFileSync(path.join(customRoot, 'CLAUDE.md'), '# User CLAUDE\nClaude-specific guidance.\n');
    db.prepare(
      "INSERT INTO projects (id, slug, name, instructions, root_dir) VALUES ('project-1', 'custom', 'Custom project', 'Shared project guidance.', ?)",
    ).run(customRoot);
    db.prepare(
      "INSERT INTO conversations (id, assistant_id, user_id, provider, native_session_id, project_id) VALUES ('codex-conv', 1, 1, 'codex', 'native-codex', 'project-1')",
    ).run();
    db.prepare(
      "INSERT INTO conversations (id, assistant_id, user_id, provider, native_session_id, project_id) VALUES ('claude-conv', 1, 1, 'claude', 'native-claude', 'project-1')",
    ).run();
    const materializer = createMaterializer({
      db,
      dataDir,
      internalBaseUrl: 'http://127.0.0.1:9999',
      log: silent,
    });
    const target = {
      workspaceDir: customRoot,
      assistantSlug: 'assistant',
      elevated: false,
      projectId: 'project-1',
      customRoot: true,
    };

    materializer.prepare(target, 'codex-secret', 'codex-conv', 1);
    materializer.prepare(target, 'claude-secret', 'claude-conv', 1);

    const config = { dataDir, sourceDir: path.join(root, 'source') };
    const codex = readConversationDebugContext(db, config, conversation('codex-conv'));
    const claude = readConversationDebugContext(db, config, conversation('claude-conv'));
    expect(codex.instructions.chatSnapshot?.content).toContain('Shared project guidance.');
    expect(codex.instructions.repository?.files.map((file) => path.basename(file.path))).toEqual(['AGENTS.md']);
    expect(claude.instructions.chatSnapshot?.content).toContain('Shared project guidance.');
    expect(claude.instructions.repository?.files.map((file) => path.basename(file.path))).toEqual(['CLAUDE.md']);

    db.prepare("UPDATE projects SET instructions = 'Revised shared guidance.' WHERE id = 'project-1'").run();

    for (const id of ['codex-conv', 'claude-conv']) {
      const refreshed = readConversationDebugContext(db, config, conversation(id));
      expect(refreshed.instructions.chatSnapshot?.content).toContain('Shared project guidance.');
      expect(refreshed.instructions.chatSnapshot?.content).not.toContain('Revised shared guidance.');
      expect(refreshed.instructions.chatSnapshot?.settingsCurrent).toBe(false);
    }
  });

  it('does not present one workspace file as the complete context for an older chat', () => {
    db.prepare(
      "INSERT INTO conversations (id, assistant_id, user_id, provider, native_session_id) VALUES ('old-conv', 1, 1, 'claude', 'native-2')",
    ).run();
    fs.writeFileSync(path.join(workspaceDir, 'CLAUDE.md'), 'Legacy context\n');

    const result = readConversationDebugContext(db, { dataDir, sourceDir: path.join(root, 'source') }, conversation('old-conv'));
    expect(result.instructions.exactReceipt).toBe(false);
    expect(result.instructions.core?.current).toBe(false);
    expect(result.instructions.chatSnapshot?.current).toBe(false);
    expect(result.instructions.repository?.current).toBe(false);
    expect(result.instructions.note).toContain('No provider turn receipt');
  });
});
