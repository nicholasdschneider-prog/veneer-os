import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createClaudeAdapter } from '../src/providers/claude/adapter.js';

const FAKE_CLAUDE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/fake-claude.mjs');
const silent = { warn() {}, error() {} };
const dirs: string[] = [];

function adapter(id: 'claude' | 'openrouter' = 'claude') {
  return createClaudeAdapter({
    id,
    claudeBin: FAKE_CLAUDE,
    turnTimeoutMs: 2_000,
    log: silent,
  });
}

afterEach(() => {
  delete process.env.FAKE_CLAUDE_MODE;
  delete process.env.FAKE_CLAUDE_ARG_LOG;
  delete process.env.FAKE_CLAUDE_COMPACT_MESSAGE;
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('Claude native session compaction', () => {
  it('runs the exact headless slash command against the existing session', async () => {
    process.env.FAKE_CLAUDE_MODE = 'compact';
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-compact-test-'));
    dirs.push(dir);
    const argsLog = path.join(dir, 'args.jsonl');
    process.env.FAKE_CLAUDE_ARG_LOG = argsLog;

    const claude = adapter();
    const result = await claude.compactSession!({
      cwd: dir,
      nativeSessionId: 'existing-session',
      dangerous: false,
    }).done;

    expect(result).toEqual({ contextTokens: null });
    const args = JSON.parse(fs.readFileSync(argsLog, 'utf8').trim()) as string[];
    expect(args.slice(0, 2)).toEqual(['-p', '/compact']);
    expect(args).toEqual(expect.arrayContaining(['--resume', 'existing-session', '--output-format', 'stream-json']));
    expect(args).not.toContain('--input-format');
    expect(args).not.toContain('--session-id');
  });

  it('rejects Claude Code’s synthetic no-history response as not ready', async () => {
    process.env.FAKE_CLAUDE_MODE = 'compact-empty';
    const handle = adapter().compactSession!({ cwd: os.tmpdir(), nativeSessionId: 'empty-session' });
    await expect(handle.done).rejects.toThrow(/No messages to compact/i);
  });

  it('rejects the live insufficient-history stream even with a boundary and success result', async () => {
    process.env.FAKE_CLAUDE_MODE = 'compact-insufficient-history';
    const handle = adapter().compactSession!({ cwd: os.tmpdir(), nativeSessionId: 'short-session' });
    await expect(handle.done).rejects.toThrow(/^Not enough messages to compact\.$/i);
  });

  it.each(['No history to compact.', 'Not enough chat history to compact.'])(
    'rejects the current insufficient-history variant: %s',
    async (message) => {
      process.env.FAKE_CLAUDE_MODE = 'compact-insufficient-history';
      process.env.FAKE_CLAUDE_COMPACT_MESSAGE = message;
      const handle = adapter().compactSession!({ cwd: os.tmpdir(), nativeSessionId: 'short-session' });
      await expect(handle.done).rejects.toThrow(message);
    },
  );

  it('keeps stale native-session failures identifiable without invoking a model', async () => {
    process.env.FAKE_CLAUDE_MODE = 'compact-stale';
    const handle = adapter().compactSession!({ cwd: os.tmpdir(), nativeSessionId: 'stale-session' });
    await expect(handle.done).rejects.toThrow(/No conversation found with session ID/i);
  });

  it('does not accept an ordinary model result as successful compaction', async () => {
    process.env.FAKE_CLAUDE_MODE = 'compact-ordinary';
    const handle = adapter().compactSession!({ cwd: os.tmpdir(), nativeSessionId: 'existing-session' });
    await expect(handle.done).rejects.toThrow(/native compaction boundary/i);
  });

  it('does not advertise Claude-only compaction through OpenRouter', () => {
    expect(adapter('openrouter').compactSession).toBeUndefined();
  });
});
