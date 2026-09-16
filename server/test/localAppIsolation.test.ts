import { fork } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { localAppEnvironment, localAppExecArgv } from '../src/appRunner/manager.js';

describe('local Mini App isolation', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('does not inherit Veneer or Doppler credentials', () => {
    const env = localAppEnvironment({
      PATH: '/usr/bin',
      LANG: 'en_US.UTF-8',
      DOPPLER_TOKEN: 'never-copy-this',
      OPENROUTER_API_KEY: 'never-copy-this-either',
      VP_AGENT_TOKEN: 'also-secret',
    });
    expect(env).toEqual({
      NODE_ENV: 'production',
      PATH: '/usr/bin',
      LANG: 'en_US.UTF-8',
    });
  });

  it('cannot read the Doppler token store or launch child processes', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-local-app-isolation-'));
    dirs.push(dir);
    const appDir = path.join(dir, 'mini-app');
    const childEntry = path.join(dir, 'sandbox-child.mjs');
    const tokenFile = path.join(dir, 'doppler.json');
    fs.mkdirSync(appDir);
    fs.writeFileSync(tokenFile, '{"runtimeToken":"not-a-real-token"}', { mode: 0o600 });
    fs.writeFileSync(
      childEntry,
      [
        "import fs from 'node:fs';",
        "import { spawnSync } from 'node:child_process';",
        'let fileRead = false;',
        'let spawned = false;',
        'try { fs.readFileSync(process.argv[2], "utf8"); fileRead = true; } catch {}',
        'try { const result = spawnSync(process.execPath, ["--version"]); spawned = !result.error; } catch {}',
        'process.send?.({ fileRead, spawned });',
      ].join('\n'),
    );

    const result = await new Promise<{ fileRead: boolean; spawned: boolean }>((resolve, reject) => {
      const child = fork(fs.realpathSync(childEntry), [tokenFile], {
        cwd: appDir,
        env: localAppEnvironment(),
        execArgv: localAppExecArgv(childEntry, appDir),
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      });
      let stderr = '';
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      child.once('message', (message) => resolve(message as { fileRead: boolean; spawned: boolean }));
      child.once('error', reject);
      child.once('exit', (code) => {
        if (code && code !== 0) reject(new Error(`sandbox child exited ${code}: ${stderr.trim()}`));
      });
    });

    expect(result).toEqual({ fileRead: false, spawned: false });
  });
});
