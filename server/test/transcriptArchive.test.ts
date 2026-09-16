import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import type { ConversationRow } from '../src/db/db.js';
import { createConversationManager } from '../src/runtime/conversationManager.js';
import {
  CLAUDE_RETENTION_DAYS,
  conversationsForSweep,
  createTranscriptArchive,
  ensureClaudeTranscriptRetention,
  transcriptArchivePath,
} from '../src/runtime/transcriptArchive.js';
import type { ProviderAdapter } from '../src/providers/types.js';
import type { ConversationEvent } from '../src/runtime/events.js';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/db/migrations');
const silent = { log: () => undefined, warn: () => undefined };

let root: string;
let dataDir: string;
let nativeDir: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-archive-'));
  dataDir = path.join(root, 'data');
  nativeDir = path.join(root, 'native', 'projects');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** Stands in for a provider that keeps its history in a file it owns. */
function fakeAdapter(id = 'claude'): ProviderAdapter {
  return {
    id,
    mintSessionId: () => 'sid',
    runTurn: () => {
      throw new Error('not used');
    },
    readTranscript: async (conv) => {
      const file = path.join(nativeDir, `${conv.nativeSessionId}.jsonl`);
      const raw = await fsp.readFile(file, 'utf8').catch(() => '');
      return raw
        .split('\n')
        .filter(Boolean)
        .map((line, index) => ({
          type: 'text_final',
          turnId: `t${index}`,
          markdown: JSON.parse(line).markdown as string,
          at: '2026-01-01T00:00:00Z',
        }) as ConversationEvent);
    },
    nativeTranscriptPath: async (conv) => path.join(nativeDir, `${conv.nativeSessionId}.jsonl`),
  };
}

function writeNative(sessionId: string, lines: string[]): string {
  fs.mkdirSync(nativeDir, { recursive: true });
  const file = path.join(nativeDir, `${sessionId}.jsonl`);
  fs.writeFileSync(file, lines.map((markdown) => `${JSON.stringify({ markdown })}\n`).join(''));
  return file;
}

function makeArchive(adapters: Record<string, ProviderAdapter> = { claude: fakeAdapter() }) {
  return createTranscriptArchive({ dataDir, adapters, resolveCwd: () => '/tmp', log: silent });
}

describe('transcript archive', () => {
  it('round trips: archive, provider purges the native file, restore brings it back', async () => {
    const native = writeNative('sid-1', ['hello', 'world']);
    const before = fs.readFileSync(native, 'utf8');
    const archive = makeArchive();

    expect(await archive.archive('claude', { cwd: '/tmp', nativeSessionId: 'sid-1' })).toBe('archived');
    expect(fs.existsSync(transcriptArchivePath(dataDir, 'claude', 'sid-1'))).toBe(true);

    // Claude Code's 30-day cleanup.
    fs.rmSync(native);
    expect(await archive.restore('claude', { cwd: '/tmp', nativeSessionId: 'sid-1' })).toBe(true);
    expect(fs.readFileSync(native, 'utf8')).toBe(before);
  });

  it('skips a second archive when nothing changed, and re-archives once it grows', async () => {
    writeNative('sid-1', ['hello']);
    const archive = makeArchive();
    expect(await archive.archive('claude', { cwd: '/tmp', nativeSessionId: 'sid-1' })).toBe('archived');
    expect(await archive.archive('claude', { cwd: '/tmp', nativeSessionId: 'sid-1' })).toBe('skipped');

    writeNative('sid-1', ['hello', 'more']);
    expect(await archive.archive('claude', { cwd: '/tmp', nativeSessionId: 'sid-1' })).toBe('archived');
    expect(fs.readFileSync(transcriptArchivePath(dataDir, 'claude', 'sid-1'), 'utf8')).toContain('more');
  });

  it('prefers the archive when the native file was truncated', async () => {
    writeNative('sid-1', ['one', 'two', 'three']);
    const archive = makeArchive();
    await archive.archive('claude', { cwd: '/tmp', nativeSessionId: 'sid-1' });

    const native = writeNative('sid-1', ['one']);
    expect(await archive.restore('claude', { cwd: '/tmp', nativeSessionId: 'sid-1' })).toBe(true);
    expect(fs.readFileSync(native, 'utf8')).toContain('three');
  });

  it('leaves a healthy native file alone', async () => {
    const native = writeNative('sid-1', ['one', 'two']);
    const archive = makeArchive();
    await archive.archive('claude', { cwd: '/tmp', nativeSessionId: 'sid-1' });
    expect(await archive.restore('claude', { cwd: '/tmp', nativeSessionId: 'sid-1' })).toBe(false);
    expect(fs.readFileSync(native, 'utf8')).toContain('two');
  });

  it('is a no-op when neither file exists, and when the provider owns no file', async () => {
    const archive = makeArchive();
    expect(await archive.archive('claude', { cwd: '/tmp', nativeSessionId: 'missing' })).toBe('unavailable');
    expect(await archive.restore('claude', { cwd: '/tmp', nativeSessionId: 'missing' })).toBe(false);

    const bare = createTranscriptArchive({
      dataDir,
      adapters: { grok: { ...fakeAdapter('grok'), nativeTranscriptPath: undefined } },
      log: silent,
    });
    expect(await bare.archive('grok', { cwd: '/tmp', nativeSessionId: 'sid-1' })).toBe('unavailable');
    expect(await bare.restore('grok', { cwd: '/tmp', nativeSessionId: 'sid-1' })).toBe(false);
  });

  it('sweeps every conversation that has a native session', async () => {
    writeNative('sid-1', ['a']);
    writeNative('sid-2', ['b']);
    const db = openTestDb();
    db.prepare(
      `INSERT INTO conversations (id, assistant_id, user_id, title, provider, native_session_id, channel)
       VALUES ('conv-2', 1, 1, 'Second', 'claude', 'sid-2', 'web')`,
    ).run();
    const archive = makeArchive();

    expect(await archive.sweep(conversationsForSweep(db))).toEqual({ archived: 2, skipped: 0, errors: 0 });
    expect(await archive.sweep(conversationsForSweep(db))).toEqual({ archived: 0, skipped: 2, errors: 0 });
    db.close();
  });
});

