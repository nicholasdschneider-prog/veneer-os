import { spawn, execFile } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { proCodexHome, proServiceEnv, serviceHome } from '../homes.js';
import { stripAnsi } from '../claude/setupToken.js';

/**
 * Productized `codex login --device-auth` — the Codex counterpart to the Claude
 * `setup-token` flow (see ../claude/setupToken.ts). Lets an operator connect a
 * Codex (ChatGPT) subscription from any device without SSHing into the box.
 *
 * Codex's device-auth is the mirror image of Claude's setup-token:
 *  - It prints a fixed verification URL (auth.openai.com/codex/device) and a
 *    short one-time CODE. The user opens the URL on ANY device and types the
 *    code there — nothing is pasted back into the app.
 *  - The CLI then polls OpenAI itself and, on success, writes
 *    `~/.codex/auth.json` and EXITS 0. The codex provider reads that file
 *    natively, so — unlike Claude — there is no token to capture, store, or
 *    inject; we just drive the login and watch the child's exit code.
 *  - It works over a plain pipe (no TTY/node-pty needed).
 *
 * We keep at most one attempt alive; the device code expires in ~15 min.
 *
 * HAZARD: `codex login --device-auth` DELETES the existing `~/.codex/auth.json`
 * the instant it starts (before the user authorizes). So starting then
 * cancelling logs the account out. `start()` refuses to replace a live login
 * unless `force` is set; the UI confirms first.
 */

const CODE_EXPIRY_MS = 15 * 60 * 1000; // "expires in 15 minutes" per the CLI.
const START_TIMEOUT_MS = 30_000;
const STATUS_TIMEOUT_MS = 10_000;

const VERIFY_URL_RE = /https:\/\/auth\.openai\.com\/codex\/device[^\s]*/;
/** Device codes look like NUUJ-ZH546 — dash-separated uppercase alnum groups. */
const USER_CODE_RE = /\b[A-Z0-9]{4}-[A-Z0-9]{4,6}\b/;
/** Markers the CLI prints when a device-auth attempt fails outright. */
const ERROR_RE = /error|failed|expired|timed out|denied/i;

export type CodexLoginMethod = 'chatgpt' | 'apikey' | null;
export type CodexAttemptState = 'pending' | 'success' | 'error' | 'expired' | 'no_attempt';

/** The signed-in ChatGPT identity, decoded from ~/.codex/auth.json for display. */
export interface CodexAccount {
  email: string | null;
  plan: string | null;
}

export interface CodexConnectStatus {
  connected: boolean;
  method: CodexLoginMethod;
  /** Whether the `codex` binary is on PATH at all (distinct from being logged out). */
  installed: boolean;
  detail: string;
  /** Signed-in account (ChatGPT logins only); null when unknown or API-key auth. */
  account?: CodexAccount | null;
}

export interface CodexInstallResult {
  ok: boolean;
  detail: string;
}

export interface CodexStartResult {
  attemptId: string;
  verificationUrl: string;
  userCode: string;
  expiresAt: string;
}

export interface CodexPollResult {
  state: CodexAttemptState;
  detail: string;
}

export interface CodexConnectManager {
  start(): Promise<CodexStartResult>;
  poll(attemptId: string): Promise<CodexPollResult>;
  cancel(attemptId: string): { cancelled: boolean };
  hasAttempt(): boolean;
  status(): Promise<CodexConnectStatus>;
  shutdown(): void;
}

export type CodexSpawner = (bin: string, args: string[]) => ChildProcess;
type StatusReader = (bin: string) => Promise<CodexConnectStatus>;

export interface CodexConnectManagerOptions {
  codexBin: string;
  spawnFn?: CodexSpawner;
  statusFn?: StatusReader;
  timeouts?: { startMs?: number; expiryMs?: number };
  log?: Pick<Console, 'warn' | 'error'>;
}

