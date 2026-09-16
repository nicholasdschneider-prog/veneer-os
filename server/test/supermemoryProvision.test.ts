import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSupermemoryProvisioner, ensureSupermemoryConfigured } from '../src/memory/provision.js';

describe('Supermemory provisioning', () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    vi.useRealTimers();
    for (const directory of temporaryDirectories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('writes a private environment file and starts the Linux user service', async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'veneer-supermemory-home-'));
    temporaryDirectories.push(homeDir);
    const dataDir = path.join(homeDir, '.local', 'share', 'veneer-pro');
    const binary = path.join(homeDir, '.supermemory', 'bin', 'supermemory-server');
    const apiKeyFile = path.join(dataDir, 'supermemory', 'api-key');
    fs.mkdirSync(path.dirname(binary), { recursive: true });
    fs.writeFileSync(binary, '#!/bin/sh\n', { mode: 0o700 });
    fs.mkdirSync(path.dirname(apiKeyFile), { recursive: true });
    fs.writeFileSync(apiKeyFile, 'generated-key\n', { mode: 0o600 });
    const runCommand = vi.fn(async () => {});
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status: 200 }));

    await expect(
      ensureSupermemoryConfigured({
        dataDir,
        homeDir,
        platform: 'linux',
        openRouterApiKey: 'provider-key',
        runCommand,
        fetchImpl,
        wait: async () => {},
      }),
    ).resolves.toEqual({ configured: true });

    const environmentFile = path.join(homeDir, '.config', 'veneer-pro', 'supermemory.env');
    expect(fs.statSync(environmentFile).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(environmentFile, 'utf8')).toContain('OPENAI_API_KEY=provider-key\n');
    expect(runCommand.mock.calls.map(([command, args]) => [command, args])).toEqual([
      ['/usr/bin/systemctl', ['--user', 'daemon-reload']],
      ['/usr/bin/systemctl', ['--user', 'enable', 'veneer-supermemory.service']],
      ['/usr/bin/systemctl', ['--user', 'restart', 'veneer-supermemory.service']],
    ]);
  });

  it('kickstarts the macOS launchd job when Supermemory and the job are installed', async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'veneer-supermemory-darwin-'));
    temporaryDirectories.push(homeDir);
    const dataDir = path.join(homeDir, 'Library', 'Application Support', 'veneer-pro');
    const binary = path.join(homeDir, '.supermemory', 'bin', 'supermemory-server');
    const apiKeyFile = path.join(dataDir, 'supermemory', 'api-key');
    fs.mkdirSync(path.dirname(binary), { recursive: true });
    fs.writeFileSync(binary, '#!/bin/sh\n', { mode: 0o700 });
    fs.mkdirSync(path.dirname(apiKeyFile), { recursive: true });
    fs.writeFileSync(apiKeyFile, 'generated-key\n', { mode: 0o600 });
    const runCommand = vi.fn(async () => {});
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status: 200 }));

    await expect(
      ensureSupermemoryConfigured({
        dataDir,
        homeDir,
        platform: 'darwin',
        uid: 501,
        openRouterApiKey: 'provider-key',
        runCommand,
        fetchImpl,
        wait: async () => {},
      }),
    ).resolves.toEqual({ configured: true });

    const environmentFile = path.join(homeDir, '.config', 'veneer-pro', 'supermemory.env');
    expect(fs.statSync(environmentFile).mode & 0o777).toBe(0o600);
    expect(runCommand.mock.calls.map(([command, args]) => [command, args])).toEqual([
      ['/bin/launchctl', ['print', 'gui/501/com.veneer.supermemory']],
      ['/bin/launchctl', ['kickstart', '-k', 'gui/501/com.veneer.supermemory']],
    ]);
    expect(runCommand).not.toHaveBeenCalledWith('/usr/bin/systemctl', expect.anything());
  });

  it('explains that the macOS launchd job is missing instead of installing one', async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'veneer-supermemory-darwin-nojob-'));
    temporaryDirectories.push(homeDir);
    const dataDir = path.join(homeDir, 'data');
    const binary = path.join(homeDir, '.supermemory', 'bin', 'supermemory-server');
    fs.mkdirSync(path.dirname(binary), { recursive: true });
    fs.writeFileSync(binary, '#!/bin/sh\n', { mode: 0o700 });
    const runCommand = vi.fn(async (_command: string, args: string[]) => {
      if (args[0] === 'print') throw new Error('Could not find service');
    });

    const result = await ensureSupermemoryConfigured({
      dataDir,
      homeDir,
      platform: 'darwin',
      uid: 501,
      openRouterApiKey: 'provider-key',
      runCommand,
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status: 200 })),
      wait: async () => {},
    });

    expect(result.configured).toBe(false);
    expect(result.reason).toContain('com.veneer.supermemory');
    expect(runCommand.mock.calls.map(([, args]) => args[0])).toEqual(['print']);
    expect(fs.existsSync(path.join(homeDir, '.config', 'veneer-pro', 'supermemory.env'))).toBe(false);
  });

  it('explains that Supermemory itself is not installed on macOS', async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'veneer-supermemory-darwin-nobin-'));
    temporaryDirectories.push(homeDir);
    const runCommand = vi.fn(async () => {});

    const result = await ensureSupermemoryConfigured({
      dataDir: path.join(homeDir, 'data'),
      homeDir,
      platform: 'darwin',
      uid: 501,
      openRouterApiKey: 'provider-key',
      runCommand,
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status: 200 })),
      wait: async () => {},
    });

    expect(result.configured).toBe(false);
    expect(result.reason).toContain('supermemory-server');
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('does nothing when the provider key is unavailable', async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'veneer-supermemory-empty-'));
    temporaryDirectories.push(homeDir);
    const runCommand = vi.fn(async () => {});

    await expect(
      ensureSupermemoryConfigured({
        dataDir: path.join(homeDir, 'data'),
        homeDir,
        platform: 'linux',
        openRouterApiKey: '',
        runCommand,
      }),
    ).resolves.toEqual({
      configured: false,
      reason: 'OPENROUTER_API_KEY is not available.',
    });
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('repairs a configured installation when the live Memory API is down', async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'veneer-supermemory-repair-'));
    temporaryDirectories.push(homeDir);
    const dataDir = path.join(homeDir, '.local', 'share', 'veneer-pro');
    const binary = path.join(homeDir, '.supermemory', 'bin', 'supermemory-server');
    const environmentFile = path.join(homeDir, '.config', 'veneer-pro', 'supermemory.env');
    const apiKeyFile = path.join(dataDir, 'supermemory', 'api-key');
    fs.mkdirSync(path.dirname(binary), { recursive: true });
    fs.writeFileSync(binary, '#!/bin/sh\n', { mode: 0o700 });
    fs.mkdirSync(path.dirname(environmentFile), { recursive: true });
    fs.writeFileSync(environmentFile, 'OPENAI_API_KEY=provider-key\n', { mode: 0o600 });
    fs.mkdirSync(path.dirname(apiKeyFile), { recursive: true });
    fs.writeFileSync(apiKeyFile, 'generated-key\n', { mode: 0o600 });
    const runCommand = vi.fn(async () => {});
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('{}', { status: 503 }))
      .mockResolvedValue(new Response('{}', { status: 200 }));

    await expect(ensureSupermemoryConfigured({
      dataDir,
      homeDir,
      platform: 'linux',
      openRouterApiKey: 'provider-key',
      runCommand,
      fetchImpl,
      wait: async () => {},
    })).resolves.toEqual({ configured: true });

    expect(runCommand).toHaveBeenCalledWith('/usr/bin/systemctl', ['--user', 'restart', 'veneer-supermemory.service']);
  });

  it('retries automatically when the provider key appears after enrollment', async () => {
    vi.useFakeTimers();
    let openRouterApiKey: string | null = null;
    let configured = false;
    const provision = vi.fn(async ({ openRouterApiKey: key }: { openRouterApiKey: string }) => {
      if (!key) return { configured: false, reason: 'OPENROUTER_API_KEY is not available.' };
      configured = true;
      return { configured: true };
    });
    const reconciler = createSupermemoryProvisioner({
      dataDir: '/tmp/veneer-memory-test',
      getOpenRouterApiKey: () => openRouterApiKey,
      intervalMs: 1_000,
      provision,
    });

    reconciler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(provision).toHaveBeenCalledWith(expect.objectContaining({ openRouterApiKey: '' }));

    openRouterApiKey = 'provider-key';
    await vi.advanceTimersByTimeAsync(1_000);
    expect(provision).toHaveBeenLastCalledWith(expect.objectContaining({ openRouterApiKey: 'provider-key' }));
    expect(configured).toBe(true);
    reconciler.stop();
  });
});
