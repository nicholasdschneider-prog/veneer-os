import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { proServiceEnv, serviceHome } from '../homes.js';
import type { ClaudeAccountSummary, SecretStore } from '../secrets/store.js';

const require = createRequire(import.meta.url);

/**
 * Productized `claude setup-token` OAuth flow (see docs/protocol-notes.md
 * "Connecting a Claude subscription in-app").
 *
 * `claude setup-token` demands a TTY — a plain pipe makes it refuse or garble
 * its output — so we drive it through a pseudo-terminal (node-pty). The CLI
 * prints an authorize URL (wrapped across terminal columns), waits for the user
 * to paste the code from claude.com on stdin, then prints an
 * `sk-ant-oat01-…` token. The attempt is bound to the child's PKCE verifier and
 * the CLI self-destructs after ~10–15 min, so a late paste is useless — we
 * surface expiry and keep at most one attempt alive.
 */

const AUTHORIZE_URL_TIMEOUT_MS = 30_000;
const COMPLETE_TIMEOUT_MS = 30_000;
const ATTEMPT_HARD_EXPIRY_MS = 9 * 60 * 1000; // CLI dies ~10–15 min; expire earlier.
const PROBE_TIMEOUT_MS = 60_000;
/**
 * Gap between writing the pasted code and writing Enter. The CLI's masked code
 * prompt treats `code\r` arriving in ONE write as a paste and swallows the `\r`
 * (never submits) — the code must be typed, THEN Enter sent as a separate
 * keystroke. Verified against Claude Code 2.1.200. See docs/protocol-notes.md.
 */
const ENTER_DELAY_MS = 300;

const TOKEN_RE = /sk-ant-oat01-[A-Za-z0-9_-]+/;
/** Post-submit failure markers the CLI prints for a bad/expired code (fail fast). */
const OAUTH_ERROR_RE = /oauth error|press enter to retry|invalid code|failed with status/i;

/** Strip ANSI/OSC escapes and control bytes from raw terminal output. */
export function stripAnsi(input: string): string {
  return input
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC ... BEL/ST
    .replace(/\x1b[\[\]][0-9;?]*[A-Za-z]/g, '') // CSI / bracket sequences
    .replace(/\x1b[=>]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
}

/** Never let a token escape into a log line or API error. */
export function redactToken(input: string): string {
  return input.replace(/sk-ant-oat01-[A-Za-z0-9_-]+/g, 'sk-ant-oat01-[REDACTED]');
}

/**
 * Widen the authorize URL's scope so the minted token can also read
 * `GET /api/oauth/usage` (Claude Code's /usage data: model-scoped weekly
 * meters + plan name — see usage/claudeProbe.ts). `claude setup-token`
 * hardcodes `scope=user:inference`; the PKCE state/code_challenge don't
 * depend on the scope and the code exchange sends no scope field (verified
 * against CLI 2.1.200), so the code the user pastes back exchanges into a
 * token carrying whatever the consent screen granted. No-op if the URL
 * doesn't look exactly as expected.
 */
export function widenScopes(url: string): string {
  return url.replace(/([?&])scope=user%3Ainference(&|$)/, '$1scope=user%3Ainference%20user%3Aprofile$2');
}

/**
 * Pull the OAuth authorize URL out of `claude setup-token` output. The URL
 * wraps at the terminal width with no spaces inside it, so we join
 * whitespace-separated fragments up to and including the one carrying the
 * trailing `state=` param (the last query param the CLI emits).
 */
export function extractAuthorizeUrl(raw: string): string | null {
  const s = stripAnsi(raw);
  const idx = s.indexOf('https://claude.com/cai/oauth/authorize');
  if (idx < 0) return null;
  const tokens = s.slice(idx).split(/\s+/);
  let url = '';
  for (const tok of tokens) {
    if (!tok) continue;
    url += tok;
    if (/[?&]state=[A-Za-z0-9_-]+/.test(tok)) break;
  }
  const m = url.match(/^https:\/\/claude\.com\/cai\/oauth\/authorize\?[A-Za-z0-9%=&_.\-]*state=[A-Za-z0-9_-]+/);
  return m ? m[0] : null;
}

/** Minimal PTY surface we depend on — lets tests inject a scripted fake. */
export interface PtySession {
  onData(cb: (data: string) => void): void;
  onExit(cb: (info: { exitCode: number }) => void): void;
  write(data: string): void;
  kill(): void;
}

export type PtySpawner = (bin: string, args: string[], env: NodeJS.ProcessEnv) => PtySession;

/** Default spawner: node-pty, lazily imported so `npm test` needn't build the native addon. */
export const nodePtySpawner: PtySpawner = (bin, args, env) => {
  const pty = require('node-pty') as typeof import('node-pty');
  // node-pty's spawn-helper chdir()s into cwd; if the inherited process.cwd()
  // isn't traversable by the running user it dies with a cryptic
  // "chdir(2) failed.: Permission denied" and emits no URL. Pin cwd to Pro's
  // own service home, which is always accessible and is where this login
  // belongs.
  // Wide terminal so the authorize URL and token never wrap across lines.
  const child = pty.spawn(bin, args, { name: 'xterm-256color', cols: 512, rows: 40, cwd: serviceHome(), env });
  return {
    onData: (cb) => child.onData(cb),
    onExit: (cb) => child.onExit(({ exitCode }) => cb({ exitCode })),
    write: (data) => child.write(data),
    kill: () => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    },
  };
};

