import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import Database from 'better-sqlite3';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import type { AppContext } from '../src/context.js';
import type { UserRow } from '../src/db/db.js';
import { createConnectorsRouter } from '../src/routes/connectors.js';
import { connectorDef, connectorMcpConfig } from '../src/connectors/catalog.js';
import { createRemoteMcp, createRemoteMcpProxyRouter, remoteMcpChatConfig, type RemoteMcp } from '../src/connectors/remoteMcp.js';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/db/migrations');
const MCP = 'https://mcp.provider.test/mcp';
const DEF = { url: MCP, scope: 'api:read_write' };

/** A stand-in OAuth provider and MCP server, driven entirely through an injected fetch. */
function provider() {
  const state = { registered: 0, tokenCalls: [] as URLSearchParams[], mcpCalls: [] as { auth: string | null; body: string }[],
    valid: new Set<string>(), refresh: 'r1', n: 0, refuseRefresh: false, refreshDelay: 0 };
  const reply = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  const issue = () => { const access = `a${++state.n}`; state.valid.add(access); state.refresh = `r${state.n + 1}`; return { access_token: access, refresh_token: state.refresh, expires_in: 3600, token_type: 'Bearer' }; };
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/.well-known/oauth-protected-resource/mcp')) return reply(200, { resource: MCP, authorization_servers: ['https://auth.provider.test'] });
    if (url === 'https://auth.provider.test/.well-known/oauth-authorization-server') return reply(200, { authorization_endpoint: 'https://auth.provider.test/authorize', token_endpoint: 'https://auth.provider.test/token', registration_endpoint: 'https://auth.provider.test/register', code_challenge_methods_supported: ['S256'] });
    if (url === 'https://auth.provider.test/register') { state.registered++; return reply(201, { client_id: 'client-1' }); }
    if (url === 'https://auth.provider.test/token') {
      const form = new URLSearchParams(String(init!.body)); state.tokenCalls.push(form);
      if (state.refreshDelay) await new Promise((resolve) => setTimeout(resolve, state.refreshDelay));
      if (form.get('grant_type') === 'authorization_code') return form.get('code') === 'good-code' ? reply(200, issue()) : reply(400, { error: 'invalid_grant' });
      if (state.refuseRefresh || form.get('refresh_token') !== state.refresh) return reply(400, { error: 'invalid_grant' });
      return reply(200, issue());
    }
    if (url === MCP) {
      const auth = new Headers(init!.headers).get('authorization');
      state.mcpCalls.push({ auth, body: init!.body ? Buffer.from(init!.body as Uint8Array).toString() : '' });
      if (!auth || !state.valid.has(auth.replace('Bearer ', ''))) return reply(401, { error: 'unauthorized' }, { 'www-authenticate': 'Bearer' });
      return reply(200, { jsonrpc: '2.0', id: 1, result: { tools: [] } }, { 'mcp-session-id': 'session-1' });
    }
    return reply(404, {});
  }) as typeof fetch;
  return { state, fetcher };
}

