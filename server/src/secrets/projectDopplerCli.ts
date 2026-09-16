import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findDopplerBin } from './doppler.js';

const TOKEN_PATTERN = /dp\.(?:st|ct|pt|sa|said)\.[A-Za-z0-9._-]+/g;
const MAX_OUTPUT = 64 * 1024;

export type DopplerAccessMode = 'main_full' | 'none';

export const MAIN_DOPPLER_AGENT_GUIDANCE =
  'Every Veneer agent has full Doppler access through this machine’s authenticated user profile. Use `mcp__doppler__run_cli` for Doppler CLI operations; in a terminal, run `doppler` normally. Both can use every Doppler project that this profile can access.';

export const DOPPLER_SECRET_SAFETY_GUIDANCE =
  'Never print or log a secret value. Read a secret only at use time, and pass it directly to the command that needs it. ' +
  'To obtain a new secret from the user, call request_secret; it shows them a secure input and saves straight to Doppler. ' +
  'To show the user an existing secret, call reveal_secret; it displays the value on their screen only and you never receive it. ' +
  'Never ask them to paste a secret in chat.';

export const DOPPLER_NOT_CONNECTED_GUIDANCE =
  'Doppler is not connected on this machine, so Veneer secrets tooling is unavailable: request_secret, reveal_secret, fill_secret and fill_totp are not offered, and there is no authenticated Doppler CLI to read or write secrets. '
  + 'Do not promise to store a credential in Doppler. Ask the user to connect Doppler in Settings first, and never ask them to paste a secret into chat.';

/**
 * Veneer OS is a single standalone install owned by one operator, so when
 * Doppler is connected, access is the full workplace profile of the interactive
 * macOS user. With no authenticated Doppler CLI there is no access at all, and
 * Settings and the agent both need to say so rather than advertise a vault that
 * would fail at save time.
 */
export function dopplerAccessPolicy(connected: boolean): {
  mode: DopplerAccessMode;
  label: string;
  locked: true;
  safetyGuidance: string;
} {
  if (!connected) {
    return {
      mode: 'none',
      label: 'Doppler not connected',
      locked: true,
      safetyGuidance: DOPPLER_NOT_CONNECTED_GUIDANCE,
    };
  }
  return {
    mode: 'main_full',
    label: 'Full workplace access',
    locked: true,
    safetyGuidance: [MAIN_DOPPLER_AGENT_GUIDANCE, DOPPLER_SECRET_SAFETY_GUIDANCE].join(' '),
  };
}

export interface ProjectDopplerCli {
  binDir: string;
  configDir: string;
  userHome: string;
}

interface EnableProjectDopplerCliOptions {
  userHome?: string;
  configDir?: string;
  dopplerBin?: string;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function resolveExecutable(candidate: string, pathValue: string): string | null {
  const paths = candidate.includes(path.sep)
    ? [candidate]
    : pathValue.split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, candidate));
  for (const file of paths) {
    try {
      fs.accessSync(file, fs.constants.X_OK);
      return fs.realpathSync(file);
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

/**
 * Give agent child processes the interactive macOS user's authenticated Doppler
 * CLI without copying its token.
 */
export function enableProjectDopplerCli(
  dataDir: string,
  env: NodeJS.ProcessEnv = process.env,
  options: EnableProjectDopplerCliOptions = {},
): ProjectDopplerCli | null {
  const userHome = options.userHome ?? os.userInfo().homedir;
  const configDir = options.configDir ?? path.join(userHome, '.doppler');
  if (!fs.existsSync(path.join(configDir, '.doppler.yaml'))) return null;

  const dopplerBin = resolveExecutable(options.dopplerBin ?? findDopplerBin(), env.PATH ?? '');
  if (!dopplerBin) return null;

  const binDir = path.join(dataDir, 'project-cli');
  const wrapper = path.join(binDir, 'doppler');
  if (path.resolve(dopplerBin) === path.resolve(wrapper)) return null;

  fs.mkdirSync(binDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(binDir, 0o700);
  const script = [
    '#!/bin/sh',
    `HOME=${shellQuote(userHome)}`,
    'export HOME',
    `DOPPLER_CONFIG_DIR=${shellQuote(configDir)}`,
    'export DOPPLER_CONFIG_DIR',
    `exec ${shellQuote(dopplerBin)} "$@"`,
    '',
  ].join('\n');
  if (!fs.existsSync(wrapper) || fs.readFileSync(wrapper, 'utf8') !== script) {
    const tmp = `${wrapper}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, script, { mode: 0o700, flag: 'wx' });
    fs.chmodSync(tmp, 0o700);
    fs.renameSync(tmp, wrapper);
  }
  fs.chmodSync(wrapper, 0o700);

  const entries = (env.PATH ?? '').split(path.delimiter).filter(Boolean);
  env.PATH = [binDir, ...entries.filter((entry) => path.resolve(entry) !== path.resolve(binDir))]
    .join(path.delimiter);
  return { binDir, configDir, userHome };
}

export function projectDopplerGuidance(cli: ProjectDopplerCli | null): string | null {
  return cli
    ? `${MAIN_DOPPLER_AGENT_GUIDANCE} ${DOPPLER_SECRET_SAFETY_GUIDANCE}`
    : null;
}

function safeCliEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'TMPDIR', 'USER', 'LOGNAME', 'SHELL']) {
    if (source[name]) env[name] = source[name];
  }
  return env;
}

export async function runProjectDopplerCli(
  bin: string,
  args: string[],
  cwd: string,
  sourceEnv: NodeJS.ProcessEnv = process.env,
  /** Piped to stdin (secret values stay out of argv and process listings). */
  input?: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  if (args.length === 0) throw new Error('At least one Doppler CLI argument is required.');
  if (args.length > 100 || args.some((arg) => arg.includes('\0') || arg.length > 8_192)) {
    throw new Error('The Doppler CLI arguments are invalid.');
  }
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd,
      env: safeCliEnvironment(sourceEnv),
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    if (input !== undefined) {
      child.stdin?.on('error', () => {}); // a bin that exits early would raise EPIPE
      child.stdin?.end(input);
    }
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < MAX_OUTPUT) stdout += chunk.toString('utf8').slice(0, MAX_OUTPUT - stdout.length);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_OUTPUT) stderr += chunk.toString('utf8').slice(0, MAX_OUTPUT - stderr.length);
    });
    child.once('error', (error) => reject(error));
    child.once('close', (code) => {
      resolve({
        stdout: stdout.replace(TOKEN_PATTERN, '[redacted Doppler token]'),
        stderr: stderr.replace(TOKEN_PATTERN, '[redacted Doppler token]'),
        code: code ?? 1,
      });
    });
  });
}