describe('Claude retention setting', () => {
  it('adds cleanupPeriodDays while preserving existing keys', async () => {
    const configDir = path.join(root, '.claude');
    fs.mkdirSync(configDir, { recursive: true });
    const settings = path.join(configDir, 'settings.json');
    fs.writeFileSync(settings, JSON.stringify({ model: 'opus', permissions: { allow: ['Bash'] } }, null, 2));

    expect(await ensureClaudeTranscriptRetention(configDir, silent)).toBe('written');
    const parsed = JSON.parse(fs.readFileSync(settings, 'utf8'));
    expect(parsed).toEqual({
      model: 'opus',
      permissions: { allow: ['Bash'] },
      cleanupPeriodDays: CLAUDE_RETENTION_DAYS,
    });

    // Idempotent, and never lowers a value an operator raised further.
    expect(await ensureClaudeTranscriptRetention(configDir, silent)).toBe('present');
    fs.writeFileSync(settings, JSON.stringify({ cleanupPeriodDays: 99999 }));
    expect(await ensureClaudeTranscriptRetention(configDir, silent)).toBe('present');
  });

  it('creates settings.json when the profile has none', async () => {
    const configDir = path.join(root, 'fresh-claude');
    expect(await ensureClaudeTranscriptRetention(configDir, silent)).toBe('written');
    expect(JSON.parse(fs.readFileSync(path.join(configDir, 'settings.json'), 'utf8'))).toEqual({
      cleanupPeriodDays: CLAUDE_RETENTION_DAYS,
    });
  });

  it('refuses to rewrite a settings.json it cannot parse', async () => {
    const configDir = path.join(root, 'broken-claude');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'settings.json'), '{ not json');
    expect(await ensureClaudeTranscriptRetention(configDir, silent)).toBe('error');
    expect(fs.readFileSync(path.join(configDir, 'settings.json'), 'utf8')).toBe('{ not json');
  });
});

function openTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db, MIGRATIONS);
  db.prepare("INSERT INTO users (email, display_name, role) VALUES ('owner@example.com', 'Sam', 'owner')").run();
  db.prepare(
    `INSERT INTO conversations (id, assistant_id, user_id, title, provider, native_session_id, channel)
     VALUES ('conv-1', 1, 1, 'Test', 'claude', 'sid-1', 'web')`,
  ).run();
  return db;
}

describe('snapshot after a provider purge', () => {
  it('rehydrates from the archive when the native transcript is gone', async () => {
    writeNative('sid-1', ['first question', 'first answer']);
    const db = openTestDb();
    const adapter = fakeAdapter();
    const archive = makeArchive({ claude: adapter });
    const manager = createConversationManager({
      db,
      adapters: { claude: adapter },
      resolveWorkspace: () => ({ workspaceDir: '/tmp', assistantSlug: 'assistant', elevated: false, fullAccess: false }),
      transcriptArchive: archive,
      log: { warn: () => undefined, error: () => undefined },
    });
    const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get('conv-1') as ConversationRow;

    await archive.archive('claude', { cwd: '/tmp', nativeSessionId: 'sid-1' });
    fs.rmSync(path.join(nativeDir, 'sid-1.jsonl'));
    // Without the archive this snapshot would be empty — the bug this fixes.
    expect(await adapter.readTranscript({ cwd: '/tmp', nativeSessionId: 'sid-1' })).toEqual([]);

    const events = await manager.snapshot(conv);
    expect(events.filter((e) => e.type === 'text_final').map((e) => (e as { markdown: string }).markdown)).toEqual([
      'first question',
      'first answer',
    ]);
    db.close();
  });
});