describe('remote MCP connectors (OAuth)', () => {
  let db: Database.Database; let store: Map<string, string>; let secrets: AppContext['secrets']; let fake: ReturnType<typeof provider>; let clock: number; let remote: RemoteMcp;
  const install = (status = 'pending') => Number(db.prepare("INSERT INTO user_connectors(user_id,connector_slug,status,config_json) VALUES(1,'runway',?,?)")
    .run(status, JSON.stringify({ remoteMcp: { proxyKey: 'k'.repeat(43) } })).lastInsertRowid);
  const signIn = async (id: number) => { const url = new URL(await remote.begin(DEF, { id, userId: 1 }, 'https://veneer.test', 'Veneer')); await remote.complete(url.searchParams.get('state')!, 'good-code', 1); return url; };
  beforeEach(() => {
    db = new Database(':memory:'); db.pragma('foreign_keys=ON'); migrate(db, MIGRATIONS);
    db.prepare("INSERT INTO users(id,email,display_name,role) VALUES(1,'owner@example.test','Owner','owner'),(2,'other@example.test','Other','member')").run();
    store = new Map();
    secrets = { getApiKeyOverride: (k: string) => store.get(k) ?? null, setApiKeyOverride: (k: string, v: string) => void store.set(k, v), clearApiKeyOverride: (k: string) => void store.delete(k) } as AppContext['secrets'];
    fake = provider(); clock = Date.parse('2026-10-03T12:00:00Z');
    remote = createRemoteMcp({ db, secrets }, fake.fetcher, () => clock);
  });
  afterEach(() => db.close());

  it('discovers, registers and builds a PKCE sign-in address, then stores tokens outside the install row', async () => {
    const id = install();
    const url = new URL(await remote.begin(DEF, { id, userId: 1 }, 'https://veneer.test', 'Veneer'));
    expect(url.origin + url.pathname).toBe('https://auth.provider.test/authorize');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ response_type: 'code', client_id: 'client-1', redirect_uri: 'https://veneer.test/api/connectors/oauth/callback', scope: 'api:read_write', code_challenge_method: 'S256', resource: MCP });
    const state = url.searchParams.get('state')!;
    // Someone else, or a wrong code, cannot finish it; the state is single use either way.
    await expect(remote.complete(state, 'good-code', 2)).rejects.toThrow(/started by someone else/);
    await expect(remote.complete(state, 'good-code', 1)).rejects.toThrow();
    expect(db.prepare('SELECT status FROM user_connectors WHERE id=?').get(id)).toEqual({ status: 'pending' });
    const again = await signIn(id);
    const exchange = fake.state.tokenCalls.at(-1)!;
    expect(exchange.get('grant_type')).toBe('authorization_code');
    expect(crypto.createHash('sha256').update(exchange.get('code_verifier')!).digest('base64url')).toBe(again.searchParams.get('code_challenge'));
    const row = db.prepare('SELECT status,config_json FROM user_connectors WHERE id=?').get(id) as { status: string; config_json: string };
    expect(row.status).toBe('connected');
    expect(row.config_json).not.toMatch(/a1|r2|client-1/);
    expect(await remote.accessToken(id)).toBe('a1');
  });

  it('gives a chat the loopback proxy and its key, never a provider token', async () => {
    const id = install(); await signIn(id);
    const row = db.prepare('SELECT * FROM user_connectors WHERE id=?').get(id) as { id: number; config_json: string };
    expect(remoteMcpChatConfig(row, 'http://127.0.0.1:3100')).toEqual({ transport: 'http', url: `http://127.0.0.1:3100/remote-mcp/${id}/mcp`, headers: { Authorization: `Bearer ${'k'.repeat(43)}` } });
    expect(connectorMcpConfig(connectorDef('runway')!, row.config_json)).toBeNull();
    expect(remoteMcpChatConfig({ id, config_json: '{}' }, 'http://127.0.0.1:3100')).toBeNull();
    expect(connectorDef('runway')).toMatchObject({ kind: 'remote_mcp', remoteMcp: { url: 'https://mcp.runwayml.com/mcp', scope: 'api:read_write' } });
  });

  it('refreshes before expiry with one serialized refresh, and keeps the rotated refresh token', async () => {
    const id = install(); await signIn(id);
    clock += 3600_000; fake.state.refreshDelay = 20;
    const tokens = await Promise.all([remote.accessToken(id), remote.accessToken(id), remote.accessToken(id)]);
    expect(tokens).toEqual(['a2', 'a2', 'a2']);
    expect(fake.state.tokenCalls.filter((c) => c.get('grant_type') === 'refresh_token')).toHaveLength(1);
    clock += 3600_000;
    expect(await remote.accessToken(id)).toBe('a3');
    expect(fake.state.tokenCalls.at(-1)!.get('refresh_token')).toBe('r3');
  });

  it('refreshes once on a 401 and resends, and asks for a new sign-in when the refresh is refused', async () => {
    const id = install(); await signIn(id);
    fake.state.valid.clear(); // the provider revoked the access token early
    const ok = await remote.forward(id, MCP, { method: 'POST', headers: { 'content-type': 'application/json' }, body: Buffer.from('{"id":1}') });
    expect(ok.status).toBe(200);
    expect(fake.state.mcpCalls.map((c) => c.auth)).toEqual(['Bearer a1', 'Bearer a2']);
    expect(fake.state.mcpCalls[1]!.body).toBe('{"id":1}');
    fake.state.valid.clear(); fake.state.refuseRefresh = true;
    await expect(remote.forward(id, MCP, { method: 'POST', headers: {}, body: Buffer.from('{}') })).rejects.toThrow(/expired/);
    expect(db.prepare('SELECT status,error FROM user_connectors WHERE id=?').get(id)).toEqual({ status: 'error', error: 'Sign-in expired. Sign in again.' });
    remote.forget(id); expect(remote.signedIn(id)).toBe(false); expect(store.size).toBe(0);
  });

  describe('over HTTP', () => {
    let server: Server; let base: string;
    const user = (id: number) => db.prepare('SELECT * FROM users WHERE id=?').get(id) as UserRow;
    beforeEach(async () => {
      const ctx = { db, secrets, remoteMcp: remote, config: {}, doppler: { get: () => null } } as unknown as AppContext;
      const app = express();
      app.use('/remote-mcp', createRemoteMcpProxyRouter(ctx, remote, (slug) => (slug === 'runway' ? MCP : null)));
      app.use('/api/connectors', express.json(), (req, _res, next) => { req.user = user(Number(req.headers['x-test-user'] ?? 1)); next(); }, createConnectorsRouter(ctx, { remoteMcp: remote }));
      server = await new Promise<Server>((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    afterEach(() => new Promise<void>((resolve) => server.close(() => resolve())));

    it('installs as pending with a sign-in address, connects on the callback, reconnects after an error and forgets on uninstall', async () => {
      const started = await (await fetch(`${base}/api/connectors/runway/install`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'veneer.test' }, body: '{}' })).json() as { status: string; redirectUrl: string; error?: string };
      expect(started.error).toBeUndefined();
      expect(started.status).toBe('pending');
      const state = new URL(started.redirectUrl).searchParams.get('state')!;
      expect(new URL(started.redirectUrl).searchParams.get('redirect_uri')).toBe('https://veneer.test/api/connectors/oauth/callback');
      const row = () => db.prepare("SELECT id,status FROM user_connectors WHERE connector_slug='runway'").get() as { id: number; status: string };
      expect(row().status).toBe('pending');
      const other = await fetch(`${base}/api/connectors/oauth/callback?state=${state}&code=good-code`, { redirect: 'manual', headers: { 'x-test-user': '2' } });
      expect(other.headers.get('location')).toContain('connectError='); expect(row().status).toBe('pending');
      // That attempt consumed the state, so the owner starts again.
      const retry = await (await fetch(`${base}/api/connectors/runway/install`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ installId: row().id }) })).json() as { redirectUrl: string };
      const done = await fetch(`${base}/api/connectors/oauth/callback?state=${new URL(retry.redirectUrl).searchParams.get('state')}&code=good-code`, { redirect: 'manual' });
      expect(done.status).toBe(302); expect(done.headers.get('location')).toBe('/#/settings/connectors?connected=runway');
      expect(row().status).toBe('connected');
      const listed = await (await fetch(`${base}/api/connectors`)).json() as { connectors: { slug: string; kind: string; installs: unknown[] }[] };
      expect(JSON.stringify(listed)).not.toMatch(/proxyKey|"a1"|Bearer/);
      expect(listed.connectors.find((c) => c.slug === 'runway')).toMatchObject({ kind: 'remote_mcp', installs: [{ status: 'connected' }] });
      await fetch(`${base}/api/connectors/install/${row().id}/uninstall`, { method: 'POST' });
      expect(db.prepare("SELECT count(*) AS n FROM user_connectors WHERE connector_slug='runway'").get()).toEqual({ n: 0 });
      expect(store.size).toBe(0);
    });

    it('relays a chat request with the provider token only for the right key, and never through the tunnel', async () => {
      const id = install(); await signIn(id);
      const call = (headers: Record<string, string>) => fetch(`${base}/remote-mcp/${id}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' });
      expect((await call({ authorization: 'Bearer wrong' })).status).toBe(401);
      expect((await call({})).status).toBe(401);
      expect((await call({ authorization: `Bearer ${'k'.repeat(43)}`, 'cf-connecting-ip': '203.0.113.9' })).status).toBe(404);
      expect(fake.state.mcpCalls).toHaveLength(0);
      const ok = await call({ authorization: `Bearer ${'k'.repeat(43)}` });
      expect(ok.status).toBe(200); expect(ok.headers.get('mcp-session-id')).toBe('session-1');
      expect(await ok.json()).toEqual({ jsonrpc: '2.0', id: 1, result: { tools: [] } });
      expect(fake.state.mcpCalls).toEqual([{ auth: 'Bearer a1', body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' }]);
      db.prepare("UPDATE user_connectors SET status='error' WHERE id=?").run(id);
      expect((await call({ authorization: `Bearer ${'k'.repeat(43)}` })).status).toBe(401);
    });
  });
});
