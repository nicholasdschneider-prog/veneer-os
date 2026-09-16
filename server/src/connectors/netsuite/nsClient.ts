import { readFileSync } from 'node:fs';
import { createHash, createSign, constants as cryptoConstants } from 'node:crypto';
import { netSuiteOriginForAccount, normalizeNetSuiteAccountId } from './config.js';
import { formatNetSuiteDiagnostic, type NetSuiteDiagnostic } from './diagnostics.js';

/**
 * Bounded, read-only NetSuite M2M client. OAuth uses a per-request PS256 JWT;
 * REST and SuiteQL calls share a small total deadline and bounded retry budget.
 *
 * Diagnostics are deliberately metadata-only. They never contain credentials,
 * URLs, query text, response bodies, record ids, or customer data.
 */

interface NetSuiteConfig {
  accountId: string;
  clientId: string;
  certId: string;
  scope: string;
  origin: string;
  tokenUrl: string;
  cacheKey: string;
}

export interface NetSuiteCredentials {
  accountId: string;
  clientId: string;
  certId: string;
  privateKey: string;
  scope?: string;
}

export interface NetSuiteClientRuntime {
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  random?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  log?: Pick<Console, 'error'>;
  tokenAttemptTimeoutMs?: number;
  requestAttemptTimeoutMs?: number;
  totalTimeoutMs?: number;
  tokenMaxAttempts?: number;
  readMaxAttempts?: number;
}

interface Runtime {
  fetch: typeof globalThis.fetch;
  now: () => number;
  random: () => number;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  log: Pick<Console, 'error'>;
  tokenAttemptTimeoutMs: number;
  requestAttemptTimeoutMs: number;
  totalTimeoutMs: number;
  tokenMaxAttempts: number;
  readMaxAttempts: number;
}

const DEFAULT_TOKEN_ATTEMPT_TIMEOUT_MS = 8_000;
const DEFAULT_REQUEST_ATTEMPT_TIMEOUT_MS = 10_000;
const DEFAULT_TOTAL_TIMEOUT_MS = 30_000;
const DEFAULT_TOKEN_MAX_ATTEMPTS = 2;
const DEFAULT_READ_MAX_ATTEMPTS = 3;
const MAX_RETRY_DELAY_MS = 5_000;
const TRANSIENT_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const finish = (): void => {
      signal?.removeEventListener('abort', abort);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    timer.unref?.();
    const abort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(new Error('cancelled'));
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  });
}

function runtime(overrides?: NetSuiteClientRuntime): Runtime {
  return {
    fetch: overrides?.fetch ?? globalThis.fetch,
    now: overrides?.now ?? Date.now,
    random: overrides?.random ?? Math.random,
    sleep: overrides?.sleep ?? defaultSleep,
    log: overrides?.log ?? console,
    tokenAttemptTimeoutMs: overrides?.tokenAttemptTimeoutMs ?? DEFAULT_TOKEN_ATTEMPT_TIMEOUT_MS,
    requestAttemptTimeoutMs: overrides?.requestAttemptTimeoutMs ?? DEFAULT_REQUEST_ATTEMPT_TIMEOUT_MS,
    totalTimeoutMs: overrides?.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS,
    tokenMaxAttempts: overrides?.tokenMaxAttempts ?? DEFAULT_TOKEN_MAX_ATTEMPTS,
    readMaxAttempts: overrides?.readMaxAttempts ?? DEFAULT_READ_MAX_ATTEMPTS,
  };
}

function diagnose(rt: Runtime, fields: NetSuiteDiagnostic): void {
  rt.log.error(formatNetSuiteDiagnostic(fields));
}

export class NetSuiteClientError extends Error {
  readonly code:
    | 'cancelled'
    | 'timeout'
    | 'authentication'
    | 'forbidden'
    | 'rate_limited'
    | 'transient_exhausted'
    | 'request_failed'
    | 'invalid_response';
  readonly status?: number;
  readonly timeoutStage?: 'token' | 'request' | 'backoff' | 'total';

  constructor(
    message: string,
    code: NetSuiteClientError['code'],
    options: { status?: number; timeoutStage?: NetSuiteClientError['timeoutStage'] } = {},
  ) {
    super(message);
    this.name = 'NetSuiteClientError';
    this.code = code;
    this.status = options.status;
    this.timeoutStage = options.timeoutStage;
  }
}

