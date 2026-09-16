import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  dopplerAccessPolicy,
  enableProjectDopplerCli,
  projectDopplerGuidance,
  runProjectDopplerCli,
} from '../src/secrets/projectDopplerCli.js';

describe('project Doppler CLI', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reports a locked full-workplace mode when Doppler is connected', () => {
    const policy = dopplerAccessPolicy(true);
    expect(policy).toMatchObject({
      mode: 'main_full',
      label: 'Full workplace access',
      locked: true,
    });
    expect(policy.safetyGuidance).toContain('request_secret');
  });

  it('reports a not-connected mode when there is no authenticated Doppler CLI', () => {
    const policy = dopplerAccessPolicy(false);
    expect(policy).toMatchObject({
      mode: 'none',
      label: 'Doppler not connected',
      locked: true,
    });
    // The agent must not be told it has a vault it cannot write to.
    expect(policy.safetyGuidance).toContain('Doppler is not connected');
    expect(policy.safetyGuidance).not.toContain('full Doppler access');
  });

  it('uses the authenticated user home without copying a token', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-project-doppler-'));
    dirs.push(dir);
    const userHome = path.join(dir, 'user-home');
    const configDir = path.join(userHome, '.doppler');
    const dataDir = path.join(dir, 'data');
    const fakeBin = path.join(dir, 'doppler-real');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, '.doppler.yaml'), 'token: never-copy-this\n', { mode: 0o600 });
    fs.writeFileSync(
      fakeBin,
      '#!/bin/sh\nprintf "%s\\n%s\\n%s\\n" "$HOME" "$DOPPLER_CONFIG_DIR" "$*"\n',
      { mode: 0o700 },
    );

    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin' };
    const cli = enableProjectDopplerCli(dataDir, env, {
      publicOrigin: 'https://veneer.example',
      userHome,
      configDir,
      dopplerBin: fakeBin,
    });
    expect(cli).not.toBeNull();
    const wrapper = path.join(dataDir, 'project-cli', 'doppler');
    const script = fs.readFileSync(wrapper, 'utf8');
    expect(script).not.toContain('never-copy-this');
    expect(fs.statSync(wrapper).mode & 0o777).toBe(0o700);
    expect(env.PATH?.split(path.delimiter)[0]).toBe(path.dirname(wrapper));

    const result = spawnSync('doppler', ['projects', '--json'], { env, encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout.trim().split('\n')).toEqual([userHome, configDir, 'projects --json']);
    expect(projectDopplerGuidance(cli)).toContain('mcp__doppler__run_cli');
  });

  it('stays disabled when the user profile is not configured', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-project-doppler-'));
    dirs.push(dir);
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin' };
    expect(enableProjectDopplerCli(path.join(dir, 'data'), env, {
      publicOrigin: 'https://veneer.example',
      userHome: path.join(dir, 'user-home'),
      dopplerBin: '/usr/bin/false',
    })).toBeNull();
    expect(env.PATH).toBe('/usr/bin');
    expect(projectDopplerGuidance(null)).toBeNull();
  });

  it('pipes an input value to the CLI on stdin instead of argv', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-project-doppler-'));
    dirs.push(dir);
    const fakeBin = path.join(dir, 'doppler-real');
    fs.writeFileSync(fakeBin, '#!/bin/sh\nprintf "args:%s\\n" "$*"\ncat\n', { mode: 0o700 });

    const piped = await runProjectDopplerCli(
      fakeBin,
      ['secrets', 'set', 'STRIPE_API_KEY', '--silent'],
      dir,
      { PATH: '/bin:/usr/bin' },
      'sk_live_value\n',
    );
    expect(piped).toEqual({
      stdout: 'args:secrets set STRIPE_API_KEY --silent\nsk_live_value\n',
      stderr: '',
      code: 0,
    });

    // Without an input the child still gets no stdin at all.
    const bare = await runProjectDopplerCli(fakeBin, ['secrets'], dir, { PATH: '/bin:/usr/bin' });
    expect(bare).toEqual({ stdout: 'args:secrets\n', stderr: '', code: 0 });
  });

  it('runs without inherited credentials and redacts Doppler tokens', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-project-doppler-'));
    dirs.push(dir);
    const fakeBin = path.join(dir, 'doppler-real');
    fs.writeFileSync(
      fakeBin,
      [
        '#!/bin/sh',
        'if [ -n "$OPENROUTER_API_KEY" ]; then exit 9; fi',
        'printf "dp.ct.secret-token-value\\n%s\\n" "$*"',
        '',
      ].join('\n'),
      { mode: 0o700 },
    );
    const result = await runProjectDopplerCli(
      fakeBin,
      ['projects', '--json'],
      dir,
      { PATH: '/usr/bin', OPENROUTER_API_KEY: 'must-not-pass' },
    );
    expect(result).toEqual({
      stdout: '[redacted Doppler token]\nprojects --json\n',
      stderr: '',
      code: 0,
    });
  });
});
