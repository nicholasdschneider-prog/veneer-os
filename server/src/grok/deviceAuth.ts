import { spawn, execFile } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { proGrokHome, proServiceEnv, serviceHome } from '../homes.js';
import { stripAnsi } from '../claude/setupToken.js';

/**
 * Productized `grok login --device-auth` — the xAI counterpart to the Codex
 * device flow (see ../codex/deviceAuth.ts). Lets an operator connect an xAI
 * (Grok) subscription from any device without SSHing into the box.
 *
 * Shape of the CLI's device auth (probed against grok 1.0.3 alpha):
 *
 *     To sign in, open this URL in your browser:
 *
 *       https://accounts.x.ai/oauth2/device?user_code=TKFH-86AH
 *
 *     Confirm this code in your browser:
 *
 *       TKFH-86AH
 *
 *     Waiting for authorization...
 *
 * The user opens the URL on ANY device and confirms the code there; nothing is
 * pasted back into the app. The CLI polls xAI itself and, on success, writes
 * `$GROK_HOME/auth.json` and EXITS 0 — so, as with Codex, there is no token to
 * capture, store, or inject. We drive the login and watch the exit code.
 *
 * DIFFERENCE FROM CODEX: `codex login --device-auth` deletes the existing
 * auth.json the instant it starts, so starting-then-cancelling logs you out —
 * hence Codex's loud "replace sign-in" hazard warning. Grok does NOT: a probe
 * with a sentinel auth.json showed the file survives an aborted login intact.
 * Starting a Grok sign-in is therefore non-destructive and the UI only needs a
 * plain re-auth confirmation. The `force` flag on start() is kept purely for
 * route-shape parity with Codex (409 already_connected unless force).
 *
 * NOTE ON XAI_API_KEY: the service environment carries XAI_API_KEY, and the
 * Grok CLI silently prefers it over the subscription login ("You are using
 * XAI_API_KEY."). Every child we spawn here has it deleted and GROK_HOME
 * pinned, so connect/status/logout always act on Pro's own subscription
 * profile.
 */

const CODE_EXPIRY_MS = 15 * 60 * 1000;
const START_TIMEOUT_MS = 30_000;
const STATUS_TIMEOUT_MS = 10_000;

/** The device page the CLI prints, e.g. https://accounts.x.ai/oauth2/device?user_code=TKFH-86AH */
const VERIFY_URL_RE = /https:\/\/accounts\.x\.ai\/oauth2\/device[^\s]*/;
/** Preferred code source: the `user_code` query param on the verification URL. */
const URL_CODE_RE = /[?&]user_code=([A-Za-z0-9]{4}-[A-Za-z0-9]{4})\b/;
/** Fallback: the code echoed on its own line — four alnum, dash, four alnum. */
const USER_CODE_RE = /\b[A-Za-z0-9]{4}-[A-Za-z0-9]{4}\b/;
/** Markers the CLI prints when a device-auth attempt fails outright. */
const ERROR_RE = /error|failed|expired|timed out|denied/i;

/** 'xai' = subscription login via auth.json; 'apikey' = XAI_API_KEY (never used by us). */
export type GrokLoginMethod = 'xai' | 'apikey' | null;
export type GrokAttemptState = 'pending' | 'success' | 'error' | 'expired' | 'no_attempt';

/** The signed-in xAI identity, decoded from auth.json for display. */
export interface GrokAccount {
  email: string | null;
  handle: string | null;
  plan: string | null;
}

export interface GrokConnectStatus {
  connected: boolean;
  method: GrokLoginMethod;
  /** Whether the `grok` binary runs at all (distinct from being logged out). */
  installed: boolean;
  detail: string;
  /** Signed-in account; null when the auth file carries no readable identity. */
  account?: GrokAccount | null;
}

export interface GrokInstallResult {
  ok: boolean;
  detail: string;
}