interface Attempt {
  attemptId: string;
  session: PtySession;
  authorizeUrl: string;
  startedAt: number;
  expiresAt: number;
  buffer: string;
  exited: boolean;
  expiryTimer: NodeJS.Timeout;
}

export class AttemptError extends Error {
  constructor(
    message: string,
    readonly code: 'expired' | 'bad_code' | 'no_url' | 'no_attempt' | 'spawn_failed',
  ) {
    super(message);
    this.name = 'AttemptError';
  }
}

export interface StartResult {
  attemptId: string;
  authorizeUrl: string;
  expiresAt: string;
}

export interface ProbeResult {
  ok: boolean;
  detail: string;
}

/** Identity of the account a freshly minted token belongs to. */
export interface ClaudeTokenProfile {
  email: string | null;
  planType: string | null;
}

export interface ClaudeConnectManager {
  start(): Promise<StartResult>;
  complete(attemptId: string, code: string): Promise<{ probe: ProbeResult; account: ClaudeAccountSummary }>;
  cancel(attemptId: string): { cancelled: boolean };
  hasAttempt(): boolean;
  test(): Promise<ProbeResult>;
  shutdown(): void;
}

export interface ClaudeConnectManagerOptions {
  claudeBin: string;
  secrets: SecretStore;
  spawnPty?: PtySpawner;
  /** Override the token verify probe (tests). */
  probe?: (token: string) => Promise<ProbeResult>;
  /**
   * Who the new token belongs to, used to label the account. Imported lazily by
   * default because usage/claudeProbe.ts imports `redactToken` from this module.
   */
  fetchProfile?: (token: string) => Promise<ClaudeTokenProfile | null>;
  /** Timeout overrides (tests). */
  timeouts?: { authorizeUrlMs?: number; completeMs?: number; hardExpiryMs?: number };
  log?: Pick<Console, 'warn' | 'error'>;
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function createClaudeConnectManager(opts: ClaudeConnectManagerOptions): ClaudeConnectManager {
  const spawnPty = opts.spawnPty ?? nodePtySpawner;
  const log = opts.log ?? console;
  const probe = opts.probe ?? ((token: string) => probeClaudeToken(opts.claudeBin, token, spawn));
  const fetchProfile =
    opts.fetchProfile ??
    (async (token: string) => (await import('../usage/claudeProbe.js')).fetchClaudeOauthProfile(token));
  const urlTimeout = opts.timeouts?.authorizeUrlMs ?? AUTHORIZE_URL_TIMEOUT_MS;
  const completeTimeout = opts.timeouts?.completeMs ?? COMPLETE_TIMEOUT_MS;
  const hardExpiry = opts.timeouts?.hardExpiryMs ?? ATTEMPT_HARD_EXPIRY_MS;
  let current: Attempt | null = null;

  function teardown(attempt: Attempt): void {
    clearTimeout(attempt.expiryTimer);
    try {
      attempt.session.kill();
    } catch {
      /* already gone */
    }
    if (current === attempt) current = null;
  }

  /** Poll the attempt's buffer until `test` matches, the child exits, or timeout. */
  async function waitFor(attempt: Attempt, test: (buf: string) => boolean, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (test(attempt.buffer)) return true;
      if (attempt.exited) return test(attempt.buffer);
      if (Date.now() >= deadline) return false;
      await delay(80);
    }
  }

