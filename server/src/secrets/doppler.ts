import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { serviceHome } from '../homes.js';

const DOPPLER_DOWNLOAD_URL =
  'https://api.doppler.com/v3/configs/config/secrets/download?format=json';
const TOKEN_PATTERN = /dp\.(?:st|ct|pt|sa|said)\.[A-Za-z0-9._-]+/g;
const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,199}$/;
const REFRESH_MS = 60_000;
const DOPPLER_METADATA_KEY = 'doppler_connection';
const DOPPLER_AGENT_GUIDANCE_KEY = 'doppler_agent_guidance';

export interface DopplerTokens {
  runtimeToken?: string;
  agentToken?: string;
  connectedAt?: string;
}

export interface DopplerConnectionMetadata {
  project: string;
  config: string;
  connectedAt: string;
  runtimeConfigured: boolean;
  agentConfigured: boolean;
}

export interface DopplerRuntimeStatus {
  configured: boolean;
  healthy: boolean;
  project: string | null;
  config: string | null;
  lastCheckedAt: string | null;
  error: string | null;
}

export function readDopplerMetadata(db: Database.Database): DopplerConnectionMetadata | null {
  const row = db.prepare('SELECT value_json FROM settings WHERE key = ?').get(DOPPLER_METADATA_KEY) as
    | { value_json: string }
    | undefined;
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value_json) as Partial<DopplerConnectionMetadata>;
    if (
      typeof parsed.project !== 'string' ||
      typeof parsed.config !== 'string' ||
      typeof parsed.connectedAt !== 'string'
    ) {
      return null;
    }
    return {
      project: parsed.project,
      config: parsed.config,
      connectedAt: parsed.connectedAt,
      runtimeConfigured: parsed.runtimeConfigured === true,
      agentConfigured: parsed.agentConfigured === true,
    };
  } catch {
    return null;
  }
}

export function writeDopplerMetadata(db: Database.Database, metadata: DopplerConnectionMetadata): void {
  db.prepare(
    'INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json',
  ).run(DOPPLER_METADATA_KEY, JSON.stringify(metadata));
}

export function clearDopplerMetadata(db: Database.Database): void {
  db.prepare('DELETE FROM settings WHERE key = ?').run(DOPPLER_METADATA_KEY);
}

export function readDopplerAgentGuidance(db: Database.Database): string {
  const row = db.prepare('SELECT value_json FROM settings WHERE key = ?').get(DOPPLER_AGENT_GUIDANCE_KEY) as
    | { value_json: string }
    | undefined;
  if (!row) return '';
  try {
    const value = JSON.parse(row.value_json) as unknown;
    return typeof value === 'string' ? value : '';
  } catch {
    return '';
  }
}

export function writeDopplerAgentGuidance(db: Database.Database, guidance: string): string {
  const value = guidance.trim();
  if (!value) {
    db.prepare('DELETE FROM settings WHERE key = ?').run(DOPPLER_AGENT_GUIDANCE_KEY);
    return '';
  }
  db.prepare(
    'INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json',
  ).run(DOPPLER_AGENT_GUIDANCE_KEY, JSON.stringify(value));
  return value;
}

export interface DopplerTokenStore {
  get(): DopplerTokens;
  set(values: { runtimeToken?: string; agentToken?: string }, connectedAt?: string): void;
  clear(): void;
  file: string;
}

function readJson(file: string): DopplerTokens {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as DopplerTokens) : {};
  } catch {
    return {};
  }
}

function writeAtomic(file: string, data: DopplerTokens): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
}