export interface GrokStartResult {
  attemptId: string;
  verificationUrl: string;
  userCode: string;
  expiresAt: string;
}

export interface GrokPollResult {
  state: GrokAttemptState;
  detail: string;
}

export interface GrokConnectManager {
  start(): Promise<GrokStartResult>;
  poll(attemptId: string): Promise<GrokPollResult>;
  cancel(attemptId: string): { cancelled: boolean };
  hasAttempt(): boolean;
  status(): Promise<GrokConnectStatus>;
  shutdown(): void;
}

export type GrokSpawner = (bin: string, args: string[]) => ChildProcess;
type StatusReader = (bin: string) => Promise<GrokConnectStatus>;

export interface GrokConnectManagerOptions {
  grokBin: string;
  spawnFn?: GrokSpawner;
  statusFn?: StatusReader;
  timeouts?: { startMs?: number; expiryMs?: number };
  log?: Pick<Console, 'warn' | 'error'>;
}

export class GrokAuthError extends Error {
  readonly status: number;
  constructor(
    message: string,
    readonly code: 'spawn_failed' | 'no_code',
  ) {
    super(message);
    this.name = 'GrokAuthError';
    this.status = code === 'spawn_failed' ? 502 : 400;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * The environment every Grok child gets: Pro's service environment with
 * XAI_API_KEY stripped (it hijacks subscription auth silently) and GROK_HOME
 * pinned to Pro's own profile, so a login can never land in the login user's
 * ~/.grok. An explicitly-set GROK_HOME in the parent environment still wins,
 * matching the homes.ts convention.
 */
export function grokChildEnv(base: NodeJS.ProcessEnv = proServiceEnv()): NodeJS.ProcessEnv {
  const env = { ...base };
  delete env.XAI_API_KEY;
  if (!env.GROK_HOME?.trim()) env.GROK_HOME = proGrokHome();
  env.GROK_DISABLE_AUTOUPDATER = '1';
  return env;
}

const execOpts = (): { timeout: number; cwd: string; env: NodeJS.ProcessEnv } => ({
  timeout: STATUS_TIMEOUT_MS,
  cwd: serviceHome(),
  env: grokChildEnv(),
});

/** A JWT-looking string: three base64url segments. */
const JWT_RE = /^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*$/;

function firstString(source: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

/** Depth-limited hunt for the first JWT-shaped string anywhere in the auth file. */
function findJwt(value: unknown, depth = 0): string | null {
  if (depth > 4) return null;
  if (typeof value === 'string') return JWT_RE.test(value) ? value : null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = findJwt(item, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) {
      const hit = findJwt(item, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

function decodeJwtClaims(token: string): Record<string, unknown> | null {
  try {
    const payload = token.split('.')[1];
    if (!payload) return null;
    const claims: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return claims && typeof claims === 'object' ? (claims as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Best-effort identity from a parsed auth.json. The Grok CLI's file shape is
 * not documented and differs from Codex's, so this reads both the obvious
 * top-level fields AND the unsigned payload of whatever JWT-ish token it can
 * find (display only — the token is never used as a credential here).
 */
function accountFromAuth(auth: Record<string, unknown>): GrokAccount | null {
  const claims = (() => {
    const jwt = findJwt(auth);
    return jwt ? decodeJwtClaims(jwt) : null;
  })();
  const sources = [auth, (auth.user as Record<string, unknown>) ?? {}, claims ?? {}].filter(
    (s): s is Record<string, unknown> => !!s && typeof s === 'object',
  );
  let email: string | null = null;
  let handle: string | null = null;
  let plan: string | null = null;
  for (const source of sources) {
    email ??= firstString(source, ['email', 'user_email', 'emailAddress']);
    handle ??= firstString(source, ['handle', 'screen_name', 'username', 'preferred_username', 'name']);
    plan ??= firstString(source, ['plan', 'plan_type', 'subscription', 'subscription_tier', 'tier']);
  }
  // A bare `sub` that looks like an address is the only sub we'd show.
  if (!email) {
    for (const source of sources) {
      const sub = firstString(source, ['sub']);
      if (sub && sub.includes('@')) {
        email = sub;
        break;
      }
    }
  }
  return email || handle || plan ? { email, handle, plan } : null;
}

export interface GrokAuthProbe {
  connected: boolean;
  account: GrokAccount | null;
}

/**
 * Read the Grok auth state straight off disk. There is no `grok login status`
 * subcommand, so presence of a non-trivial `$GROK_HOME/auth.json` IS the
 * connected signal. Unparseable-but-substantial content still counts as
 * connected (with no account) rather than silently reporting logged out.
 * Never throws.
 */
export function readGrokAuth(
  readFileFn: (p: string) => string = (p) => fs.readFileSync(p, 'utf8'),
): GrokAuthProbe {
  const home = process.env.GROK_HOME || proGrokHome();
  let raw: string;
  try {
    raw = readFileFn(path.join(home, 'auth.json'));
  } catch {
    return { connected: false, account: null };
  }
  const text = (raw || '').trim();
  // '', '{}', 'null', '[]' — a file the CLI left behind with nothing in it.
  if (text.length < 3) return { connected: false, account: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { connected: true, account: null };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { connected: false, account: null };
  }
  const meaningful = Object.values(parsed as Record<string, unknown>).some(
    (v) => v !== null && v !== undefined && v !== '' && !(typeof v === 'object' && Object.keys(v as object).length === 0),
  );
  if (!meaningful) return { connected: false, account: null };
  return { connected: true, account: accountFromAuth(parsed as Record<string, unknown>) };
}

/** Just the display identity (Codex parity helper). */
export function readGrokAccount(
  readFileFn: (p: string) => string = (p) => fs.readFileSync(p, 'utf8'),
): GrokAccount | null {
  return readGrokAuth(readFileFn).account;
}

/**
 * Current Grok login state. Two independent signals:
 *  - installed: `grok --version` runs at all (ENOENT ⇒ no binary, so the UI
 *    offers "Install" instead of "Connect"). There is no `login status`
 *    subcommand to lean on.
 *  - connected: a non-trivial auth.json in Pro's GROK_HOME.
 */
export function grokLoginStatus(
  grokBin: string,
  execFileFn: typeof execFile = execFile,
  authFn: () => GrokAuthProbe = readGrokAuth,
): Promise<GrokConnectStatus> {
  return new Promise((resolve) => {
    execFileFn(grokBin, ['--version'], execOpts(), (err, stdout, stderr) => {
      if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        resolve({ connected: false, method: null, installed: false, detail: 'Grok CLI is not installed.' });
        return;
      }
      const version = stripAnsi(`${stdout || ''}${stderr || ''}`).trim().split('\n')[0]?.trim() || '';
      const probe = authFn();
      if (!probe.connected) {
        resolve({
          connected: false,
          method: null,
          installed: true,
          detail: version ? `Not signed in (${version}).` : 'Not signed in.',
        });
        return;
      }
      const who = probe.account?.handle
        ? `@${probe.account.handle.replace(/^@/, '')}`
        : probe.account?.email || null;
      resolve({
        connected: true,
        method: 'xai',
        installed: true,
        detail: who ? `Signed in as ${who}.` : 'Signed in to Grok.',
        account: probe.account,
      });
    });
  });
}

const INSTALL_TIMEOUT_MS = 3 * 60 * 1000;
const PROVIDER_RUNTIME_PROVISIONER = fileURLToPath(
  new URL('../../../installer/provider-runtimes.mjs', import.meta.url),
);

/**
 * Install the release-pinned Grok CLI through xAI's official installer. The
 * shared provisioner pins its artifact, keeps the binary in Pro's user-owned
 * prefix, and leaves the Grok auth/profile directory in place.
 */
export function installGrok(spawnFn: GrokSpawner = defaultSpawner): Promise<GrokInstallResult> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawnFn(process.execPath, [
        PROVIDER_RUNTIME_PROVISIONER,
        '--provider', 'grok',
        '--service-home', serviceHome(),
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
        resolve({ ok: true, detail: 'Grok CLI installed.' });
      } else {
        const line = buffer.split('\n').map((l) => l.trim()).filter(Boolean).pop();
        resolve({ ok: false, detail: (line || 'The Grok installer failed.').slice(0, 300) });
      }
    });
  });
}

/** Remove stored Grok credentials (`grok logout`). */
export function grokLogout(
  grokBin: string,
  execFileFn: typeof execFile = execFile,
): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    execFileFn(grokBin, ['logout'], execOpts(), (err, stdout, stderr) => {
      if (err) {
        const detail = stripAnsi(`${stderr || ''}${stdout || ''}`).trim();
        resolve({ ok: false, detail: detail || err.message });
      } else {
        resolve({ ok: true, detail: 'Logged out of Grok.' });
      }
    });
  });
}

// Signing Pro in and out is Pro's own business: run it in the service home with
// GROK_HOME pinned and XAI_API_KEY stripped (see grokChildEnv).
const defaultSpawner: GrokSpawner = (bin, args) =>
  spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], cwd: serviceHome(), env: grokChildEnv() });

