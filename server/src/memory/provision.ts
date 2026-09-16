import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { currentPlatform, isMacOS, type Platform } from '../platform.js';

const INSTALL_URL = 'https://supermemory.ai/install';
const SUPERMEMORY_VERSION = '0.0.6';
const HEALTH_URL = 'http://127.0.0.1:6767/v4/memories/list';
const LAUNCHD_LABEL = 'com.veneer.supermemory';

type RunCommand = (command: string, args: string[], env?: NodeJS.ProcessEnv) => Promise<void>;

export interface SupermemoryProvisionOptions {
  dataDir: string;
  openRouterApiKey: string;
  homeDir?: string;
  platform?: Platform;
  fetchImpl?: typeof fetch;
  runCommand?: RunCommand;
  wait?: (milliseconds: number) => Promise<void>;
  /** Test seam: the GUI domain macOS launchd jobs are managed in. */
  uid?: number;
}

export interface SupermemoryProvisionResult {
  configured: boolean;
  reason?: string;
}

export interface SupermemoryProvisioner {
  ensure(): Promise<SupermemoryProvisionResult>;
  start(): void;
  stop(): void;
}

export interface SupermemoryProvisionerOptions {
  dataDir: string;
  getOpenRouterApiKey: () => string | null;
  intervalMs?: number;
  provision?: (options: SupermemoryProvisionOptions) => Promise<SupermemoryProvisionResult>;
  log?: Pick<Console, 'warn'>;
}

function runCommand(command: string, args: string[], env?: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: env ?? process.env,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 4_096) stderr += chunk.toString('utf8');
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `${command} exited ${code}.`));
    });
  });
}

function writePrivateFile(file: string, contents: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, contents, { mode: 0o600 });
  fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, file);
  fs.chmodSync(file, 0o600);
}

function supermemoryEnvironment(dataDir: string, openRouterApiKey: string): string {
  if (/[\r\n]/.test(openRouterApiKey)) {
    throw new Error('OPENROUTER_API_KEY contains an invalid line break.');
  }
  return [
    'SUPERMEMORY_PORT=6767',
    `SUPERMEMORY_DATA_DIR=${path.join(dataDir, 'supermemory')}`,
    'OPENAI_BASE_URL=https://openrouter.ai/api/v1',
    `OPENAI_API_KEY=${openRouterApiKey}`,
    'OPENAI_MODEL=deepseek/deepseek-v4-flash',
    'SUPERMEMORY_NO_OPEN=1',
    'SUPERMEMORY_NO_UPDATE_CHECK=1',
    'SUPERMEMORY_DISABLE_TELEMETRY=1',
    'WORKFLOW_ENGINE=direct',
    'SUPERMEMORY_LOCAL_EMBEDDING_POOL_SIZE=1',
    'SUPERMEMORY_INGEST_CONCURRENCY=2',
    'SUPERMEMORY_EMBEDDING_RAM_LIMIT=0.5gb',
    '',
  ].join('\n');
}

function environmentUsesProviderKey(file: string, openRouterApiKey: string): boolean {
  try {
    const line = fs.readFileSync(file, 'utf8').split('\n').find((value) => value.startsWith('OPENAI_API_KEY='));
    return line?.slice('OPENAI_API_KEY='.length) === openRouterApiKey;
  } catch {
    return false;
  }
}

async function supermemoryIsHealthy(
  apiKeyFile: string,
  fetchImpl: typeof fetch,
  containerTag: string,
): Promise<boolean> {
  let apiKey = '';
  try {
    apiKey = fs.readFileSync(apiKeyFile, 'utf8').trim();
  } catch {
    return false;
  }
  if (!apiKey) return false;
  const response = await fetchImpl(HEALTH_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ containerTags: [containerTag], limit: 1, page: 1 }),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  return response?.ok === true;
}

async function installSupermemory(
  binary: string,
  fetchImpl: typeof fetch,
  execute: RunCommand,
): Promise<void> {
  if (fs.existsSync(binary)) return;
  const response = await fetchImpl(INSTALL_URL, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`Supermemory installer returned ${response.status}.`);
  const installer = path.join(os.tmpdir(), `veneer-supermemory-${crypto.randomUUID()}.sh`);
  try {
    fs.writeFileSync(installer, await response.text(), { mode: 0o700 });
    await execute('/bin/bash', [installer, SUPERMEMORY_VERSION], {
      ...process.env,
      SUPERMEMORY_NO_START: '1',
      SUPERMEMORY_NO_PROMPT: '1',
    });
  } finally {
    fs.rmSync(installer, { force: true });
  }
}