export function createDopplerTokenStore(dataDir: string): DopplerTokenStore {
  const file = path.join(dataDir, 'doppler.json');
  return {
    file,
    get() {
      const raw = readJson(file);
      return {
        ...(typeof raw.runtimeToken === 'string' && raw.runtimeToken.trim()
          ? { runtimeToken: raw.runtimeToken.trim() }
          : {}),
        ...(typeof raw.agentToken === 'string' && raw.agentToken.trim()
          ? { agentToken: raw.agentToken.trim() }
          : {}),
        ...(typeof raw.connectedAt === 'string' ? { connectedAt: raw.connectedAt } : {}),
      };
    },
    set(values, connectedAt = new Date().toISOString()) {
      const current = readJson(file);
      writeAtomic(file, {
        ...(values.runtimeToken?.trim()
          ? { runtimeToken: values.runtimeToken.trim() }
          : current.runtimeToken
            ? { runtimeToken: current.runtimeToken }
            : {}),
        ...(values.agentToken?.trim()
          ? { agentToken: values.agentToken.trim() }
          : current.agentToken
            ? { agentToken: current.agentToken }
            : {}),
        connectedAt,
      });
    },
    clear() {
      try {
        fs.unlinkSync(file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    },
  };
}

export function redactDopplerError(value: unknown): string {
  const text = value instanceof Error ? value.message : String(value ?? 'Doppler request failed');
  return text.replace(TOKEN_PATTERN, '[redacted]').slice(0, 500);
}

function normalizedSecretMap(input: unknown): Map<string, string> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Doppler returned an invalid secrets response.');
  }
  const map = new Map<string, string>();
  for (const [name, value] of Object.entries(input)) {
    if (typeof value === 'string') map.set(name, value);
  }
  return map;
}

