import type { ExecFileException } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  probeProviderVersion,
  readProviderRuntimeVersions,
  supportsConciseOutputStyle,
  type ExecFileLike,
} from '../src/providers/versions.js';

function runner(outputs: Record<string, { stdout?: string; stderr?: string; error?: Error }>): ExecFileLike {
  return (file, _args, _options, callback) => {
    const output = outputs[file] ?? { error: new Error('missing') };
    queueMicrotask(() => callback(
      (output.error ?? null) as ExecFileException | null,
      output.stdout ?? '',
      output.stderr ?? '',
    ));
  };
}

describe('provider runtime versions', () => {
  it('extracts semantic versions without exposing arbitrary command output', async () => {
    await expect(probeProviderVersion('claude', runner({
      claude: { stdout: '2.1.232 (Claude Code)\nprivate path that must not escape' },
    }))).resolves.toBe('2.1.232');
    await expect(probeProviderVersion('grok', runner({
      grok: { stderr: 'grok 1.0.3-beta.2 (build hash)' },
    }))).resolves.toBe('1.0.3-beta.2');
  });

  it.each([
    ['missing binary', runner({ broken: { error: new Error('ENOENT /private/bin') } })],
    ['malformed output', runner({ broken: { stdout: 'unknown version' } })],
  ])('degrades %s to an unavailable version', async (_label, run) => {
    await expect(probeProviderVersion('broken', run)).resolves.toBeNull();
  });

  it('probes independent CLIs in parallel and identifies the OpenRouter harness', async () => {
    const versions = await readProviderRuntimeVersions(
      { claudeBin: 'claude', codexBin: 'codex', grokBin: 'grok' },
      runner({
        claude: { stdout: '2.1.232 (Claude Code)' },
        codex: { stdout: 'codex-cli 0.147.0' },
        grok: { stdout: 'grok 1.0.3 (abc123)' },
      }),
    );
    expect(versions).toEqual({
      claude: { runtime: 'Claude Code', version: '2.1.232', supportsConciseOutputStyle: false },
      openrouter: { runtime: 'Claude Code harness', version: '2.1.232', supportsConciseOutputStyle: false },
      codex: { runtime: 'Codex CLI', version: '0.147.0', supportsConciseOutputStyle: false },
      grok: { runtime: 'Grok CLI', version: '1.0.3', supportsConciseOutputStyle: false },
    });
  });

  it('gates Concise at the Claude Code release that introduced it', () => {
    expect(supportsConciseOutputStyle(null)).toBe(false);
    expect(supportsConciseOutputStyle('2.1.236')).toBe(false);
    expect(supportsConciseOutputStyle('2.1.237')).toBe(true);
    expect(supportsConciseOutputStyle('2.2.0')).toBe(true);
  });
});