  return {
    hasAttempt: () => current !== null,

    async start() {
      if (current) teardown(current);

      const attemptId = crypto.randomUUID();
      let session: PtySession;
      try {
        session = spawnPty(opts.claudeBin, ['setup-token'], proServiceEnv());
      } catch (err) {
        throw new AttemptError(`Could not start the Claude sign-in: ${(err as Error).message}`, 'spawn_failed');
      }

      const now = Date.now();
      const attempt: Attempt = {
        attemptId,
        session,
        authorizeUrl: '',
        startedAt: now,
        expiresAt: now + hardExpiry,
        buffer: '',
        exited: false,
        expiryTimer: setTimeout(() => {
          if (current === attempt) {
            log.warn('[claude-connect] attempt expired, killing child');
            teardown(attempt);
          }
        }, hardExpiry),
      };
      session.onData((data) => {
        attempt.buffer = stripAnsi(attempt.buffer + data).slice(-16_000);
      });
      session.onExit(() => {
        attempt.exited = true;
      });
      current = attempt;

      const gotUrl = await waitFor(attempt, (buf) => extractAuthorizeUrl(buf) !== null, urlTimeout);
      if (!gotUrl) {
        teardown(attempt);
        throw new AttemptError('Claude did not return a sign-in link. Please try again.', 'no_url');
      }
      attempt.authorizeUrl = widenScopes(extractAuthorizeUrl(attempt.buffer)!);
      return {
        attemptId,
        authorizeUrl: attempt.authorizeUrl,
        expiresAt: new Date(attempt.expiresAt).toISOString(),
      };
    },

    async complete(attemptId, code) {
      const attempt = current;
      if (!attempt || attempt.attemptId !== attemptId) {
        throw new AttemptError('This sign-in attempt expired. Tap "Start over" to try again.', 'expired');
      }
      if (attempt.exited) {
        teardown(attempt);
        throw new AttemptError('This sign-in attempt expired. Tap "Start over" to try again.', 'expired');
      }

      // The code is opaque (`<base64url>#<state>`); goes straight to stdin, no
      // shell. Type it, THEN send Enter separately — a combined `code\r` write
      // is swallowed as a paste and never submits (see ENTER_DELAY_MS).
      attempt.session.write(code.trim());
      await delay(ENTER_DELAY_MS);
      attempt.session.write('\r');

      // Resolve as soon as EITHER the token or an OAuth error appears.
      await waitFor(attempt, (buf) => TOKEN_RE.test(buf) || OAUTH_ERROR_RE.test(buf), completeTimeout);
      if (!TOKEN_RE.test(attempt.buffer)) {
        // Explicit OAuth error, timeout, or a died attempt — all mean "try again".
        const expired = attempt.exited && !OAUTH_ERROR_RE.test(attempt.buffer);
        teardown(attempt);
        throw expired
          ? new AttemptError('This sign-in attempt expired. Tap "Start over" to try again.', 'expired')
          : new AttemptError('That code did not work. Copy the whole code from Claude and try again.', 'bad_code');
      }

      const token = attempt.buffer.match(TOKEN_RE)![0];
      teardown(attempt);

      // Identify the account before storing it: several subscriptions can be
      // connected at once, so "Claude account" twice would be unusable. Signing
      // in again as an email we already hold refreshes that account in place.
      let profile: ClaudeTokenProfile | null = null;
      try {
        profile = await fetchProfile(token);
      } catch (err) {
        log.warn(`[claude-connect] profile lookup failed: ${redactToken((err as Error).message)}`);
      }
      const account = opts.secrets.addClaudeAccount({
        token,
        email: profile?.email ?? null,
        planType: profile?.planType ?? null,
      });

      let probeResult: ProbeResult;
      try {
        probeResult = await probe(token);
      } catch (err) {
        probeResult = { ok: false, detail: redactToken((err as Error).message) };
      }
      return { probe: probeResult, account };
    },

    cancel(attemptId) {
      if (current && current.attemptId === attemptId) {
        teardown(current);
        return { cancelled: true };
      }
      return { cancelled: false };
    },

    async test() {
      const token = opts.secrets.getClaudeToken() ?? process.env.CLAUDE_CODE_OAUTH_TOKEN;
      if (!token) return { ok: false, detail: 'Not connected.' };
      try {
        return await probe(token);
      } catch (err) {
        return { ok: false, detail: redactToken((err as Error).message) };
      }
    },

    shutdown() {
      if (current) teardown(current);
    },
  };
}

/**
 * Cheap real probe: run one throwaway haiku turn with the given token and check
 * it answers. Non-interactive (`-p`), so a plain pipe is fine (no PTY).
 */
export function probeClaudeToken(
  claudeBin: string,
  token: string,
  spawnFn: typeof spawn = spawn,
): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const child = spawnFn(claudeBin, ['-p', '--model', 'claude-haiku-4-5-20251001'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...proServiceEnv(), CLAUDE_CODE_OAUTH_TOKEN: token },
    });
    let out = '';
    let errTail = '';
    let done = false;
    const finish = (result: ProbeResult): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      resolve(result);
    };
    const timer = setTimeout(
      () => finish({ ok: false, detail: 'Timed out after 60s — Claude did not respond.' }),
      PROBE_TIMEOUT_MS,
    );
    child.stdout?.on('data', (c: Buffer) => {
      out = (out + c.toString('utf8')).slice(-4000);
    });
    child.stderr?.on('data', (c: Buffer) => {
      errTail = (errTail + c.toString('utf8')).slice(-2000);
    });
    child.on('error', (err) => finish({ ok: false, detail: redactToken(err.message) }));
    child.on('close', (code) => {
      const text = out.trim();
      if (code === 0 && /ok/i.test(text)) {
        finish({ ok: true, detail: 'Claude answered.' });
      } else {
        const detail = redactToken((errTail.trim().split('\n').pop() || text || `exited ${code}`).slice(0, 200));
        finish({ ok: false, detail: detail || 'Claude did not answer as expected.' });
      }
    });
    child.stdin?.write('Say exactly: ok');
    child.stdin?.end();
  });
}
