import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import express, { type Request, type Response, type Router } from 'express';
import type Database from 'better-sqlite3';
import type { AppContext } from '../context.js';
import type { UserConnectorRow } from '../db/db.js';
import type { McpConfig } from '../toolbox/connections.js';

/**
 * Remote MCP servers that sign in with OAuth 2.1 (authorization code + PKCE,
 * dynamic client registration). Tokens never leave this process: a chat's MCP
 * config points at a loopback proxy here with a per-install key, and the proxy
 * adds the current access token. That is what lets a token refreshed mid-turn
 * reach a running chat, and keeps one serialized refresh per install however
 * many chats are calling.
 */

export interface RemoteMcpDef {
  /** The provider's Streamable HTTP MCP endpoint. */
  url: string;
  scope: string;
}
/** user_connectors.config_json for a remote MCP install. The key only opens the loopback proxy. */
export interface RemoteMcpInstallConfig {
  remoteMcp: { proxyKey: string };
}
interface StoredTokens {
  clientId: string;
  tokenEndpoint: string;
  resource: string;
  accessToken: string;
  refreshToken: string | null;
  /** Unix ms after which the access token is treated as expired. */
  expiresAt: number;
}
interface PendingSignIn {
  installId: number;
  userId: number;
  verifier: string;
  clientId: string;
  tokenEndpoint: string;
  resource: string;
  redirectUri: string;
  expiresAt: number;
}
type Fetch = typeof fetch;
type Secrets = Pick<AppContext['secrets'], 'getApiKeyOverride' | 'setApiKeyOverride' | 'clearApiKeyOverride'>;

const PENDING_MS = 15 * 60_000;
const EXPIRY_SKEW_MS = 60_000;
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_BODY_BYTES = 8 * 1024 * 1024;
export const REMOTE_MCP_PROXY_PATH = '/remote-mcp';
export const REMOTE_MCP_CALLBACK_PATH = '/api/connectors/oauth/callback';

const secretId = (installId: number) => `remote-mcp-install-${installId}`;
const b64url = (bytes: Buffer) => bytes.toString('base64url');
function httpsUrl(value: unknown, what: string): string {
  if (typeof value !== 'string') throw new Error(`The provider did not publish its ${what}.`);
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error(`The provider's ${what} is not a secure address.`);
  return url.toString();
}
async function json(fetcher: Fetch, url: string, init?: RequestInit): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetcher(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  let body: Record<string, unknown> = {};
  try { body = (await response.json()) as Record<string, unknown>; } catch { /* a non-JSON error body is reported by status */ }
  return { status: response.status, body };
}

/** RFC 9728 protected resource metadata, then RFC 8414 authorization server metadata. */
export async function discover(fetcher: Fetch, mcpUrl: string) {
  const resourceUrl = new URL(mcpUrl);
  const candidates = [
    `${resourceUrl.origin}/.well-known/oauth-protected-resource${resourceUrl.pathname === '/' ? '' : resourceUrl.pathname}`,
    `${resourceUrl.origin}/.well-known/oauth-protected-resource`,
  ];
  let issuer = resourceUrl.origin;
  let resource = mcpUrl;
  for (const candidate of candidates) {
    const found = await json(fetcher, candidate).catch(() => null);
    const servers = found?.status === 200 ? found.body.authorization_servers : null;
    if (Array.isArray(servers) && typeof servers[0] === 'string') {
      issuer = new URL(httpsUrl(servers[0], 'authorization server')).origin;
      if (typeof found!.body.resource === 'string') resource = found!.body.resource;
      break;
    }
  }
  const metadata = await json(fetcher, `${issuer}/.well-known/oauth-authorization-server`);
  if (metadata.status !== 200) throw new Error('The provider did not publish its sign-in settings.');
  const methods = metadata.body.code_challenge_methods_supported;
  if (!Array.isArray(methods) || !methods.includes('S256')) throw new Error('The provider does not support the required secure sign-in (PKCE).');
  return {
    resource,
    authorizationEndpoint: httpsUrl(metadata.body.authorization_endpoint, 'sign-in page'),
    tokenEndpoint: httpsUrl(metadata.body.token_endpoint, 'token address'),
    registrationEndpoint: httpsUrl(metadata.body.registration_endpoint, 'client registration address'),
  };
}