interface Attempt {
  attemptId: string;
  child: ChildProcess;
  buffer: string;
  state: GrokAttemptState;
  detail: string;
  verificationUrl: string;
  userCode: string;
  expiresAt: number;
  expiryTimer: NodeJS.Timeout;
}

/** Pull the one-time code out of scraped output — URL query first, then the echoed line. */
export function scrapeUserCode(text: string): string | null {
  return text.match(URL_CODE_RE)?.[1] ?? text.match(USER_CODE_RE)?.[0] ?? null;
}

export function createGrokConnectManager(opts: GrokConnectManagerOptions): GrokConnectManager {
  const spawnFn = opts.spawnFn ?? defaultSpawner;
  const statusFn = opts.statusFn ?? ((bin: string) => grokLoginStatus(bin));
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
        child = spawnFn(opts.grokBin, ['login', '--device-auth']);
      } catch (err) {
        throw new GrokAuthError(`Could not start the Grok sign-in: ${(err as Error).message}`, 'spawn_failed');
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
            log.warn('[grok-connect] attempt expired, killing child');
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
          attempt.detail = 'Signed in to Grok.';
        } else {
          attempt.state = 'error';
          const line = attempt.buffer.split('\n').map((l) => l.trim()).filter(Boolean).pop();
          attempt.detail = (line && ERROR_RE.test(line) ? line : 'Grok sign-in did not complete.').slice(0, 200);
        }
        clearTimeout(attempt.expiryTimer);
      });
      current = attempt;

      // Wait for the URL + code to show up in the child's output.
      const deadline = Date.now() + startTimeout;
      for (;;) {
        const url = attempt.buffer.match(VERIFY_URL_RE)?.[0];
        const codeMatch = scrapeUserCode(attempt.buffer);
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
          throw new GrokAuthError('Grok did not return a sign-in code. Please try again.', 'no_code');
        }
        if (Date.now() >= deadline) {
          teardown(attempt);
          throw new GrokAuthError('Grok did not return a sign-in code in time. Please try again.', 'no_code');
        }
        await delay(120);
      }
    },

    async poll(attemptId) {
      const attempt = current;
      if (!attempt || attempt.attemptId !== attemptId) {
        // A finished attempt is torn down; fall back to the real login state so
        // a slightly-late poll after success still reports connected.
        const st = await statusFn(opts.grokBin);
        return st.connected
          ? { state: 'success', detail: 'Signed in to Grok.' }
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
      return statusFn(opts.grokBin);
    },

    shutdown() {
      if (current) teardown(current);
    },
  };
}