export async function downloadDopplerSecrets(
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Map<string, string>> {
  const response = await fetchImpl(DOPPLER_DOWNLOAD_URL, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(
      redactDopplerError(
        detail ? `Doppler returned ${response.status}: ${detail}` : `Doppler returned ${response.status}.`,
      ),
    );
  }
  return normalizedSecretMap(await response.json());
}

export function validateDopplerIdentity(
  secrets: Map<string, string>,
  expectedProject: string,
  expectedConfig: string,
): void {
  const project = secrets.get('DOPPLER_PROJECT');
  const config = secrets.get('DOPPLER_CONFIG');
  if (project !== expectedProject || config !== expectedConfig) {
    throw new Error(
      `This token belongs to ${project ?? 'an unknown project'}/${config ?? 'an unknown config'}, not ${expectedProject}/${expectedConfig}.`,
    );
  }
}

function dopplerCandidates(): string[] {
  return [
    process.env.VP_DOPPLER_BIN,
    path.join(serviceHome(), '.local', 'bin', 'doppler'),
    '/usr/local/bin/doppler',
    '/opt/homebrew/bin/doppler',
    'doppler',
  ].filter((candidate): candidate is string => Boolean(candidate));
}

export function findDopplerBin(): string {
  for (const candidate of dopplerCandidates()) {
    if (!candidate.includes(path.sep) || fs.existsSync(candidate)) return candidate;
  }
  return 'doppler';
}

interface CliResult {
  stdout: string;
  stderr: string;
}

async function runDopplerCli(
  token: string,
  args: string[],
  input?: string,
  configDir?: string,
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(findDopplerBin(), args, {
      env: {
        PATH: process.env.PATH,
        HOME: serviceHome(),
        DOPPLER_TOKEN: token,
        ...(configDir ? { DOPPLER_CONFIG_DIR: configDir } : {}),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < 16_384) stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 16_384) stderr += chunk.toString('utf8');
    });
    child.once('error', (error) => reject(new Error(redactDopplerError(error))));
    child.once('exit', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(redactDopplerError(stderr.trim() || stdout.trim() || `Doppler exited ${code}.`)));
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

export function assertDopplerSecretName(name: string): string {
  const normalized = name.trim().toUpperCase();
  if (!SECRET_NAME.test(normalized)) {
    throw new Error('Secret names must use SCREAMING_SNAKE_CASE.');
  }
  if (normalized.startsWith('DOPPLER_')) {
    throw new Error('DOPPLER_* names are reserved.');
  }
  return normalized;
}

export function dopplerSecretStdin(value: string): string {
  // The CLI receives a pipe, not an interactive terminal. EOF ends the value;
  // an interactive "." terminator would become part of the stored secret.
  return `${value}\n`;
}

export async function setDopplerSecret(token: string, name: string, value: string): Promise<void> {
  const safeName = assertDopplerSecretName(name);
  if (!value) throw new Error('A secret value is required.');
  // Piped stdin keeps the value out of argv, process listings, and shell history.
  await runDopplerCli(token, ['secrets', 'set', safeName, '--silent'], dopplerSecretStdin(value));
}

export async function deleteDopplerSecret(token: string, name: string): Promise<void> {
  const safeName = assertDopplerSecretName(name);
  await runDopplerCli(token, ['secrets', 'delete', safeName, '--yes', '--silent']);
}

export async function verifyDopplerWriteAccess(token: string): Promise<void> {
  const name = `VENEER_CONNECTION_TEST_${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
  let created = false;
  try {
    await setDopplerSecret(token, name, crypto.randomBytes(12).toString('hex'));
    created = true;
  } finally {
    if (created) await deleteDopplerSecret(token, name);
  }
}

export function dopplerCliConfigDir(): string {
  return path.join(serviceHome(), '.config', 'veneer-pro', 'doppler');
}

export async function configureDopplerCli(token: string): Promise<void> {
  const configDir = dopplerCliConfigDir();
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  // `doppler configure set token=…` puts the token in argv, where another
  // process can briefly see it. Write the CLI's dedicated scoped config
  // atomically instead. JSON string literals are valid YAML scalars.
  const file = path.join(configDir, '.doppler.yaml');
  const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const yaml = [
    'scoped:',
    `  ${JSON.stringify(serviceHome())}:`,
    `    token: ${JSON.stringify(token)}`,
    'version-check: {}',
    'tui:',
    '  introVersionSeen: 0',
    '',
  ].join('\n');
  fs.writeFileSync(tmp, yaml, { mode: 0o600, flag: 'wx' });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
}

export function clearDopplerCli(): void {
  const target = dopplerCliConfigDir();
  const expected = path.join(serviceHome(), '.config', 'veneer-pro', 'doppler');
  if (path.resolve(target) !== path.resolve(expected)) {
    throw new Error('Refusing to clear an unexpected Doppler directory.');
  }
  fs.rmSync(target, { recursive: true, force: true });
}

export class DopplerRuntime {
  private values = new Map<string, string>();
  private timer: NodeJS.Timeout | null = null;
  private state: DopplerRuntimeStatus = {
    configured: false,
    healthy: false,
    project: null,
    config: null,
    lastCheckedAt: null,
    error: null,
  };

  constructor(
    private readonly tokens: DopplerTokenStore,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  get(name: string): string | null {
    const value = this.values.get(name);
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  }

  status(): DopplerRuntimeStatus {
    return { ...this.state };
  }

  async refresh(): Promise<DopplerRuntimeStatus> {
    const token = this.tokens.get().runtimeToken;
    if (!token) {
      this.values = new Map();
      this.state = {
        configured: false,
        healthy: false,
        project: null,
        config: null,
        lastCheckedAt: new Date().toISOString(),
        error: null,
      };
      return this.status();
    }
    try {
      const values = await downloadDopplerSecrets(token, this.fetchImpl);
      this.values = values;
      this.state = {
        configured: true,
        healthy: true,
        project: values.get('DOPPLER_PROJECT') ?? null,
        config: values.get('DOPPLER_CONFIG') ?? null,
        lastCheckedAt: new Date().toISOString(),
        error: null,
      };
    } catch (error) {
      // Never replace a good in-memory snapshot with an empty one because of a
      // transient outage. No snapshot is persisted to disk.
      this.state = {
        ...this.state,
        configured: true,
        healthy: false,
        lastCheckedAt: new Date().toISOString(),
        error: redactDopplerError(error),
      };
    }
    return this.status();
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.refresh(), REFRESH_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