function b64url(buf: string | Buffer): string {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function privateKeyPem(credentials?: NetSuiteCredentials): string {
  const inline = credentials?.privateKey ?? process.env.NS_PRIVATE_KEY_PEM;
  if (inline && inline.trim()) {
    return inline.includes('BEGIN') ? inline : Buffer.from(inline, 'base64').toString('utf8');
  }
  const keyPath = process.env.NS_PRIVATE_KEY;
  if (keyPath) return readFileSync(keyPath, 'utf8');
  throw new Error('NetSuite private key not configured (set NS_PRIVATE_KEY_PEM or NS_PRIVATE_KEY).');
}

function readConfig(credentials?: NetSuiteCredentials): NetSuiteConfig {
  const accountId = normalizeNetSuiteAccountId(credentials?.accountId ?? process.env.NS_ACCOUNT_ID ?? '');
  const clientId = credentials?.clientId.trim() ?? process.env.NS_CLIENT_ID?.trim() ?? '';
  const certId = credentials?.certId.trim() ?? process.env.NS_CERT_ID?.trim() ?? '';
  const scope = credentials?.scope?.trim() || process.env.NS_SCOPE?.trim() || 'rest_webservices';
  if (!clientId || !certId) throw new Error('NetSuite client ID and certificate ID are required.');
  const origin = netSuiteOriginForAccount(accountId);
  // The key fingerprint prevents an install update from reusing a token minted
  // with an older private key. It stays process-local and is never logged.
  const keyFingerprint = createHash('sha256').update(privateKeyPem(credentials)).digest('hex');
  return {
    accountId,
    clientId,
    certId,
    scope,
    origin,
    tokenUrl: `${origin}/services/rest/auth/oauth2/v1/token`,
    cacheKey: `${accountId}\0${clientId}\0${certId}\0${scope}\0${keyFingerprint}`,
  };
}

function mintToken(config: NetSuiteConfig, credentials?: NetSuiteCredentials): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'PS256', typ: 'JWT', kid: config.certId };
  const claims = { iss: config.clientId, scope: config.scope, aud: config.tokenUrl, iat: now, exp: now + 3600 };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const signer = createSign('RSA-SHA256');
  signer.update(signingInput);
  const sig = signer.sign(
    {
      key: privateKeyPem(credentials),
      padding: cryptoConstants.RSA_PKCS1_PSS_PADDING,
      saltLength: cryptoConstants.RSA_PSS_SALTLEN_DIGEST,
    },
    'base64',
  );
  return `${signingInput}.${sig.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
}

interface TokenCache {
  key: string;
  accessToken: string;
  expiresAt: number;
}

let tokenCache: TokenCache | null = null;
let tokenRequest: { key: string; promise: Promise<string> } | null = null;

function deadlineSignal(parent: AbortSignal | undefined, timeoutMs: number): {
  signal: AbortSignal;
  timedOut: () => boolean;
  cleanup: () => void;
} {
  const controller = new AbortController();
  let timeout = false;
  const onAbort = (): void => controller.abort();
  if (parent?.aborted) controller.abort();
  else parent?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => {
    timeout = true;
    controller.abort();
  }, Math.max(1, timeoutMs));
  timer.unref?.();
  return {
    signal: controller.signal,
    timedOut: () => timeout,
    cleanup: () => {
      clearTimeout(timer);
      parent?.removeEventListener('abort', onAbort);
    },
  };
}

function remainingMs(rt: Runtime, deadline: number): number {
  return Math.max(0, deadline - rt.now());
}

function timeoutError(stage: 'token' | 'request' | 'backoff' | 'total', timeoutMs: number): NetSuiteClientError {
  const label =
    stage === 'token'
      ? 'token acquisition'
      : stage === 'backoff'
        ? 'retry backoff'
        : stage === 'total'
          ? 'the total request budget'
          : 'request';
  return new NetSuiteClientError(
    `NetSuite timed out during ${label} after ${Math.max(1, Math.round(timeoutMs))} ms.`,
    'timeout',
    { timeoutStage: stage },
  );
}

function cancelledError(): NetSuiteClientError {
  return new NetSuiteClientError('NetSuite request was cancelled.', 'cancelled');
}

function safeStatusError(operation: 'token' | 'rest' | 'suiteql', status: number, exhausted: boolean): NetSuiteClientError {
  if (operation === 'token' && (status === 400 || status === 401 || status === 403)) {
    return new NetSuiteClientError('NetSuite authentication was rejected. Check the client and certificate credentials.', 'authentication', {
      status,
    });
  }
  if (status === 401) {
    return new NetSuiteClientError('NetSuite authentication was rejected. Check the client and certificate credentials.', 'authentication', {
      status,
    });
  }
  if (status === 403) {
    return new NetSuiteClientError('NetSuite authenticated, but the assigned role does not allow this read operation.', 'forbidden', {
      status,
    });
  }
  if (status === 429) {
    return new NetSuiteClientError('NetSuite rate limiting did not clear within the retry budget. Try again shortly.', 'rate_limited', {
      status,
    });
  }
  if (exhausted && TRANSIENT_STATUSES.has(status)) {
    return new NetSuiteClientError(
      `NetSuite ${operation} remained unavailable after bounded retries (HTTP ${status}).`,
      'transient_exhausted',
      { status },
    );
  }
  return new NetSuiteClientError(`NetSuite ${operation} request failed with HTTP ${status}.`, 'request_failed', {
    status,
  });
}

function retryAfterMs(value: string | null, now: number): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1_000, MAX_RETRY_DELAY_MS);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.min(Math.max(0, date - now), MAX_RETRY_DELAY_MS);
  return null;
}

function retryDelayMs(rt: Runtime, attempt: number, retryAfter: string | null): number {
  const instructed = retryAfterMs(retryAfter, rt.now());
  if (instructed !== null) return instructed;
  const exponential = Math.min(250 * 2 ** Math.max(0, attempt - 1), 2_000);
  return Math.round(exponential + rt.random() * 125);
}

async function waitForRetry(
  rt: Runtime,
  delayMs: number,
  deadline: number,
  signal: AbortSignal | undefined,
  operation: 'token' | 'rest' | 'suiteql',
  attempt: number,
  reason: 'network' | 'status' | 'authentication',
): Promise<void> {
  const remaining = remainingMs(rt, deadline);
  if (remaining <= delayMs) {
    diagnose(rt, { event: 'retry', operation, attempt, delayMs, reason, timeoutStage: 'backoff' });
    throw timeoutError('backoff', remaining);
  }
  diagnose(rt, { event: 'retry', operation, attempt, delayMs, reason });
  try {
    await rt.sleep(delayMs, signal);
  } catch {
    if (signal?.aborted) throw cancelledError();
    throw timeoutError('backoff', delayMs);
  }
}

async function requestToken(
  config: NetSuiteConfig,
  credentials: NetSuiteCredentials | undefined,
  rt: Runtime,
  deadline: number,
  signal?: AbortSignal,
): Promise<string> {
  let lastStatus = 0;
  for (let attempt = 1; attempt <= rt.tokenMaxAttempts; attempt += 1) {
    const remaining = remainingMs(rt, deadline);
    if (remaining <= 0) throw timeoutError('total', rt.totalTimeoutMs);
    const attemptTimeout = Math.min(rt.tokenAttemptTimeoutMs, remaining);
    const timed = deadlineSignal(signal, attemptTimeout);
    const started = rt.now();
    try {
      const res = await rt.fetch(config.tokenUrl, {
        method: 'POST',
        redirect: 'error',
        signal: timed.signal,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
          client_assertion: mintToken(config, credentials),
        }),
      });
      const raw = await res.text();
      const durationMs = rt.now() - started;
      diagnose(rt, { event: 'token', operation: 'token', attempt, status: res.status, durationMs });
      lastStatus = res.status;
      let json: { access_token?: string; expires_in?: number } = {};
      try {
        json = raw ? (JSON.parse(raw) as typeof json) : {};
      } catch {
        throw new NetSuiteClientError('NetSuite token endpoint returned an invalid response.', 'invalid_response');
      }
      if (res.ok && json.access_token) {
        tokenCache = {
          key: config.cacheKey,
          accessToken: json.access_token,
          expiresAt: rt.now() + (json.expires_in ?? 3600) * 1_000,
        };
        return json.access_token;
      }
      if (TRANSIENT_STATUSES.has(res.status) && attempt < rt.tokenMaxAttempts) {
        await waitForRetry(
          rt,
          retryDelayMs(rt, attempt, res.headers.get('retry-after')),
          deadline,
          signal,
          'token',
          attempt,
          'status',
        );
        continue;
      }
      throw safeStatusError('token', res.status, attempt >= rt.tokenMaxAttempts);
    } catch (error) {
      if (error instanceof NetSuiteClientError) throw error;
      const durationMs = rt.now() - started;
      if (timed.timedOut()) {
        diagnose(rt, {
          event: 'token',
          operation: 'token',
          attempt,
          status: 'error',
          durationMs,
          reason: 'timeout',
          timeoutStage: 'token',
        });
        if (attempt < rt.tokenMaxAttempts && remainingMs(rt, deadline) > 0) {
          await waitForRetry(rt, retryDelayMs(rt, attempt, null), deadline, signal, 'token', attempt, 'network');
          continue;
        }
        throw timeoutError('token', attemptTimeout);
      }
      if (signal?.aborted) throw cancelledError();
      diagnose(rt, { event: 'token', operation: 'token', attempt, status: 'error', durationMs, reason: 'network' });
      if (attempt < rt.tokenMaxAttempts) {
        await waitForRetry(rt, retryDelayMs(rt, attempt, null), deadline, signal, 'token', attempt, 'network');
        continue;
      }
      throw new NetSuiteClientError('NetSuite token request failed after bounded network retries.', 'transient_exhausted', {
        ...(lastStatus ? { status: lastStatus } : {}),
      });
    } finally {
      timed.cleanup();
    }
  }
  throw new NetSuiteClientError('NetSuite token request exhausted its retry budget.', 'transient_exhausted');
}

async function getTokenWithDeadline(
  credentials: NetSuiteCredentials | undefined,
  rt: Runtime,
  deadline: number,
  signal?: AbortSignal,
  forceRefresh = false,
): Promise<string> {
  const config = readConfig(credentials);
  if (!forceRefresh && tokenCache?.key === config.cacheKey && tokenCache.expiresAt - rt.now() > 120_000) {
    diagnose(rt, { event: 'token', operation: 'token', status: 'cached', durationMs: 0 });
    return tokenCache.accessToken;
  }
  if (!forceRefresh && tokenRequest?.key === config.cacheKey) return tokenRequest.promise;
  if (forceRefresh && tokenCache?.key === config.cacheKey) tokenCache = null;

  const promise = requestToken(config, credentials, rt, deadline, signal).finally(() => {
    if (tokenRequest?.promise === promise) tokenRequest = null;
  });
  tokenRequest = { key: config.cacheKey, promise };
  return promise;
}

export async function getToken(
  credentials?: NetSuiteCredentials,
  options: { signal?: AbortSignal; forceRefresh?: boolean; runtime?: NetSuiteClientRuntime } = {},
): Promise<string> {
  const rt = runtime(options.runtime);
  return getTokenWithDeadline(
    credentials,
    rt,
    rt.now() + rt.totalTimeoutMs,
    options.signal,
    options.forceRefresh,
  );
}

export function resolveNetSuiteUrl(path: string, credentials?: NetSuiteCredentials): URL {
  const input = path.trim();
  if (!input) throw new Error('NetSuite REST path is required.');
  if (input.includes('\\') || input.includes('#') || input.startsWith('//') || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(input)) {
    throw new Error('NetSuite GET accepts a relative REST path only (for example record/v1/customer/123).');
  }

  const config = readConfig(credentials);
  const relativePath = input.startsWith('/services/rest/')
    ? input
    : input.startsWith('/')
      ? ''
      : `/services/rest/${input}`;
  if (!relativePath) throw new Error('NetSuite GET paths must be under /services/rest/.');

  const url = new URL(relativePath, `${config.origin}/`);
  if (
    url.protocol !== 'https:' ||
    url.origin !== config.origin ||
    url.username ||
    url.password ||
    url.port ||
    !url.pathname.startsWith('/services/rest/')
  ) {
    throw new Error('NetSuite GET path resolved outside the configured NetSuite REST API.');
  }
  return url;
}

export interface NsRequestOptions {
  method?: string;
  query?: Record<string, string>;
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Explicitly marks a non-GET operation such as SuiteQL POST as safe to retry. */
  readOnly?: boolean;
  operation?: 'rest' | 'suiteql';
  runtime?: NetSuiteClientRuntime;
}

function invalidateToken(config: NetSuiteConfig, token: string): void {
  if (tokenCache?.key === config.cacheKey && tokenCache.accessToken === token) tokenCache = null;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export async function nsFetch(
  path: string,
  opts: NsRequestOptions = {},
  credentials?: NetSuiteCredentials,
): Promise<any> {
  const rt = runtime(opts.runtime);
  const started = rt.now();
  const deadline = started + (opts.timeoutMs ?? rt.totalTimeoutMs);
  const method = (opts.method ?? 'GET').toUpperCase();
  const operation = opts.operation ?? 'rest';
  const safeRead = method === 'GET' || opts.readOnly === true;
  const maxAttempts = safeRead ? rt.readMaxAttempts : 1;
  const config = readConfig(credentials);
  const url = resolveNetSuiteUrl(path, credentials);
  if (opts.query) {
    for (const [key, value] of Object.entries(opts.query)) url.searchParams.set(key, value);
  }

  let token = await getTokenWithDeadline(credentials, rt, deadline, opts.signal);
  let refreshed401 = false;
  let lastStatus = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const remaining = remainingMs(rt, deadline);
    if (remaining <= 0) {
      diagnose(rt, {
        event: 'request',
        operation,
        attempt,
        status: 'error',
        totalDurationMs: rt.now() - started,
        reason: 'timeout',
        timeoutStage: 'total',
      });
      throw timeoutError('total', opts.timeoutMs ?? rt.totalTimeoutMs);
    }
    const attemptTimeout = Math.min(rt.requestAttemptTimeoutMs, remaining);
    const timed = deadlineSignal(opts.signal, attemptTimeout);
    const attemptStarted = rt.now();
    try {
      const hasBody = opts.body !== undefined;
      const res = await rt.fetch(url, {
        method,
        redirect: 'error',
        signal: timed.signal,
        headers: {
          ...opts.headers,
          ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: hasBody ? JSON.stringify(opts.body) : undefined,
      });
      const raw = await res.text();
      const durationMs = rt.now() - attemptStarted;
      lastStatus = res.status;
      diagnose(rt, { event: 'request', operation, attempt, status: res.status, durationMs });

      if (res.status === 401 && safeRead && !refreshed401) {
        refreshed401 = true;
        invalidateToken(config, token);
        token = await getTokenWithDeadline(credentials, rt, deadline, opts.signal, true);
        diagnose(rt, { event: 'retry', operation, attempt, delayMs: 0, reason: 'authentication' });
        continue;
      }

      if (!res.ok) {
        if (safeRead && TRANSIENT_STATUSES.has(res.status) && attempt < maxAttempts) {
          await waitForRetry(
            rt,
            retryDelayMs(rt, attempt, res.headers.get('retry-after')),
            deadline,
            opts.signal,
            operation,
            attempt,
            'status',
          );
          continue;
        }
        throw safeStatusError(operation, res.status, attempt >= maxAttempts);
      }

      if (!raw) return null;
      try {
        return JSON.parse(raw);
      } catch {
        throw new NetSuiteClientError('NetSuite returned an invalid JSON response.', 'invalid_response');
      }
    } catch (error) {
      if (error instanceof NetSuiteClientError) throw error;
      const durationMs = rt.now() - attemptStarted;
      if (timed.timedOut()) {
        diagnose(rt, {
          event: 'request',
          operation,
          attempt,
          status: 'error',
          durationMs,
          reason: 'timeout',
          timeoutStage: 'request',
        });
        if (safeRead && attempt < maxAttempts && remainingMs(rt, deadline) > 0) {
          await waitForRetry(rt, retryDelayMs(rt, attempt, null), deadline, opts.signal, operation, attempt, 'network');
          continue;
        }
        throw timeoutError('request', attemptTimeout);
      }
      if (opts.signal?.aborted) throw cancelledError();
      diagnose(rt, { event: 'request', operation, attempt, status: 'error', durationMs, reason: 'network' });
      if (safeRead && attempt < maxAttempts) {
        await waitForRetry(rt, retryDelayMs(rt, attempt, null), deadline, opts.signal, operation, attempt, 'network');
        continue;
      }
      throw new NetSuiteClientError(
        safeRead
          ? 'NetSuite read failed after bounded network retries.'
          : 'NetSuite request failed and was not retried because it is not read-only.',
        safeRead ? 'transient_exhausted' : 'request_failed',
        { ...(lastStatus ? { status: lastStatus } : {}) },
      );
    } finally {
      timed.cleanup();
    }
  }
  throw new NetSuiteClientError('NetSuite read exhausted its retry budget.', 'transient_exhausted', {
    ...(lastStatus ? { status: lastStatus } : {}),
  });
}

export function nsGet(
  path: string,
  query?: Record<string, string>,
  credentials?: NetSuiteCredentials,
): Promise<any> {
  return nsFetch(path, { query }, credentials);
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export interface SuiteqlOptions {
  pageSize?: number;
  maxRows?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
  runtime?: NetSuiteClientRuntime;
}

/**
 * Small lexer that ignores quoted strings/identifiers and SQL comments. It
 * permits SELECT and WITH ... SELECT, a single optional trailing semicolon,
 * and rejects every write/DDL keyword at the connector boundary.
 */
export function assertReadOnlySuiteql(query: string): void {
  const tokens: string[] = [];
  let i = 0;
  while (i < query.length) {
    const ch = query[i]!;
    const next = query[i + 1];
    if (ch === '-' && next === '-') {
      i += 2;
      while (i < query.length && query[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      let closed = false;
      while (i < query.length - 1) {
        if (query[i] === '*' && query[i + 1] === '/') {
          i += 2;
          closed = true;
          break;
        }
        i += 1;
      }
      if (!closed) throw new Error('SuiteQL contains an unterminated comment.');
      continue;
    }
    if (ch === "'" || ch === '"') {
      const quote = ch;
      i += 1;
      let closed = false;
      while (i < query.length) {
        if (query[i] === quote) {
          if (query[i + 1] === quote) {
            i += 2;
            continue;
          }
          i += 1;
          closed = true;
          break;
        }
        i += 1;
      }
      if (!closed) throw new Error('SuiteQL contains an unterminated quoted value.');
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const start = i;
      i += 1;
      while (i < query.length && /[A-Za-z0-9_$#]/.test(query[i]!)) i += 1;
      tokens.push(query.slice(start, i).toUpperCase());
      continue;
    }
    if (ch === ';') tokens.push(';');
    i += 1;
  }

  if (!tokens.length || (tokens[0] !== 'SELECT' && tokens[0] !== 'WITH')) {
    throw new Error('SuiteQL is read-only and accepts only SELECT statements (including WITH ... SELECT).');
  }
  const semicolon = tokens.indexOf(';');
  if (semicolon !== -1 && semicolon !== tokens.length - 1) {
    throw new Error('SuiteQL accepts one read-only statement at a time.');
  }
  if (tokens.indexOf(';', semicolon + 1) !== -1) {
    throw new Error('SuiteQL accepts one read-only statement at a time.');
  }
  if (!tokens.includes('SELECT')) {
    throw new Error('SuiteQL WITH statements must end in a SELECT.');
  }
  const forbidden = new Set([
    'INSERT',
    'UPDATE',
    'DELETE',
    'MERGE',
    'UPSERT',
    'CREATE',
    'ALTER',
    'DROP',
    'TRUNCATE',
    'GRANT',
    'REVOKE',
    'CALL',
    'EXECUTE',
    'BEGIN',
    'COMMIT',
    'ROLLBACK',
  ]);
  const writeKeyword = tokens.find((token) => forbidden.has(token));
  if (writeKeyword) throw new Error(`SuiteQL is read-only; ${writeKeyword} is not allowed.`);
}

export async function suiteql(
  query: string,
  opts: SuiteqlOptions = {},
  credentials?: NetSuiteCredentials,
): Promise<Record<string, unknown>[]> {
  assertReadOnlySuiteql(query);
  const rt = runtime(opts.runtime);
  const started = rt.now();
  const timeoutMs = opts.timeoutMs ?? rt.totalTimeoutMs;
  const pageSize = Math.min(Math.max(opts.pageSize ?? 1000, 1), 1000);
  const maxRows = Math.max(opts.maxRows ?? 1000, 1);
  const out: Record<string, unknown>[] = [];
  let offset = 0;
  let pages = 0;
  for (;;) {
    pages += 1;
    const page = await nsFetch(
      `query/v1/suiteql?limit=${pageSize}&offset=${offset}`,
      {
        method: 'POST',
        headers: { Prefer: 'transient' },
        body: { q: query },
        readOnly: true,
        operation: 'suiteql',
        signal: opts.signal,
        timeoutMs: Math.max(1, timeoutMs - (rt.now() - started)),
        runtime: opts.runtime,
      },
      credentials,
    );
    const items = (page.items ?? []) as Record<string, unknown>[];
    for (const row of items) {
      delete (row as { links?: unknown }).links;
      out.push(row);
      if (out.length >= maxRows) break;
    }
    diagnose(rt, { event: 'page', operation: 'suiteql', page: pages, rows: items.length });
    if (!page.hasMore || out.length >= maxRows) break;
    offset += pageSize;
  }
  diagnose(rt, {
    event: 'suiteql',
    operation: 'suiteql',
    status: 'ok',
    pages,
    rows: out.length,
    totalDurationMs: rt.now() - started,
  });
  return out.slice(0, maxRows);
}

export interface NetSuiteHealthResult {
  ok: boolean;
  status: 'connected' | 'error';
  error: string | null;
  timeoutStage: NetSuiteClientError['timeoutStage'] | null;
  timings: {
    tokenMs: number | null;
    queryMs: number | null;
    totalMs: number;
  };
}

/** Credential + read/query health check. Returned rows are always discarded. */
export async function testNetSuiteConnection(
  credentials: NetSuiteCredentials,
  options: { signal?: AbortSignal; runtime?: NetSuiteClientRuntime } = {},
): Promise<NetSuiteHealthResult> {
  const rt = runtime(options.runtime);
  const started = rt.now();
  const deadline = started + rt.totalTimeoutMs;
  let tokenMs: number | null = null;
  let queryMs: number | null = null;
  let stage: 'token' | 'query' = 'token';
  try {
    const tokenStarted = rt.now();
    await getTokenWithDeadline(credentials, rt, deadline, options.signal, true);
    tokenMs = rt.now() - tokenStarted;
    stage = 'query';
    const queryStarted = rt.now();
    await suiteql(
      'SELECT id FROM customer WHERE ROWNUM <= 1',
      {
        pageSize: 1,
        maxRows: 1,
        signal: options.signal,
        timeoutMs: Math.max(1, remainingMs(rt, deadline)),
        runtime: options.runtime,
      },
      credentials,
    );
    queryMs = rt.now() - queryStarted;
    const result: NetSuiteHealthResult = {
      ok: true,
      status: 'connected',
      error: null,
      timeoutStage: null,
      timings: { tokenMs, queryMs, totalMs: rt.now() - started },
    };
    diagnose(rt, { event: 'health', operation: 'health', status: 'ok', totalDurationMs: result.timings.totalMs });
    return result;
  } catch (error) {
    const clientError = error instanceof NetSuiteClientError ? error : null;
    const result: NetSuiteHealthResult = {
      ok: false,
      status: 'error',
      error: clientError?.message ?? `NetSuite ${stage === 'token' ? 'credentials' : 'query access'} could not be verified.`,
      timeoutStage: clientError?.timeoutStage ?? null,
      timings: {
        tokenMs,
        queryMs: stage === 'query' ? rt.now() - (started + (tokenMs ?? 0)) : null,
        totalMs: rt.now() - started,
      },
    };
    diagnose(rt, {
      event: 'health',
      operation: 'health',
      status: 'error',
      totalDurationMs: result.timings.totalMs,
      ...(result.timeoutStage ? { timeoutStage: result.timeoutStage, reason: 'timeout' as const } : {}),
    });
    return result;
  }
}

export function toCsv(rows: Record<string, unknown>[], columns?: string[]): string {
  if (!rows.length) return '';
  const cols = columns || [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const escape = (value: unknown): string => {
    if (value == null) return '';
    const string = typeof value === 'object' ? JSON.stringify(value) : String(value);
    return /[",\n]/.test(string) ? `"${string.replace(/"/g, '""')}"` : string;
  };
  return [cols.join(','), ...rows.map((row) => cols.map((column) => escape(row[column])).join(','))].join('\n');
}