export class CodexAuthError extends Error {
  readonly status: number;
  constructor(
    message: string,
    readonly code: 'spawn_failed' | 'no_code',
  ) {
    super(message);
    this.name = 'CodexAuthError';
    this.status = code === 'spawn_failed' ? 502 : 400;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Best-effort read of the signed-in ChatGPT account from `~/.codex/auth.json`
 * (or `$CODEX_HOME/auth.json`). The Codex CLI stores an OpenAI OIDC `id_token`
 * — a JWT whose *payload* carries the account email and, under the
 * `https://api.openai.com/auth` claim, the ChatGPT plan type. We decode only
 * that unsigned payload for display; the token is never used as a credential
 * here. Returns null if the file is missing/unreadable or carries no id_token
 * (e.g. API-key logins), and never throws.
 */
export function readCodexAccount(
  readFileFn: (p: string) => string = (p) => fs.readFileSync(p, 'utf8'),
): CodexAccount | null {
  try {
    const home = process.env.CODEX_HOME || proCodexHome();
    const auth = JSON.parse(readFileFn(path.join(home, 'auth.json'))) as {
      tokens?: { id_token?: string };
    };
    const idToken = auth.tokens?.id_token;
    const payloadB64 = typeof idToken === 'string' ? idToken.split('.')[1] : undefined;
    if (!payloadB64) return null;
    const claims = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as {
      email?: string;
      'https://api.openai.com/auth'?: { chatgpt_plan_type?: string };
    };
    const email = typeof claims.email === 'string' ? claims.email : null;
    const planRaw = claims['https://api.openai.com/auth']?.chatgpt_plan_type;
    const plan = typeof planRaw === 'string' ? planRaw : null;
    return email || plan ? { email, plan } : null;
  } catch {
    return null;
  }
}

/** Read the current Codex login state from `codex login status`. */
export function codexLoginStatus(
  codexBin: string,
  execFileFn: typeof execFile = execFile,
  accountFn: () => CodexAccount | null = readCodexAccount,
): Promise<CodexConnectStatus> {
  return new Promise((resolve) => {
    execFileFn(codexBin, ['login', 'status'], { timeout: STATUS_TIMEOUT_MS, env: proServiceEnv(), cwd: serviceHome() }, (err, stdout, stderr) => {
      // ENOENT means the binary itself is missing, not just logged out — the
      // UI needs to tell these apart to offer an "Install" button instead of
      // "Connect".
      if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        resolve({ connected: false, method: null, installed: false, detail: 'Codex CLI is not installed.' });
        return;
      }
      const text = stripAnsi(`${stdout || ''}${stderr || ''}`).trim();
      // Check the NEGATIVE first: "Not logged in" contains "logged in".
      if (err || /not logged in|logged out|no .*(credential|auth)/i.test(text)) {
        resolve({ connected: false, method: null, installed: true, detail: text || 'Not logged in.' });
      } else if (/api key/i.test(text)) {
        resolve({ connected: true, method: 'apikey', installed: true, detail: text });
      } else if (/logged in/i.test(text)) {
        resolve({ connected: true, method: 'chatgpt', installed: true, detail: text, account: accountFn() });
      } else {
        resolve({ connected: false, method: null, installed: true, detail: text });
      }
    });
  });
}

const INSTALL_TIMEOUT_MS = 3 * 60 * 1000; // npm install can be slow on a cold cache.
const PROVIDER_RUNTIME_PROVISIONER = fileURLToPath(
  new URL('../../../installer/provider-runtimes.mjs', import.meta.url),
);

/**
 * Install the release-pinned Codex CLI via the shared provider provisioner.
 * Its user-owned prefix works on both Linux and macOS and leaves auth.json and
 * native session history outside the installation target.
 */
export function installCodex(spawnFn: CodexSpawner = defaultSpawner): Promise<CodexInstallResult> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawnFn(process.execPath, [
        PROVIDER_RUNTIME_PROVISIONER,
        '--provider', 'codex',
        '--service-home', serviceHome(),
        '--npm-bin', 'npm',
      ]);
    } catch (err) {
      resolve({ ok: false, detail: `Could not start the install: ${(err as Error).message}` });
      return;
    }
    let buffer = '';
    const onData = (chunk: Buffer): void => {
      buffer = stripAnsi(buffer + chunk.toString('utf8')).slice(-8000);
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      resolve({ ok: false, detail: 'The install timed out.' });
    }, INSTALL_TIMEOUT_MS);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, detail: `Could not start the install: ${err.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ ok: true, detail: 'Codex CLI installed.' });
      } else {
        const line = buffer.split('\n').map((l) => l.trim()).filter(Boolean).pop();
        resolve({ ok: false, detail: (line || 'Codex CLI installation failed.').slice(0, 300) });
      }
    });
  });
}

/** Remove stored Codex credentials (`codex logout`). */
export function codexLogout(
  codexBin: string,
  execFileFn: typeof execFile = execFile,
): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    execFileFn(codexBin, ['logout'], { timeout: STATUS_TIMEOUT_MS, env: proServiceEnv(), cwd: serviceHome() }, (err, stdout, stderr) => {
      if (err) {
        const detail = stripAnsi(`${stderr || ''}${stdout || ''}`).trim();
        resolve({ ok: false, detail: detail || err.message });
      } else {
        resolve({ ok: true, detail: 'Logged out of Codex.' });
      }
    });
  });
}

// Signing Pro in and out is Pro's own business: run it in the service home with
// CODEX_HOME pinned, so a login always lands in Pro's profile and never in the
// login user's own ~/.codex.
const defaultSpawner: CodexSpawner = (bin, args) =>
  spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], cwd: serviceHome(), env: proServiceEnv() });

interface Attempt {
  attemptId: string;
  child: ChildProcess;
  buffer: string;
  state: CodexAttemptState;
  detail: string;
  verificationUrl: string;
  userCode: string;
  expiresAt: number;
  expiryTimer: NodeJS.Timeout;
}

export function createCodexConnectManager(opts: CodexConnectManagerOptions): CodexConnectManager {
  const spawnFn = opts.spawnFn ?? defaultSpawner;
  const statusFn = opts.statusFn ?? ((bin: string) => codexLoginStatus(bin));
  const log = opts.log ?? console;
  const startTimeout = opts.timeouts?.startMs ?? START_TIMEOUT_MS;
  const expiry = opts.timeouts?.expiryMs ?? CODE_EXPIRY_MS;
  let current: Attempt | null = null;

  function teardown(attempt: Attempt): void {
    clearTimeout(attempt.expiryTimer);
    try {
      attempt.child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
    if (current === attempt) current = null;
  }

  return {
    hasAttempt: () => current !== null,

    async start() {
      if (current) teardown(current);

      const attemptId = crypto.randomUUID();
      let child: ChildProcess;
      try {
        child = spawnFn(opts.codexBin, ['login', '--device-auth']);
      } catch (err) {
        throw new CodexAuthError(`Could not start the Codex sign-in: ${(err as Error).message}`, 'spawn_failed');
      }

      const now = Date.now();
      const attempt: Attempt = {
        attemptId,
        child,
        buffer: '',
        state: 'pending',
        detail: '',
        verificationUrl: '',
        userCode: '',
        expiresAt: now + expiry,
        expiryTimer: setTimeout(() => {
          if (current === attempt && attempt.state === 'pending') {
            log.warn('[codex-connect] attempt expired, killing child');
            attempt.state = 'expired';
            attempt.detail = 'The device code expired. Start over to get a fresh one.';
            teardown(attempt);
          }
        }, expiry),
      };
      const onData = (chunk: Buffer): void => {
        attempt.buffer = stripAnsi(attempt.buffer + chunk.toString('utf8')).slice(-8000);
      };
      child.stdout?.on('data', onData);
      child.stderr?.on('data', onData);
      child.on('error', (err) => {
        if (attempt.state === 'pending') {
          attempt.state = 'error';
          attempt.detail = err.message;
        }
      });
      child.on('close', (code) => {
        if (attempt.state !== 'pending') return; // already expired/cancelled
        if (code === 0) {
          attempt.state = 'success';
          attempt.detail = 'Signed in to Codex.';
        } else {
          attempt.state = 'error';
          const line = attempt.buffer.split('\n').map((l) => l.trim()).filter(Boolean).pop();
          attempt.detail = (line && ERROR_RE.test(line) ? line : 'Codex sign-in did not complete.').slice(0, 200);
        }
        clearTimeout(attempt.expiryTimer);
      });
      current = attempt;

      // Wait for the URL + code to show up in the child's output.
      const deadline = Date.now() + startTimeout;
      for (;;) {
        const url = attempt.buffer.match(VERIFY_URL_RE)?.[0];
        const codeMatch = attempt.buffer.match(USER_CODE_RE)?.[0];
        if (url && codeMatch) {
          attempt.verificationUrl = url;
          attempt.userCode = codeMatch;
          return {
            attemptId,
            verificationUrl: url,
            userCode: codeMatch,
            expiresAt: new Date(attempt.expiresAt).toISOString(),
          };
        }
        if (attempt.state === 'error' || child.exitCode !== null) {
          teardown(attempt);
          throw new CodexAuthError('Codex did not return a sign-in code. Please try again.', 'no_code');
        }
        if (Date.now() >= deadline) {
          teardown(attempt);
          throw new CodexAuthError('Codex did not return a sign-in code in time. Please try again.', 'no_code');
        }
        await delay(120);
      }
    },

    async poll(attemptId) {
      const attempt = current;
      if (!attempt || attempt.attemptId !== attemptId) {
        // A finished attempt is torn down; fall back to the real login state so
        // a slightly-late poll after success still reports connected.
        const st = await statusFn(opts.codexBin);
        return st.connected
          ? { state: 'success', detail: 'Signed in to Codex.' }
          : { state: 'no_attempt', detail: 'This sign-in attempt is no longer active.' };
      }
      if (attempt.state === 'success') teardown(attempt);
      return { state: attempt.state, detail: attempt.detail };
    },

    cancel(attemptId) {
      if (current && current.attemptId === attemptId) {
        teardown(current);
        return { cancelled: true };
      }
      return { cancelled: false };
    },

    status() {
      return statusFn(opts.codexBin);
    },

    shutdown() {
      if (current) teardown(current);
    },
  };
}