/**
 * macOS has no per-user systemd. Veneer OS manages an already-installed
 * `com.veneer.supermemory` launchd job instead, and deliberately does not
 * install one: memory is an optional enhancement, so a missing job is reported
 * as an actionable reason rather than repaired behind the user's back.
 */
async function darwinServiceGap(
  binary: string,
  domainTarget: string,
  execute: RunCommand,
): Promise<string | null> {
  if (!fs.existsSync(binary)) {
    return `Supermemory is not installed at ${binary}. Install it from ${INSTALL_URL}, then reconnect.`;
  }
  try {
    await execute('/bin/launchctl', ['print', domainTarget]);
  } catch {
    return `The launchd job ${LAUNCHD_LABEL} is not installed for this user, so Supermemory cannot be started automatically. `
      + 'Memory stays optional until that job is installed.';
  }
  return null;
}

export async function ensureSupermemoryConfigured(
  options: SupermemoryProvisionOptions,
): Promise<SupermemoryProvisionResult> {
  const openRouterApiKey = options.openRouterApiKey.trim();
  const platform = options.platform ?? currentPlatform();
  const darwin = isMacOS(platform);
  if (!darwin && platform !== 'linux') {
    return { configured: false, reason: 'Automatic Supermemory setup is available on Linux and macOS only.' };
  }

  const homeDir = options.homeDir ?? os.homedir();
  const fetchImpl = options.fetchImpl ?? fetch;
  const execute = options.runCommand ?? runCommand;
  const wait = options.wait ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const binary = path.join(homeDir, '.supermemory', 'bin', 'supermemory-server');
  const environmentFile = path.join(homeDir, '.config', 'veneer-pro', 'supermemory.env');
  const apiKeyFile = path.join(options.dataDir, 'supermemory', 'api-key');

  if (
    fs.existsSync(binary)
    && environmentUsesProviderKey(environmentFile, openRouterApiKey)
    && await supermemoryIsHealthy(apiKeyFile, fetchImpl, 'veneer-reconciler-healthcheck')
  ) {
    return { configured: true };
  }
  if (!openRouterApiKey) return { configured: false, reason: 'OPENROUTER_API_KEY is not available.' };

  if (darwin) {
    const domainTarget = `gui/${options.uid ?? process.getuid?.() ?? 0}/${LAUNCHD_LABEL}`;
    const gap = await darwinServiceGap(binary, domainTarget, execute);
    if (gap) return { configured: false, reason: gap };
    writePrivateFile(environmentFile, supermemoryEnvironment(options.dataDir, openRouterApiKey));
    await execute('/bin/launchctl', ['kickstart', '-k', domainTarget]);
  } else {
    writePrivateFile(environmentFile, supermemoryEnvironment(options.dataDir, openRouterApiKey));
    await installSupermemory(binary, fetchImpl, execute);
    await execute('/usr/bin/systemctl', ['--user', 'daemon-reload']);
    await execute('/usr/bin/systemctl', ['--user', 'enable', 'veneer-supermemory.service']);
    await execute('/usr/bin/systemctl', ['--user', 'restart', 'veneer-supermemory.service']);
  }

  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (await supermemoryIsHealthy(apiKeyFile, fetchImpl, 'veneer-doppler-healthcheck')) {
      return { configured: true };
    }
    await wait(1_000);
  }

  throw new Error('Supermemory did not become healthy within 120 seconds.');
}

/**
 * Memory depends on a provider key that is commonly added after fleet
 * enrollment. Keep reconciling that dependency instead of treating the one
 * Doppler connection request as the only setup opportunity.
 */
export function createSupermemoryProvisioner(
  options: SupermemoryProvisionerOptions,
): SupermemoryProvisioner {
  const intervalMs = options.intervalMs ?? 60_000;
  const provision = options.provision ?? ensureSupermemoryConfigured;
  const log = options.log ?? console;
  let timer: NodeJS.Timeout | null = null;
  let inFlight: Promise<SupermemoryProvisionResult> | null = null;

  const ensure = (): Promise<SupermemoryProvisionResult> => {
    if (inFlight) return inFlight;
    inFlight = provision({
      dataDir: options.dataDir,
      openRouterApiKey: options.getOpenRouterApiKey() ?? '',
    }).finally(() => {
      inFlight = null;
    });
    return inFlight;
  };

  const reconcile = () => {
    void ensure().catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      log.warn(`[supermemory] automatic setup will retry: ${message}`);
    });
  };

  return {
    ensure,
    start() {
      if (timer) return;
      reconcile();
      timer = setInterval(reconcile, intervalMs);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
