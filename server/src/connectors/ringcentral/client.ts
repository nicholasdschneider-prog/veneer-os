import { createHash } from 'node:crypto';
import { normalizeRingCentralServerUrl } from './config.js';

export interface RingCentralCredentials {
  serverUrl?: string;
  clientId: string;
  clientSecret: string;
  jwt: string;
}

export interface RingCentralClientRuntime {
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  tokenTimeoutMs?: number;
  requestTimeoutMs?: number;
}

interface Runtime {
  fetch: typeof globalThis.fetch;
  now: () => number;
  tokenTimeoutMs: number;
  requestTimeoutMs: number;
}

interface Config {
  origin: string;
  clientId: string;
  clientSecret: string;
  jwt: string;
  cacheKey: string;
}

interface TokenCache {
  key: string;
  token: string;
  expiresAt: number;
}

export interface RingCentralHealthResult {
  ok: boolean;
  status: 'connected' | 'error';
  error: string | null;
  timeoutStage: 'token' | 'request' | null;
  timings: { tokenMs: number | null; queryMs: number | null; totalMs: number };
}

export interface RingCentralListOptions {
  page?: number;
  perPage?: number;
}

export interface RingCentralCallListOptions extends RingCentralListOptions {
  dateFrom?: string;
  dateTo?: string;
  direction?: 'Inbound' | 'Outbound';
  recordingOnly?: boolean;
  phoneNumber?: string;
}

export class RingCentralClientError extends Error {
  readonly code: 'timeout' | 'authentication' | 'forbidden' | 'rate_limited' | 'request_failed' | 'invalid_response';
  readonly status?: number;
  readonly timeoutStage?: 'token' | 'request';

  constructor(
    message: string,
    code: RingCentralClientError['code'],
    options: { status?: number; timeoutStage?: RingCentralClientError['timeoutStage'] } = {},
  ) {
    super(message);
    this.name = 'RingCentralClientError';
    this.code = code;
    this.status = options.status;
    this.timeoutStage = options.timeoutStage;
  }
}

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_CALL_RANGE_MS = 90 * 24 * 60 * 60_000;
let tokenCache: TokenCache | null = null;
let tokenRequest: { key: string; promise: Promise<string> } | null = null;

function runtime(overrides?: RingCentralClientRuntime): Runtime {
  return {
    fetch: overrides?.fetch ?? globalThis.fetch,
    now: overrides?.now ?? Date.now,
    tokenTimeoutMs: overrides?.tokenTimeoutMs ?? 8_000,
    requestTimeoutMs: overrides?.requestTimeoutMs ?? 15_000,
  };
}

function config(credentials?: RingCentralCredentials): Config {
  const origin = normalizeRingCentralServerUrl(credentials?.serverUrl ?? process.env.RC_SERVER_URL);
  const clientId = credentials?.clientId.trim() ?? process.env.RC_CLIENT_ID?.trim() ?? '';
  const clientSecret = credentials?.clientSecret ?? process.env.RC_CLIENT_SECRET ?? '';
  const jwt = credentials?.jwt.trim() ?? process.env.RC_JWT?.trim() ?? '';
  if (!clientId || !clientSecret || !jwt || /\0|\r|\n/.test(`${clientId}${clientSecret}${jwt}`)) {
    throw new RingCentralClientError('RingCentral credentials are incomplete or invalid.', 'authentication');
  }
  const cacheKey = createHash('sha256')
    .update(origin).update('\0').update(clientId).update('\0').update(clientSecret).update('\0').update(jwt)
    .digest('hex');
  return { origin, clientId, clientSecret, jwt, cacheKey };
}

async function fetchWithDeadline(
  rt: Runtime,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  stage: 'token' | 'request',
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  timer.unref?.();
  try {
    return await rt.fetch(url, { ...init, signal: controller.signal, redirect: 'error' });
  } catch {
    if (controller.signal.aborted) {
      throw new RingCentralClientError(`RingCentral timed out during ${stage === 'token' ? 'authentication' : 'a read request'}.`, 'timeout', {
        timeoutStage: stage,
      });
    }
    throw new RingCentralClientError('RingCentral could not be reached for the read request.', 'request_failed');
  } finally {
    clearTimeout(timer);
  }
}

function statusError(status: number, operation: 'token' | 'read'): RingCentralClientError {
  if ((operation === 'token' && status === 400) || status === 401) {
    return new RingCentralClientError('RingCentral authentication was rejected. Check the server-to-server JWT credentials.', 'authentication', { status });
  }
  if (status === 403) {
    return new RingCentralClientError('RingCentral authenticated, but the application does not allow this read operation.', 'forbidden', { status });
  }
  if (status === 429) {
    return new RingCentralClientError('RingCentral is rate limiting this connector. Try again shortly.', 'rate_limited', { status });
  }
  return new RingCentralClientError(`RingCentral ${operation === 'token' ? 'authentication' : 'read'} failed with HTTP ${status}.`, 'request_failed', { status });
}