export function createRemoteMcp(ctx: { db: Database.Database; secrets: Secrets }, fetcher: Fetch = fetch, now: () => number = Date.now) {
  const pending = new Map<string, PendingSignIn>();
  const refreshing = new Map<number, Promise<string>>();

  const read = (installId: number): StoredTokens | null => {
    const raw = ctx.secrets.getApiKeyOverride(secretId(installId));
    if (!raw) return null;
    try { return JSON.parse(raw) as StoredTokens; } catch { return null; }
  };
  const write = (installId: number, tokens: StoredTokens) => ctx.secrets.setApiKeyOverride(secretId(installId), JSON.stringify(tokens));
  const setStatus = (installId: number, status: 'connected' | 'error', error: string | null) =>
    ctx.db.prepare("UPDATE user_connectors SET status=?, error=?, updated_at=datetime('now') WHERE id=?").run(status, error, installId);
  const fromTokenResponse = (body: Record<string, unknown>, base: Pick<StoredTokens, 'clientId' | 'tokenEndpoint' | 'resource'>, previousRefresh: string | null): StoredTokens => {
    if (typeof body.access_token !== 'string' || !body.access_token) throw new Error('The provider returned no access token.');
    const seconds = typeof body.expires_in === 'number' && body.expires_in > 0 ? body.expires_in : 3600;
    return { ...base, accessToken: body.access_token,
      // A provider that rotates refresh tokens returns a new one; otherwise the old one stays valid.
      refreshToken: typeof body.refresh_token === 'string' && body.refresh_token ? body.refresh_token : previousRefresh,
      expiresAt: now() + seconds * 1000 };
  };

  /** One refresh at a time per install, so concurrent chats never race a rotating refresh token. */
  function refresh(installId: number, staleAccessToken: string | null): Promise<string> {
    const running = refreshing.get(installId);
    if (running) return running;
    const job = (async () => {
      const tokens = read(installId);
      if (!tokens) throw new Error('Not signed in.');
      // Another caller already refreshed while this one waited.
      if (staleAccessToken && tokens.accessToken !== staleAccessToken && tokens.expiresAt - EXPIRY_SKEW_MS > now()) return tokens.accessToken;
      if (!tokens.refreshToken) { setStatus(installId, 'error', 'Sign-in expired. Sign in again.'); throw new Error('Sign-in expired.'); }
      const result = await json(fetcher, tokens.tokenEndpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokens.refreshToken, client_id: tokens.clientId, resource: tokens.resource }) });
      if (result.status >= 400 && result.status < 500) {
        // The provider refused the refresh token: only a new sign-in can fix it.
        setStatus(installId, 'error', 'Sign-in expired. Sign in again.');
        throw new Error('Sign-in expired.');
      }
      if (result.status !== 200) throw new Error('The provider could not refresh the sign-in right now.');
      const next = fromTokenResponse(result.body, tokens, tokens.refreshToken);
      write(installId, next);
      return next.accessToken;
    })().finally(() => refreshing.delete(installId));
    refreshing.set(installId, job);
    return job;
  }
  async function accessToken(installId: number): Promise<string> {
    const tokens = read(installId);
    if (!tokens) throw new Error('Not signed in.');
    if (tokens.expiresAt - EXPIRY_SKEW_MS > now()) return tokens.accessToken;
    return refresh(installId, tokens.accessToken);
  }

  return {
    /** Register this install as a public client and return the provider's sign-in address. */
    async begin(def: RemoteMcpDef, install: { id: number; userId: number }, origin: string, clientName: string): Promise<string> {
      const found = await discover(fetcher, def.url);
      const redirectUri = `${origin}${REMOTE_MCP_CALLBACK_PATH}`;
      const registered = await json(fetcher, found.registrationEndpoint, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ client_name: clientName, redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none', scope: def.scope }) });
      if ((registered.status !== 200 && registered.status !== 201) || typeof registered.body.client_id !== 'string') throw new Error('The provider did not accept this app for sign-in.');
      const state = b64url(crypto.randomBytes(32));
      const verifier = b64url(crypto.randomBytes(48));
      for (const [key, value] of pending) if (value.expiresAt < now() || value.installId === install.id) pending.delete(key);
      pending.set(state, { installId: install.id, userId: install.userId, verifier, clientId: registered.body.client_id, tokenEndpoint: found.tokenEndpoint, resource: found.resource, redirectUri, expiresAt: now() + PENDING_MS });
      const url = new URL(found.authorizationEndpoint);
      for (const [key, value] of Object.entries({ response_type: 'code', client_id: registered.body.client_id, redirect_uri: redirectUri, scope: def.scope, state,
        code_challenge: b64url(crypto.createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256', resource: found.resource })) url.searchParams.set(key, value);
      return url.toString();
    },
    /** Finish a sign-in. The state is single use and bound to the person who started it. */
    async complete(state: string, code: string, userId: number): Promise<number> {
      const entry = pending.get(state);
      pending.delete(state);
      if (!entry || entry.expiresAt < now() || entry.userId !== userId) throw new Error('This sign-in link expired or was started by someone else. Start again from Connectors.');
      const result = await json(fetcher, entry.tokenEndpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: entry.redirectUri, client_id: entry.clientId, code_verifier: entry.verifier, resource: entry.resource }) });
      if (result.status !== 200) throw new Error('The provider did not complete the sign-in. Try again.');
      write(entry.installId, fromTokenResponse(result.body, { clientId: entry.clientId, tokenEndpoint: entry.tokenEndpoint, resource: entry.resource }, null));
      setStatus(entry.installId, 'connected', null);
      return entry.installId;
    },
    /** Forget the sign-in. The providers supported so far publish no revocation address. */
    forget(installId: number) {
      ctx.secrets.clearApiKeyOverride(secretId(installId));
      for (const [key, value] of pending) if (value.installId === installId) pending.delete(key);
    },
    signedIn: (installId: number) => read(installId) !== null,
    accessToken,
    /** Send one MCP request upstream with the current token; on 401 refresh once and resend. */
    async forward(installId: number, url: string, init: { method: string; headers: Record<string, string>; body?: Buffer }): Promise<globalThis.Response> {
      const send = (token: string) => fetcher(url, { method: init.method, headers: { ...init.headers, authorization: `Bearer ${token}` }, body: init.body ? new Uint8Array(init.body) : undefined, redirect: 'error' });
      const token = await accessToken(installId);
      const first = await send(token);
      if (first.status !== 401) return first;
      await first.body?.cancel().catch(() => {});
      return send(await refresh(installId, token));
    },
  };
}
export type RemoteMcp = ReturnType<typeof createRemoteMcp>;

export function newRemoteMcpInstallConfig(): RemoteMcpInstallConfig {
  return { remoteMcp: { proxyKey: b64url(crypto.randomBytes(32)) } };
}
/** The chat-side MCP entry: the loopback proxy and its per-install key, never a provider token. */
function proxyKeyOf(install: Pick<UserConnectorRow, 'config_json'>): string | null {
  let key: unknown;
  try { key = (JSON.parse(install.config_json) as Partial<RemoteMcpInstallConfig>).remoteMcp?.proxyKey; } catch { return null; }
  return typeof key === 'string' && key.length >= 32 ? key : null;
}
export function remoteMcpChatConfig(install: Pick<UserConnectorRow, 'id' | 'config_json'>, internalBaseUrl: string): McpConfig | null {
  const key = proxyKeyOf(install);
  if (!key) return null;
  return { transport: 'http', url: `${internalBaseUrl}${REMOTE_MCP_PROXY_PATH}/${install.id}/mcp`, headers: { Authorization: `Bearer ${key}` } };
}

const FORWARDED_REQUEST_HEADERS = ['content-type', 'accept', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id'];
const FORWARDED_RESPONSE_HEADERS = ['content-type', 'mcp-session-id', 'cache-control'];
/**
 * Loopback-only relay for chats. Mounted ahead of the human sign-in gate: the caller is an
 * agent process on this machine holding the install's proxy key, never a browser.
 */
export function createRemoteMcpProxyRouter(ctx: Pick<AppContext, 'db'>, remote: RemoteMcp, urlFor: (slug: string) => string | null): Router {
  const router = express.Router();
  router.all('/:id/mcp', express.raw({ type: () => true, limit: MAX_BODY_BYTES }), (req: Request, res: Response) => {
    res.set('Cache-Control', 'no-store');
    // Anything that arrived through the tunnel carries forwarding headers; only local agents may call.
    const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '');
    if (!local || req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.headers['cf-ray']) { res.status(404).end(); return; }
    const row = ctx.db.prepare("SELECT * FROM user_connectors WHERE id=? AND status='connected'").get(Number(req.params.id)) as UserConnectorRow | undefined;
    const key = row ? proxyKeyOf(row) : null;
    const expected = key ? `Bearer ${key}` : null;
    const given = req.headers.authorization ?? '';
    const upstream = row ? urlFor(row.connector_slug) : null;
    if (!row || !expected || !upstream || given.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected))) {
      res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'This connector is not connected. Ask the person to sign in again under Settings, Connectors.' }, id: null });
      return;
    }
    if (!['GET', 'POST', 'DELETE'].includes(req.method)) { res.status(405).end(); return; }
    const headers: Record<string, string> = {};
    for (const name of FORWARDED_REQUEST_HEADERS) { const value = req.headers[name]; if (typeof value === 'string') headers[name] = value; }
    const body = req.method === 'POST' && Buffer.isBuffer(req.body) ? req.body : undefined;
    void remote.forward(row.id, upstream, { method: req.method, headers, body }).then((response) => {
      res.status(response.status);
      for (const name of FORWARDED_RESPONSE_HEADERS) { const value = response.headers.get(name); if (value) res.set(name, value); }
      if (!response.body) { res.end(); return; }
      const stream = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream);
      res.on('close', () => stream.destroy());
      stream.on('error', () => res.end());
      stream.pipe(res);
    }).catch(() => {
      // Never echo provider or token detail to the chat.
      if (!res.headersSent) res.status(502).json({ jsonrpc: '2.0', error: { code: -32002, message: 'The connector could not be reached or its sign-in expired. Ask the person to check Settings, Connectors.' }, id: null });
      else res.end();
    });
  });
  return router;
}
