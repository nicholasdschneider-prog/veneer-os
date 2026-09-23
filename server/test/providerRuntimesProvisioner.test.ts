import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  loadProviderRuntimePolicy,
  parseProviderRuntimeVersion,
  providerRuntimeInstallPlan,
  providerRuntimePaths,
  provisionProviderRuntimes,
  verifyProviderRuntimeVersions,
} from '../../installer/provider-runtimes.mjs';

const temporaryDirectories: string[] = [];

function temporaryDirectory(name: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), name));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('pinned provider runtime policy', () => {
  it('contains one exact stable version and official source for every provider', () => {
    expect(loadProviderRuntimePolicy()).toEqual({
      claude: { installerUrl: 'https://claude.ai/install.sh', version: '2.1.280' },
      codex: { package: '@openai/codex', version: '0.156.1' },
      grok: { installerUrl: 'https://x.ai/cli/install.sh', version: '1.0.5' },
    });
  });

  it('rejects floating, malformed, and unofficial policy values', () => {
    const directory = temporaryDirectory('veneer-provider-policy-');
    const file = path.join(directory, 'policy.json');
    fs.writeFileSync(file, JSON.stringify({
      claude: { installerUrl: 'https://claude.ai/install.sh', version: 'latest' },
      codex: { package: '@openai/codex', version: '0.156.1' },
      grok: { installerUrl: 'https://example.test/install.sh', version: '1.0.5' },
    }));
    expect(() => loadProviderRuntimePolicy(file)).toThrow(/exact semantic version/i);
  });

  it('builds user-owned exact-version install commands for both OS families', () => {
    const policy = loadProviderRuntimePolicy();
    const serviceHome = '/srv/veneer';
    const plan = providerRuntimeInstallPlan({ policy, serviceHome, npmBin: '/usr/bin/npm' });
    expect(plan.npm).toEqual({
      file: '/usr/bin/npm',
      args: [
        'install', '--global', '--prefix', '/srv/veneer/.local', '--no-audit', '--no-fund',
        '@openai/codex@0.156.1',
      ],
    });
    expect(plan.claude).toEqual({
      installerUrl: 'https://claude.ai/install.sh',
      version: '2.1.280',
    });
    expect(plan.grok).toEqual({
      installerUrl: 'https://x.ai/cli/install.sh',
      version: '1.0.5',
      binDir: '/srv/veneer/.local/bin',
    });
    expect(providerRuntimePaths('/Users/client/veneer-pro-home')).toMatchObject({
      claude: '/Users/client/veneer-pro-home/.local/bin/claude',
      codex: '/Users/client/veneer-pro-home/.local/bin/codex',
      grok: '/Users/client/veneer-pro-home/.local/bin/grok',
    });
  });
});

describe('provider runtime provisioning and verification', () => {
  it('parses each vendor version format', () => {
    expect(parseProviderRuntimeVersion('2.1.280 (Claude Code)')).toBe('2.1.280');
    expect(parseProviderRuntimeVersion('codex-cli 0.156.1')).toBe('0.156.1');
    expect(parseProviderRuntimeVersion('grok 1.0.5 (abcdef123)')).toBe('1.0.5');
  });

  it('preserves provider auth files while using only binary/package install targets', () => {
    const serviceHome = temporaryDirectory('veneer-provider-home-');
    const sentinels = [
      path.join(serviceHome, '.claude', '.credentials.json'),
      path.join(serviceHome, '.codex', 'auth.json'),
      path.join(serviceHome, '.grok', 'auth.json'),
    ];
    for (const file of sentinels) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `sentinel:${path.basename(path.dirname(file))}`);
    }
    const calls: Array<{ file: string; args: string[] }> = [];
    const execFile = vi.fn((file: string, args: string[], options: { encoding?: string; env?: NodeJS.ProcessEnv }) => {
      calls.push({ file, args });
      if (file === 'curl') fs.writeFileSync(args[args.indexOf('-o') + 1]!, '#!/usr/bin/env bash\n');
      if (file === 'bash' && options.env?.GROK_BIN_DIR) {
        const staged = path.join(options.env!.HOME!, '.grok', 'downloads', 'grok-test');
        fs.mkdirSync(path.dirname(staged), { recursive: true });
        fs.writeFileSync(staged, 'fake grok');
        fs.symlinkSync(staged, path.join(options.env!.GROK_BIN_DIR!, 'grok'));
        fs.symlinkSync(staged, path.join(options.env!.GROK_BIN_DIR!, 'agent'));
      }
      if (file === 'bash' && !options.env?.GROK_BIN_DIR) {
        const staged = path.join(options.env!.HOME!, '.local', 'share', 'claude', 'claude-test');
        const link = path.join(options.env!.HOME!, '.local', 'bin', 'claude');
        fs.mkdirSync(path.dirname(staged), { recursive: true });
        fs.mkdirSync(path.dirname(link), { recursive: true });
        fs.writeFileSync(staged, 'fake claude');
        fs.symlinkSync(staged, link);
      }
      if (options?.encoding) {
        if (file.endsWith('/claude')) return '2.1.280 (Claude Code)\n';
        if (file.endsWith('/codex')) return 'codex-cli 0.156.1\n';
        if (file.endsWith('/grok')) return 'grok 1.0.5 (build)\n';
      }
      return '';
    });
    expect(provisionProviderRuntimes({
      policy: loadProviderRuntimePolicy(),
      serviceHome,
      npmBin: '/usr/bin/npm',
      execFile: execFile as never,
    })).toEqual({ claude: '2.1.280', codex: '0.156.1', grok: '1.0.5' });
    for (const file of sentinels) expect(fs.readFileSync(file, 'utf8')).toMatch(/^sentinel:/);
    expect(calls.some((call) => call.file === 'bash' && call.args.at(-1) === '1.0.5')).toBe(true);
    expect(fs.realpathSync(path.join(serviceHome, '.local', 'bin', 'grok'))).toContain(
      '/.local/lib/veneer-provider-runtimes/grok-1.0.5',
    );
    expect(fs.realpathSync(path.join(serviceHome, '.local', 'bin', 'claude'))).toContain(
      '/.local/lib/veneer-provider-runtimes/claude-2.1.280',
    );
  });

  it('fails closed on a version mismatch or version command failure', () => {
    const policy = loadProviderRuntimePolicy();
    const serviceHome = '/srv/veneer';
    const mismatch = vi.fn(() => 'codex-cli 0.149.0\n');
    expect(() => verifyProviderRuntimeVersions({
      policy,
      serviceHome,
      provider: 'codex',
      execFile: mismatch as never,
    })).toThrow(/expected 0\.156\.1, found 0\.149\.0/i);
    const failed = vi.fn(() => { throw new Error('spawn failed'); });
    expect(() => verifyProviderRuntimeVersions({
      policy,
      serviceHome,
      provider: 'grok',
      execFile: failed as never,
    })).toThrow(/version check failed.*spawn failed/i);
  });
});