async function parseJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new RingCentralClientError('RingCentral returned more data than the connector allows.', 'invalid_response');
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (response.body) {
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new RingCentralClientError('RingCentral returned more data than the connector allows.', 'invalid_response');
      }
      chunks.push(value);
    }
  }
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new RingCentralClientError('RingCentral returned an invalid JSON response.', 'invalid_response');
  }
}

async function mintToken(cfg: Config, rt: Runtime): Promise<string> {
  const response = await fetchWithDeadline(rt, `${cfg.origin}/restapi/oauth/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: cfg.jwt,
    }).toString(),
  }, rt.tokenTimeoutMs, 'token');
  if (!response.ok) throw statusError(response.status, 'token');
  const data = await parseJson(response) as { access_token?: unknown; expires_in?: unknown };
  const token = typeof data.access_token === 'string' ? data.access_token : '';
  const expiresIn = Number(data.expires_in);
  if (!token || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new RingCentralClientError('RingCentral returned an incomplete authentication response.', 'invalid_response');
  }
  const lifetimeMs = expiresIn * 1_000;
  tokenCache = {
    key: cfg.cacheKey,
    token,
    expiresAt: rt.now() + Math.max(1_000, lifetimeMs - Math.min(60_000, Math.floor(lifetimeMs / 5))),
  };
  return token;
}

async function accessToken(cfg: Config, rt: Runtime, force = false): Promise<string> {
  if (!force && tokenCache?.key === cfg.cacheKey && tokenCache.expiresAt > rt.now()) return tokenCache.token;
  if (!force && tokenRequest?.key === cfg.cacheKey) return tokenRequest.promise;
  if (tokenCache?.key === cfg.cacheKey) tokenCache = null;
  const promise = mintToken(cfg, rt).finally(() => {
    if (tokenRequest?.promise === promise) tokenRequest = null;
  });
  tokenRequest = { key: cfg.cacheKey, promise };
  return promise;
}

function boundedInteger(value: unknown, fallback: number, max: number, label: string): number {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > max) {
    throw new RingCentralClientError(`${label} must be an integer from 1 to ${max}.`, 'request_failed');
  }
  return number;
}

function safeId(value: string, label: string): string {
  const id = value.trim();
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(id)) {
    throw new RingCentralClientError(`${label} is invalid.`, 'request_failed');
  }
  return id;
}

function sanitizeProviderData(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeProviderData);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== 'contentUri' && !/^(?:access_?token|refresh_?token|authorization|client_?secret|jwt|password|secret)$/i.test(key))
      .map(([key, item]) => [key, sanitizeProviderData(item)]),
  );
}

async function fixedRead(
  path: string,
  query: URLSearchParams,
  options: { credentials?: RingCentralCredentials; runtime?: RingCentralClientRuntime } = {},
): Promise<unknown> {
  const cfg = config(options.credentials);
  const rt = runtime(options.runtime);
  const url = new URL(path, `${cfg.origin}/`);
  if (url.origin !== cfg.origin || !url.pathname.startsWith('/restapi/v1.0/')) {
    throw new RingCentralClientError('RingCentral read target was rejected.', 'request_failed');
  }
  url.search = query.toString();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const token = await accessToken(cfg, rt, attempt === 1);
    const response = await fetchWithDeadline(rt, url.toString(), {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    }, rt.requestTimeoutMs, 'request');
    if (response.status === 401 && attempt === 0) {
      if (tokenCache?.key === cfg.cacheKey) tokenCache = null;
      continue;
    }
    if (!response.ok) throw statusError(response.status, 'read');
    return sanitizeProviderData(await parseJson(response));
  }
  throw statusError(401, 'read');
}

const emptyQuery = (): URLSearchParams => new URLSearchParams();

export function getRingCentralAccount(options?: { credentials?: RingCentralCredentials; runtime?: RingCentralClientRuntime }): Promise<unknown> {
  return fixedRead('/restapi/v1.0/account/~', emptyQuery(), options);
}

export function getRingCentralCurrentExtension(options?: { credentials?: RingCentralCredentials; runtime?: RingCentralClientRuntime }): Promise<unknown> {
  return fixedRead('/restapi/v1.0/account/~/extension/~', emptyQuery(), options);
}

export function listRingCentralExtensions(
  input: RingCentralListOptions & { status?: 'Enabled' | 'Disabled' | 'NotActivated' } = {},
  options?: { credentials?: RingCentralCredentials; runtime?: RingCentralClientRuntime },
): Promise<unknown> {
  const query = new URLSearchParams({
    page: String(boundedInteger(input.page, 1, 100, 'page')),
    perPage: String(boundedInteger(input.perPage, 50, 200, 'perPage')),
  });
  if (input.status) query.set('status', input.status);
  return fixedRead('/restapi/v1.0/account/~/extension', query, options);
}

export function listRingCentralPhoneNumbers(
  input: RingCentralListOptions = {},
  options?: { credentials?: RingCentralCredentials; runtime?: RingCentralClientRuntime },
): Promise<unknown> {
  const query = new URLSearchParams({
    page: String(boundedInteger(input.page, 1, 100, 'page')),
    perPage: String(boundedInteger(input.perPage, 50, 200, 'perPage')),
  });
  return fixedRead('/restapi/v1.0/account/~/phone-number', query, options);
}

export function listRingCentralCalls(
  input: RingCentralCallListOptions = {},
  options: { credentials?: RingCentralCredentials; runtime?: RingCentralClientRuntime } = {},
): Promise<unknown> {
  const now = (options.runtime?.now ?? Date.now)();
  const dateToMs = input.dateTo === undefined ? now : Date.parse(input.dateTo);
  const dateFromMs = input.dateFrom === undefined ? dateToMs - 7 * 24 * 60 * 60_000 : Date.parse(input.dateFrom);
  if (!Number.isFinite(dateFromMs) || !Number.isFinite(dateToMs) || dateFromMs > dateToMs || dateToMs - dateFromMs > MAX_CALL_RANGE_MS) {
    throw new RingCentralClientError('Call-log dates must be valid ISO timestamps spanning no more than 90 days.', 'request_failed');
  }
  const query = new URLSearchParams({
    dateFrom: new Date(dateFromMs).toISOString(),
    dateTo: new Date(dateToMs).toISOString(),
    view: 'Detailed',
    page: String(boundedInteger(input.page, 1, 100, 'page')),
    perPage: String(boundedInteger(input.perPage, 50, 100, 'perPage')),
  });
  if (input.direction) query.set('direction', input.direction);
  if (input.recordingOnly) query.set('recordingType', 'All');
  if (input.phoneNumber !== undefined) {
    const phone = input.phoneNumber.trim();
    if (!/^\+?[0-9*#(). -]{3,40}$/.test(phone)) {
      throw new RingCentralClientError('phoneNumber has an invalid format.', 'request_failed');
    }
    query.set('phoneNumber', phone);
  }
  return fixedRead('/restapi/v1.0/account/~/call-log', query, options);
}

export function getRingCentralCall(
  id: string,
  options?: { credentials?: RingCentralCredentials; runtime?: RingCentralClientRuntime },
): Promise<unknown> {
  return fixedRead(`/restapi/v1.0/account/~/call-log/${safeId(id, 'Call ID')}`, emptyQuery(), options);
}

export function getRingCentralRecording(
  id: string,
  options?: { credentials?: RingCentralCredentials; runtime?: RingCentralClientRuntime },
): Promise<unknown> {
  return fixedRead(`/restapi/v1.0/account/~/recording/${safeId(id, 'Recording ID')}`, emptyQuery(), options);
}

export async function testRingCentralConnection(
  credentials: RingCentralCredentials,
  runtimeOverrides?: RingCentralClientRuntime,
): Promise<RingCentralHealthResult> {
  const rt = runtime(runtimeOverrides);
  const started = rt.now();
  let tokenMs: number | null = null;
  try {
    const cfg = config(credentials);
    await accessToken(cfg, rt);
    tokenMs = Math.max(0, rt.now() - started);
    const readStarted = rt.now();
    await getRingCentralAccount({ credentials, runtime: runtimeOverrides });
    const queryMs = Math.max(0, rt.now() - readStarted);
    return { ok: true, status: 'connected', error: null, timeoutStage: null, timings: { tokenMs, queryMs, totalMs: Math.max(0, rt.now() - started) } };
  } catch (err) {
    const safe = err instanceof RingCentralClientError ? err : new RingCentralClientError('RingCentral connection testing failed unexpectedly.', 'request_failed');
    return {
      ok: false,
      status: 'error',
      error: safe.message,
      timeoutStage: safe.timeoutStage ?? null,
      timings: { tokenMs, queryMs: null, totalMs: Math.max(0, rt.now() - started) },
    };
  }
}
