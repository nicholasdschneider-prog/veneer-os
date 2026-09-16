import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import Database from 'better-sqlite3';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import type { AppContext } from '../src/context.js';
import type { UserRow } from '../src/db/db.js';
import { createConnectorsRouter } from '../src/routes/connectors.js';
import {
  composioSessionOptions,
  parseGoogleAnalyticsAccounts,
  sanitizeComposioIdentity,
  type ComposioConnectorDetails,
} from '../src/connectors/composio.js';
import type { NetSuiteCredentials, NetSuiteHealthResult } from '../src/connectors/netsuite/nsClient.js';
import type { RingCentralCredentials, RingCentralHealthResult } from '../src/connectors/ringcentral/client.js';
import type { PaperHealthResult } from '../src/connectors/paper/health.js';
import {
  GMAIL_FULL_V2_TOOLS,
  GMAIL_MANAGED_DEFAULT_V2_SCOPES,
  GMAIL_READ_ONLY_V2_TOOLS,
  HUBSPOT_FULL_V1_TOOLS,
  HUBSPOT_MANAGED_DEFAULT_V1_SCOPES,
  HUBSPOT_READ_ONLY_V1_TOOLS,
  GOOGLE_ADS_FULL_V1_TOOLS,
  GOOGLE_ADS_MANAGED_DEFAULT_V1_SCOPES,
  GOOGLE_ADS_READ_ONLY_V1_TOOLS,
  GOOGLE_ANALYTICS_FULL_V1_TOOLS,
  GOOGLE_ANALYTICS_MANAGED_DEFAULT_V1_SCOPES,
  GOOGLE_ANALYTICS_READ_ONLY_V1_TOOLS,
  GOOGLE_DOCS_FULL_V1_TOOLS,
  GOOGLE_DOCS_MANAGED_DEFAULT_V1_SCOPES,
  GOOGLE_DOCS_READ_ONLY_V1_TOOLS,
  GOOGLE_DRIVE_FULL_V1_TOOLS,
  GOOGLE_DRIVE_MANAGED_DEFAULT_V1_SCOPES,
  GOOGLE_DRIVE_READ_ONLY_V1_TOOLS,
  GOOGLE_SHEETS_FULL_V1_TOOLS,
  GOOGLE_SHEETS_MANAGED_DEFAULT_V1_SCOPES,
  GOOGLE_SHEETS_READ_ONLY_V1_TOOLS,
  QUICKBOOKS_FULL_V1_TOOLS,
  QUICKBOOKS_MANAGED_DEFAULT_V1_SCOPES,
  QUICKBOOKS_READ_ONLY_V1_TOOLS,
} from '../src/connectors/accessModes.js';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/db/migrations');
const USER: UserRow = {
  id: 1,
  email: 'user@example.com',
  display_name: 'User',
  role: 'owner',
  created_at: '',
};

let db: Database.Database;
let server: Server;
let base: string;
let ctx: AppContext;
let detailsCalls = 0;
let nowMs = Date.parse('2026-07-22T19:00:00Z');
let detailsResponse: ComposioConnectorDetails;
let remoteStatus = 'INITIATED';
let nextComposioInstall = 0;
let startRequests: any[][] = [];
let authConfigRequests: any[][] = [];
let deletedAccounts: string[] = [];
let netSuiteHealthCalls: NetSuiteCredentials[] = [];
let netSuiteHealth: NetSuiteHealthResult;
let ringCentralHealthCalls: RingCentralCredentials[] = [];
let ringCentralHealth: RingCentralHealthResult;
let paperHealthCalls: string[] = [];
let paperHealth: PaperHealthResult;

beforeAll(async () => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db, MIGRATIONS);
  db.prepare('INSERT INTO users (id, email, display_name, role) VALUES (?, ?, ?, ?)').run(
    USER.id,
    USER.email,
    USER.display_name,
    USER.role,
  );
  ctx = {
    db,
    config: {
      composioApiKey: 'composio-test-key',
    },
    secrets: { getApiKeyOverride: () => null },
  } as AppContext;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = USER;
    next();
  });
  app.use('/api/connectors', createConnectorsRouter(ctx, {
    now: () => nowMs,
    getComposioConnectorDetails: async (_apiKey, _config, toolkit) => {
      detailsCalls += 1;
      return { ...detailsResponse, toolkit };
    },
    createComposioManagedAuthConfig: async (...args) => {
      authConfigRequests.push(args);
      return `auth-${authConfigRequests.length}`;
    },
    validateComposioManagedAuthConfig: async () => true,
    startComposioInstall: async (...args) => {
      startRequests.push(args);
      nextComposioInstall += 1;
      return {
        sessionId: `session-${nextComposioInstall}`,
        connectedAccountId: `ca-${nextComposioInstall}`,
        redirectUrl: `https://connect.example.test/${nextComposioInstall}`,
        alreadyActive: false,
        mcp: {
          type: 'http' as const,
          url: `https://mcp.example.test/${nextComposioInstall}`,
          headers: { Authorization: 'secret-mcp-token' },
        },
      };
    },
    composioAccountStatus: async () => remoteStatus,
    deleteComposioAccount: async (_apiKey, accountId) => {
      deletedAccounts.push(accountId);
    },
    testNetSuiteConnection: async (credentials) => {
      netSuiteHealthCalls.push(credentials);
      return netSuiteHealth;
    },
    testRingCentralConnection: async (credentials) => {
      ringCentralHealthCalls.push(credentials);
      return ringCentralHealth;
    },
    testPaperConnection: async (url) => {
      paperHealthCalls.push(url);
      return paperHealth;
    },
  }));
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
  db.close();
});

beforeEach(() => {
  db.prepare('DELETE FROM user_connectors').run();
  db.prepare('DELETE FROM connector_auth_configs').run();
  ctx.config.composioApiKey = 'composio-test-key';
  ctx.doppler = { get: () => null } as AppContext['doppler'];
  detailsCalls = 0;
  remoteStatus = 'INITIATED';
  nextComposioInstall = 0;
  startRequests = [];
  authConfigRequests = [];
  deletedAccounts = [];
  netSuiteHealthCalls = [];
  netSuiteHealth = {
    ok: true,
    status: 'connected',
    error: null,
    timeoutStage: null,
    timings: { tokenMs: 120, queryMs: 240, totalMs: 360 },
  };
  ringCentralHealthCalls = [];
  ringCentralHealth = {
    ok: true,
    status: 'connected',
    error: null,
    timeoutStage: null,
    timings: { tokenMs: 80, queryMs: 120, totalMs: 200 },
  };
  paperHealthCalls = [];
  paperHealth = {
    ok: true,
    status: 'connected',
    error: null,
    timeoutStage: null,
    timings: { tokenMs: null, queryMs: null, totalMs: 12 },
  };
  nowMs += 10 * 60_000;
  detailsResponse = {
    provider: 'composio',
    toolkit: 'google_analytics',
    connectionStatus: 'ACTIVE',
    identity: { displayName: 'Test User', email: 'test@example.com' },
    resources: [],
    issues: [],
    fetchedAt: '2026-07-22T19:00:00.000Z',
  };
});

async function call(method: string, url: string, body?: unknown) {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, any> };
}

describe('Composio connector catalog', () => {
  it('lists the reviewed hosted and custom connectors', async () => {
    const result = await call('GET', '/api/connectors');
    const connectors = result.json.connectors as Record<string, unknown>[];
    const googleDrive = connectors.find((c) => c.slug === 'googledrive');
    const googleDocs = connectors.find((c) => c.slug === 'googledocs');
    const googleSheets = connectors.find((c) => c.slug === 'googlesheets');
    const googleAds = connectors.find((c) => c.slug === 'googleads');
    const googleAnalytics = connectors.find((c) => c.slug === 'google_analytics');
    const outlook = connectors.find((c) => c.slug === 'outlook');
    const hubspot = connectors.find((c) => c.slug === 'hubspot');
    const shopify = (result.json.connectors as Record<string, unknown>[]).find((c) => c.slug === 'shopify');
    const quickbooks = connectors.find((c) => c.slug === 'quickbooks');

    expect(connectors.map((connector) => connector.slug)).toEqual([
      'netsuite',
      'ringcentral',
      'paper',
      'gmail',
      'googledrive',
      'googledocs',
      'googlesheets',
      'googleads',
      'google_analytics',
      'outlook',
      'hubspot',
      'shopify',
      'omnisend',
      'quickbooks',
    ]);
    expect(googleDrive).toMatchObject({
      name: 'Google Drive',
      kind: 'composio',
      installs: [],
    });
    expect(googleDocs).toMatchObject({
      name: 'Google Docs',
      kind: 'composio',
      installs: [],
    });
    expect(googleSheets).toMatchObject({
      name: 'Google Sheets',
      kind: 'composio',
      installs: [],
    });
    expect(googleAds).toMatchObject({ name: 'Google Ads', kind: 'composio', installs: [] });
    expect(googleAnalytics).toMatchObject({ name: 'Google Analytics', kind: 'composio', installs: [] });
    expect(outlook).toMatchObject({
      name: 'Outlook',
      kind: 'composio',
      installs: [],
    });
    expect(hubspot).toMatchObject({ name: 'HubSpot', kind: 'composio', installs: [] });
    expect(shopify).toMatchObject({
      name: 'Shopify',
      kind: 'composio',
      installs: [],
    });
    expect(connectors.find((c) => c.slug === 'omnisend')).toMatchObject({
      name: 'Omnisend',
      kind: 'composio',
      installs: [],
    });
    expect(quickbooks).toMatchObject({ name: 'QuickBooks', kind: 'composio', installs: [] });
  });

  it('offers Limited and Full for every connector with a reviewed immutable policy', async () => {
    const result = await call('GET', '/api/connectors');
    const gmail = result.json.connectors.find((connector: any) => connector.slug === 'gmail');
    const googleDrive = result.json.connectors.find((connector: any) => connector.slug === 'googledrive');
    const googleDocs = result.json.connectors.find((connector: any) => connector.slug === 'googledocs');
    const googleSheets = result.json.connectors.find((connector: any) => connector.slug === 'googlesheets');
    const googleAds = result.json.connectors.find((connector: any) => connector.slug === 'googleads');
    const googleAnalytics = result.json.connectors.find((connector: any) => connector.slug === 'google_analytics');
    const quickbooks = result.json.connectors.find((connector: any) => connector.slug === 'quickbooks');
    const hubspot = result.json.connectors.find((connector: any) => connector.slug === 'hubspot');
    const outlook = result.json.connectors.find((connector: any) => connector.slug === 'outlook');

    expect(gmail.accessModes).toEqual([
      expect.objectContaining({ mode: 'read_only', version: 2, label: 'Limited', recommended: true }),
      expect.objectContaining({ mode: 'full', version: 2, label: 'Full', recommended: false }),
    ]);
    expect(googleDrive.accessModes).toEqual([
      expect.objectContaining({ mode: 'read_only', version: 1, label: 'Limited', recommended: true }),
      expect.objectContaining({ mode: 'full', version: 1, label: 'Full', recommended: false }),
    ]);
    for (const connector of [googleDocs, googleSheets, googleAds, googleAnalytics, quickbooks, hubspot]) {
      expect(connector.accessModes).toEqual([
        expect.objectContaining({ mode: 'read_only', version: 1, label: 'Limited', recommended: true }),
        expect.objectContaining({ mode: 'full', version: 1, label: 'Full', recommended: false }),
      ]);
      expect(connector.accessModes[0].providerPermissionNote).toContain('not a provider-level permission limit');
    }
    expect(gmail.accessModes[0].providerPermissionNote).toContain('not a provider-level permission limit');
    expect(googleDrive.accessModes[0].providerPermissionNote).toContain('Composio still receives broad Google permission');
    expect(quickbooks.accessModes[0].providerPermissionNote).toContain('broad QuickBooks accounting permission');
    expect(hubspot.accessModes[0].providerPermissionNote).toContain('broad HubSpot permission');
    expect(hubspot.accessModes[0].providerPermissionNote).toContain('unverified-app warning');
    expect(outlook.accessModes).toEqual([]);
    expect(gmail).not.toHaveProperty('permissionProfiles');
  });

  it('requires an access mode for a new Gmail install', async () => {
    const result = await call('POST', '/api/connectors/gmail/install', {});
    expect(result.status).toBe(400);
    expect(result.json.error).toContain('Limited or Full');
    expect(startRequests).toEqual([]);
  });

  it('starts Gmail Limited v2 with managed-default scopes and exact tools', async () => {
    const result = await call('POST', '/api/connectors/gmail/install', { accessMode: 'read_only' });
    expect(result.status).toBe(200);
    expect(result.json.redirectUrl).toContain('connect.example.test');
    expect(authConfigRequests[0]).toEqual([
      'composio-test-key',
      'gmail',
      'Veneer Pro / Gmail / Limited / v2',
      {
        oauthScopeStrategy: 'managed_default',
        expectedScopes: GMAIL_MANAGED_DEFAULT_V2_SCOPES,
        toolSlugs: GMAIL_READ_ONLY_V2_TOOLS,
      },
    ]);
    expect(startRequests[0]).toEqual([
      'composio-test-key',
      USER.email,
      'gmail',
      expect.stringContaining('/#/settings/connectors?connected=gmail'),
      { authConfigId: 'auth-1', toolSlugs: GMAIL_READ_ONLY_V2_TOOLS },
    ]);

    const row = db.prepare("SELECT * FROM user_connectors WHERE connector_slug = 'gmail'").get() as any;
    const config = JSON.parse(row.config_json);
    expect(row).toMatchObject({ status: 'pending', access_mode: 'read_only', access_version: 2 });
    expect(config).not.toHaveProperty('accessMode');
    expect(config).not.toHaveProperty('settings');
    const snapshot = db.prepare(
      `SELECT access_mode, access_version, toolkit_version, oauth_scope_strategy, oauth_scopes_json, tool_slugs_json
         FROM connector_auth_configs WHERE connector_slug = 'gmail'`,
    ).get() as any;
    expect(snapshot).toMatchObject({
      access_mode: 'read_only',
      access_version: 2,
      toolkit_version: '20260721_00',
      oauth_scope_strategy: 'managed_default',
    });
    expect(JSON.parse(snapshot.oauth_scopes_json)).toEqual(GMAIL_MANAGED_DEFAULT_V2_SCOPES);
    expect(JSON.parse(snapshot.tool_slugs_json)).toEqual(GMAIL_READ_ONLY_V2_TOOLS);

    const listed = await call('GET', '/api/connectors');
    const install = listed.json.connectors.find((connector: any) => connector.slug === 'gmail').installs[0];
    expect(install.accessMode).toMatchObject({ mode: 'read_only', version: 2, label: 'Limited' });
    expect(install.accessMode.providerPermissionNote).toContain('broad Google permission');
    expect(JSON.stringify(listed.json)).not.toContain('secret-mcp-token');
  });

  it('starts Gmail Full v2 with the 55 managed-auth-supported tools', async () => {
    const result = await call('POST', '/api/connectors/gmail/install', { accessMode: 'full' });
    expect(result.status).toBe(200);
    expect(authConfigRequests[0]?.[3]).toEqual({
      oauthScopeStrategy: 'managed_default',
      expectedScopes: GMAIL_MANAGED_DEFAULT_V2_SCOPES,
      toolSlugs: GMAIL_FULL_V2_TOOLS,
    });
    expect(startRequests[0]?.[4]).toEqual({ authConfigId: 'auth-1', toolSlugs: GMAIL_FULL_V2_TOOLS });
    expect(startRequests[0]?.[4].toolSlugs).toHaveLength(55);
    expect(startRequests[0]?.[4].toolSlugs).not.toContain('GMAIL_CREATE_PROMPT_POST');
    expect(startRequests[0]?.[4].toolSlugs).not.toContain('GMAIL_UPDATE_USER_ATTRIBUTES_VALUES');
    expect(startRequests[0]?.[4].toolSlugs).not.toContain('GMAIL_UPDATE_VACATION_SETTINGS');
  });

  it('moves a failed Gmail v1 retry to v2 and removes the replaced pending account', async () => {
    const oldConfig = JSON.stringify({
      sessionId: 'session-v1',
      connectedAccountId: 'ca-v1-blocked',
      composioUserId: USER.email,
      mcp: { type: 'http', url: 'https://mcp.example.test/v1' },
    });
    const inserted = db.prepare(
      `INSERT INTO user_connectors
         (user_id, connector_slug, status, error, config_json, access_mode, access_version)
       VALUES (?, 'gmail', 'error', 'Google blocked the scopes', ?, 'read_only', 1)`,
    ).run(USER.id, oldConfig);

    const result = await call('POST', '/api/connectors/gmail/install', {
      installId: Number(inserted.lastInsertRowid),
    });

    expect(result.status).toBe(200);
    expect(authConfigRequests[0]?.[2]).toBe('Veneer Pro / Gmail / Limited / v2');
    expect(db.prepare('SELECT access_mode, access_version, status FROM user_connectors WHERE id = ?')
      .get(Number(inserted.lastInsertRowid))).toEqual({
        access_mode: 'read_only',
        access_version: 2,
        status: 'pending',
      });
    expect(deletedAccounts).toContain('ca-v1-blocked');
  });

  it('shows old Gmail connections as Existing access', async () => {
    db.prepare(
      `INSERT INTO user_connectors (user_id, connector_slug, status, config_json)
       VALUES (?, 'gmail', 'connected', '{}')`,
    ).run(USER.id);
    const result = await call('GET', '/api/connectors');
    const gmail = result.json.connectors.find((connector: any) => connector.slug === 'gmail');
    expect(gmail.installs[0].accessMode).toMatchObject({ mode: null, version: null, label: 'Existing access' });
  });

  it('keeps the old Gmail session active until an access mode reconnect succeeds', async () => {
    const oldConfig = JSON.stringify({
      sessionId: 'session-old',
      connectedAccountId: 'ca-old',
      composioUserId: USER.email,
      mcp: { type: 'http', url: 'https://mcp.example.test/old' },
    });
    const inserted = db.prepare(
      `INSERT INTO user_connectors (user_id, connector_slug, status, config_json)
       VALUES (?, 'gmail', 'connected', ?)`,
    ).run(USER.id, oldConfig);
    const installId = Number(inserted.lastInsertRowid);

    const started = await call('POST', `/api/connectors/install/${installId}/access-mode`, { accessMode: 'read_only' });
    expect(started.status).toBe(200);
    expect(started.json.status).toBe('pending');
    expect(db.prepare('SELECT config_json, access_mode FROM user_connectors WHERE id = ?').get(installId)).toEqual({
      config_json: oldConfig,
      access_mode: null,
    });
    expect(db.prepare('SELECT access_mode, status FROM connector_access_changes WHERE connector_id = ?').get(installId)).toEqual({
      access_mode: 'read_only',
      status: 'pending',
    });

    remoteStatus = 'ACTIVE';
    const finished = await call('GET', `/api/connectors/install/${installId}/access-mode/status`);
    expect(finished.json.status).toBe('connected');
    const row = db.prepare('SELECT config_json, access_mode, access_version FROM user_connectors WHERE id = ?').get(installId) as any;
    expect(row.access_mode).toBe('read_only');
    expect(row.access_version).toBe(2);
    expect(JSON.parse(row.config_json).connectedAccountId).toBe('ca-1');
    expect(db.prepare('SELECT 1 FROM connector_access_changes WHERE connector_id = ?').get(installId)).toBeUndefined();
    expect(deletedAccounts).toContain('ca-old');
  });

  it('allows a connected Gmail v1 mode to reconnect to the same mode at v2', async () => {
    const oldConfig = JSON.stringify({
      sessionId: 'session-v1',
      connectedAccountId: 'ca-v1',
      composioUserId: USER.email,
      mcp: { type: 'http', url: 'https://mcp.example.test/v1' },
    });
    const inserted = db.prepare(
      `INSERT INTO user_connectors
         (user_id, connector_slug, status, config_json, access_mode, access_version)
       VALUES (?, 'gmail', 'connected', ?, 'read_only', 1)`,
    ).run(USER.id, oldConfig);
    const installId = Number(inserted.lastInsertRowid);

    const started = await call('POST', `/api/connectors/install/${installId}/access-mode`, { accessMode: 'read_only' });

    expect(started.status).toBe(200);
    expect(db.prepare(
      'SELECT access_mode, access_version FROM connector_access_changes WHERE connector_id = ?',
    ).get(installId)).toEqual({ access_mode: 'read_only', access_version: 2 });
    expect(db.prepare('SELECT config_json, access_version FROM user_connectors WHERE id = ?').get(installId)).toEqual({
      config_json: oldConfig,
      access_version: 1,
    });
  });

  it('keeps the old Gmail session when a mode reconnect fails or is cancelled', async () => {
    const oldConfig = JSON.stringify({
      sessionId: 'session-old',
      connectedAccountId: 'ca-old',
      composioUserId: USER.email,
      mcp: { type: 'http', url: 'https://mcp.example.test/old' },
    });
    const inserted = db.prepare(
      `INSERT INTO user_connectors (user_id, connector_slug, status, config_json)
       VALUES (?, 'gmail', 'connected', ?)`,
    ).run(USER.id, oldConfig);
    const installId = Number(inserted.lastInsertRowid);

    await call('POST', `/api/connectors/install/${installId}/access-mode`, { accessMode: 'full' });
    remoteStatus = 'FAILED';
    const failed = await call('GET', `/api/connectors/install/${installId}/access-mode/status`);
    expect(failed.json).toMatchObject({ status: 'error', error: expect.stringContaining('existing access is unchanged') });
    expect(db.prepare('SELECT config_json, access_mode FROM user_connectors WHERE id = ?').get(installId)).toEqual({
      config_json: oldConfig,
      access_mode: null,
    });

    const cancelled = await call('POST', `/api/connectors/install/${installId}/access-mode/cancel`);
    expect(cancelled.status).toBe(200);
    expect(db.prepare('SELECT 1 FROM connector_access_changes WHERE connector_id = ?').get(installId)).toBeUndefined();
    expect(deletedAccounts).toContain('ca-1');
    expect(deletedAccounts).not.toContain('ca-old');
  });

  it('starts Outlook with the Outlook Composio toolkit', async () => {
    const result = await call('POST', '/api/connectors/outlook/install', {});
    expect(result.status).toBe(200);
    expect(result.json.redirectUrl).toContain('connect.example.test');
    expect(startRequests[0]).toEqual([
      'composio-test-key',
      USER.email,
      'outlook',
      expect.stringContaining('/#/settings/connectors?connected=outlook'),
    ]);
  });

  it('requires an access mode for a new Google Drive install', async () => {
    const result = await call('POST', '/api/connectors/googledrive/install', {});
    expect(result.status).toBe(400);
    expect(result.json.error).toContain('Limited or Full');
    expect(startRequests).toEqual([]);
  });

  it('starts Google Drive Limited with its managed scope snapshot and 29 tools', async () => {
    const result = await call('POST', '/api/connectors/googledrive/install', { accessMode: 'read_only' });
    expect(result.status).toBe(200);
    expect(result.json.redirectUrl).toContain('connect.example.test');
    expect(authConfigRequests[0]).toEqual([
      'composio-test-key',
      'googledrive',
      'Veneer Pro / Google Drive / Limited / v1',
      {
        oauthScopeStrategy: 'managed_default',
        expectedScopes: GOOGLE_DRIVE_MANAGED_DEFAULT_V1_SCOPES,
        toolSlugs: GOOGLE_DRIVE_READ_ONLY_V1_TOOLS,
      },
    ]);
    expect(startRequests[0]).toEqual([
      'composio-test-key',
      USER.email,
      'googledrive',
      expect.stringContaining('/#/settings/connectors?connected=googledrive'),
      { authConfigId: 'auth-1', toolSlugs: GOOGLE_DRIVE_READ_ONLY_V1_TOOLS },
    ]);
    expect(startRequests[0][4].toolSlugs).toHaveLength(29);
  });

  it('starts Google Drive Full with all 77 reviewed tools', async () => {
    const result = await call('POST', '/api/connectors/googledrive/install', { accessMode: 'full' });
    expect(result.status).toBe(200);
    expect(authConfigRequests[0]?.[3]).toEqual({
      oauthScopeStrategy: 'managed_default',
      expectedScopes: GOOGLE_DRIVE_MANAGED_DEFAULT_V1_SCOPES,
      toolSlugs: GOOGLE_DRIVE_FULL_V1_TOOLS,
    });
    expect(startRequests[0]?.[4]).toEqual({ authConfigId: 'auth-1', toolSlugs: GOOGLE_DRIVE_FULL_V1_TOOLS });
    expect(startRequests[0]?.[4].toolSlugs).toHaveLength(77);
  });

  it('shows an existing Google Drive connection as Existing access until reconnect', async () => {
    db.prepare(
      `INSERT INTO user_connectors (user_id, connector_slug, status, config_json)
       VALUES (?, 'googledrive', 'connected', '{}')`,
    ).run(USER.id);
    const result = await call('GET', '/api/connectors');
    const googleDrive = result.json.connectors.find((connector: any) => connector.slug === 'googledrive');
    expect(googleDrive.installs[0].accessMode).toMatchObject({
      mode: null,
      version: null,
      label: 'Existing access',
    });
  });

  it.each(['googledocs', 'googlesheets'])('requires an access mode for a new %s install', async (slug) => {
    const result = await call('POST', `/api/connectors/${slug}/install`, {});
    expect(result.status).toBe(400);
    expect(result.json.error).toContain('Limited or Full');
    expect(startRequests).toEqual([]);
  });

  it('starts Google Docs Limited with its managed scope snapshot and 5 tools', async () => {
    const result = await call('POST', '/api/connectors/googledocs/install', { accessMode: 'read_only' });
    expect(result.status).toBe(200);
    expect(authConfigRequests[0]).toEqual([
      'composio-test-key',
      'googledocs',
      'Veneer Pro / Google Docs / Limited / v1',
      {
        oauthScopeStrategy: 'managed_default',
        expectedScopes: GOOGLE_DOCS_MANAGED_DEFAULT_V1_SCOPES,
        toolSlugs: GOOGLE_DOCS_READ_ONLY_V1_TOOLS,
      },
    ]);
    expect(startRequests[0]).toEqual([
      'composio-test-key',
      USER.email,
      'googledocs',
      expect.stringContaining('/#/settings/connectors?connected=googledocs'),
      { authConfigId: 'auth-1', toolSlugs: GOOGLE_DOCS_READ_ONLY_V1_TOOLS },
    ]);
    expect(startRequests[0][4].toolSlugs).toHaveLength(5);
    expect(db.prepare(
      "SELECT connector_slug, access_mode, access_version, status FROM user_connectors WHERE connector_slug = 'googledocs'",
    ).get()).toEqual({ connector_slug: 'googledocs', access_mode: 'read_only', access_version: 1, status: 'pending' });
    expect(db.prepare(
      "SELECT connector_slug, toolkit_version, oauth_scope_strategy FROM connector_auth_configs WHERE connector_slug = 'googledocs'",
    ).get()).toEqual({
      connector_slug: 'googledocs',
      toolkit_version: '20260721_00',
      oauth_scope_strategy: 'managed_default',
    });
  });

  it('starts Google Docs Full with the 40 reviewed supported tools', async () => {
    const result = await call('POST', '/api/connectors/googledocs/install', { accessMode: 'full' });
    expect(result.status).toBe(200);
    expect(authConfigRequests[0]?.[3]).toEqual({
      oauthScopeStrategy: 'managed_default',
      expectedScopes: GOOGLE_DOCS_MANAGED_DEFAULT_V1_SCOPES,
      toolSlugs: GOOGLE_DOCS_FULL_V1_TOOLS,
    });
    expect(startRequests[0]?.[4]).toEqual({ authConfigId: 'auth-1', toolSlugs: GOOGLE_DOCS_FULL_V1_TOOLS });
    expect(startRequests[0]?.[4].toolSlugs).toHaveLength(40);
    expect(startRequests[0]?.[4].toolSlugs).not.toContain('GOOGLEDOCS_CREATE_DOCUMENT2');
    expect(startRequests[0]?.[4].toolSlugs).not.toContain('GOOGLEDOCS_UPDATE_DOCUMENT_BATCH');
    expect(startRequests[0]?.[4].toolSlugs).not.toContain('GOOGLEDOCS_LIST_SPREADSHEET_CHARTS');
  });

  it('starts Google Sheets Limited with its managed scope snapshot and 13 tools', async () => {
    const result = await call('POST', '/api/connectors/googlesheets/install', { accessMode: 'read_only' });
    expect(result.status).toBe(200);
    expect(authConfigRequests[0]).toEqual([
      'composio-test-key',
      'googlesheets',
      'Veneer Pro / Google Sheets / Limited / v1',
      {
        oauthScopeStrategy: 'managed_default',
        expectedScopes: GOOGLE_SHEETS_MANAGED_DEFAULT_V1_SCOPES,
        toolSlugs: GOOGLE_SHEETS_READ_ONLY_V1_TOOLS,
      },
    ]);
    expect(startRequests[0]).toEqual([
      'composio-test-key',
      USER.email,
      'googlesheets',
      expect.stringContaining('/#/settings/connectors?connected=googlesheets'),
      { authConfigId: 'auth-1', toolSlugs: GOOGLE_SHEETS_READ_ONLY_V1_TOOLS },
    ]);
    expect(startRequests[0][4].toolSlugs).toHaveLength(13);
    expect(db.prepare(
      "SELECT connector_slug, access_mode, access_version, status FROM user_connectors WHERE connector_slug = 'googlesheets'",
    ).get()).toEqual({ connector_slug: 'googlesheets', access_mode: 'read_only', access_version: 1, status: 'pending' });
    expect(db.prepare(
      "SELECT connector_slug, toolkit_version, oauth_scope_strategy FROM connector_auth_configs WHERE connector_slug = 'googlesheets'",
    ).get()).toEqual({
      connector_slug: 'googlesheets',
      toolkit_version: '20260721_00',
      oauth_scope_strategy: 'managed_default',
    });
  });

  it('starts Google Sheets Full with all 45 reviewed active tools', async () => {
    const result = await call('POST', '/api/connectors/googlesheets/install', { accessMode: 'full' });
    expect(result.status).toBe(200);
    expect(authConfigRequests[0]?.[3]).toEqual({
      oauthScopeStrategy: 'managed_default',
      expectedScopes: GOOGLE_SHEETS_MANAGED_DEFAULT_V1_SCOPES,
      toolSlugs: GOOGLE_SHEETS_FULL_V1_TOOLS,
    });
    expect(startRequests[0]?.[4]).toEqual({ authConfigId: 'auth-1', toolSlugs: GOOGLE_SHEETS_FULL_V1_TOOLS });
    expect(startRequests[0]?.[4].toolSlugs).toHaveLength(45);
    for (const deprecated of [
      'GOOGLESHEETS_BATCH_UPDATE',
      'GOOGLESHEETS_EXECUTE_SQL',
      'GOOGLESHEETS_FIND_WORKSHEET_BY_TITLE',
      'GOOGLESHEETS_GET_BATCH_VALUES',
      'GOOGLESHEETS_GET_TABLE_SCHEMA',
      'GOOGLESHEETS_LIST_TABLES',
      'GOOGLESHEETS_QUERY_TABLE',
      'GOOGLESHEETS_SHEET_FROM_JSON',
    ]) expect(startRequests[0]?.[4].toolSlugs).not.toContain(deprecated);
  });

  it.each([
    ['googleads', 'Google Ads', 'read_only', GOOGLE_ADS_MANAGED_DEFAULT_V1_SCOPES, GOOGLE_ADS_READ_ONLY_V1_TOOLS],
    ['googleads', 'Google Ads', 'full', GOOGLE_ADS_MANAGED_DEFAULT_V1_SCOPES, GOOGLE_ADS_FULL_V1_TOOLS],
    ['google_analytics', 'Google Analytics', 'read_only', GOOGLE_ANALYTICS_MANAGED_DEFAULT_V1_SCOPES, GOOGLE_ANALYTICS_READ_ONLY_V1_TOOLS],
    ['google_analytics', 'Google Analytics', 'full', GOOGLE_ANALYTICS_MANAGED_DEFAULT_V1_SCOPES, GOOGLE_ANALYTICS_FULL_V1_TOOLS],
    ['quickbooks', 'QuickBooks', 'read_only', QUICKBOOKS_MANAGED_DEFAULT_V1_SCOPES, QUICKBOOKS_READ_ONLY_V1_TOOLS],
    ['quickbooks', 'QuickBooks', 'full', QUICKBOOKS_MANAGED_DEFAULT_V1_SCOPES, QUICKBOOKS_FULL_V1_TOOLS],
    ['hubspot', 'HubSpot', 'read_only', HUBSPOT_MANAGED_DEFAULT_V1_SCOPES, HUBSPOT_READ_ONLY_V1_TOOLS],
    ['hubspot', 'HubSpot', 'full', HUBSPOT_MANAGED_DEFAULT_V1_SCOPES, HUBSPOT_FULL_V1_TOOLS],
  ] as const)('starts %s %s with its exact managed scope and tool snapshot', async (
    slug,
    name,
    accessMode,
    expectedScopes,
    toolSlugs,
  ) => {
    const result = await call('POST', `/api/connectors/${slug}/install`, { accessMode });
    expect(result.status).toBe(200);
    expect(authConfigRequests[0]).toEqual([
      'composio-test-key',
      slug,
      `Veneer Pro / ${name} / ${accessMode === 'read_only' ? 'Limited' : 'Full'} / v1`,
      {
        oauthScopeStrategy: 'managed_default',
        expectedScopes,
        toolSlugs,
      },
    ]);
    expect(startRequests[0]).toEqual([
      'composio-test-key',
      USER.email,
      slug,
      expect.stringContaining(`connected=${encodeURIComponent(slug)}`),
      { authConfigId: 'auth-1', toolSlugs },
    ]);
    expect(db.prepare(
      'SELECT connector_slug, access_mode, access_version, status FROM user_connectors WHERE connector_slug = ?',
    ).get(slug)).toEqual({ connector_slug: slug, access_mode: accessMode, access_version: 1, status: 'pending' });
  });

  it('keeps existing Docs and Sheets connections as Existing access until reconnect', async () => {
    db.prepare(
      `INSERT INTO user_connectors (user_id, connector_slug, status, config_json)
       VALUES (?, ?, 'connected', '{}')`,
    ).run(USER.id, 'googledocs');
    db.prepare(
      `INSERT INTO user_connectors (user_id, connector_slug, status, config_json)
       VALUES (?, ?, 'connected', '{}')`,
    ).run(USER.id, 'googlesheets');

    const result = await call('GET', '/api/connectors');
    for (const slug of ['googledocs', 'googlesheets']) {
      const connector = result.json.connectors.find((candidate: any) => candidate.slug === slug);
      expect(connector.installs[0].accessMode).toMatchObject({
        mode: null,
        version: null,
        label: 'Existing access',
      });
    }
  });

  it.each(['googledocs', 'googlesheets'])(
    'keeps the existing %s session active while a Limited reconnect is pending',
    async (slug) => {
      const oldConfig = JSON.stringify({
        sessionId: `session-old-${slug}`,
        connectedAccountId: `ca-old-${slug}`,
        composioUserId: USER.email,
        mcp: { type: 'http', url: `https://mcp.example.test/old-${slug}` },
      });
      const inserted = db.prepare(
        `INSERT INTO user_connectors (user_id, connector_slug, status, config_json)
         VALUES (?, ?, 'connected', ?)`,
      ).run(USER.id, slug, oldConfig);
      const installId = Number(inserted.lastInsertRowid);

      const result = await call('POST', `/api/connectors/install/${installId}/access-mode`, {
        accessMode: 'read_only',
      });

      expect(result.status).toBe(200);
      expect(db.prepare(
        'SELECT config_json, access_mode, access_version FROM user_connectors WHERE id = ?',
      ).get(installId)).toEqual({ config_json: oldConfig, access_mode: null, access_version: null });
      expect(db.prepare(
        'SELECT access_mode, access_version, status FROM connector_access_changes WHERE connector_id = ?',
      ).get(installId)).toEqual({ access_mode: 'read_only', access_version: 1, status: 'pending' });
      expect(startRequests[0]?.[2]).toBe(slug);
    },
  );

  it('loads safe account details on demand and caches provider calls', async () => {
    detailsResponse.resources = [
      {
        kind: 'googleAnalytics',
        status: 'ready',
        accounts: [
          {
            id: 'accounts/24495821',
            name: 'Acme Store',
            properties: [{ id: 'properties/324840005', name: 'Acme Store - GA4', canEdit: true }],
          },
        ],
        truncated: false,
      },
    ];
    const config = JSON.stringify({
      sessionId: 'session-test',
      connectedAccountId: 'ca-test',
      composioUserId: USER.email,
      mcp: { type: 'http', url: 'https://mcp.example.test', headers: { Authorization: 'secret-token' } },
    });
    const install = db
      .prepare("INSERT INTO user_connectors (user_id, connector_slug, status, config_json) VALUES (?, 'gmail', 'connected', ?)")
      .run(USER.id, config);
    const url = `/api/connectors/install/${Number(install.lastInsertRowid)}/details`;

    const first = await call('GET', url);
    const second = await call('GET', url);

    expect(first.status).toBe(200);
    expect(first.json.details).toMatchObject({
      identity: { displayName: 'Test User', email: 'test@example.com' },
      resources: [{ accounts: [{ id: 'accounts/24495821' }] }],
    });
    expect(detailsCalls).toBe(1);
    expect(second.json).toEqual(first.json);
    expect(JSON.stringify(first.json)).not.toContain('secret-token');
    expect(JSON.stringify(first.json)).not.toContain('session-test');
    expect(JSON.stringify(first.json)).not.toContain('ca-test');

    await call('GET', `${url}?refresh=1`);
    expect(detailsCalls).toBe(1);
    nowMs += 31_000;
    await call('GET', `${url}?refresh=1`);
    expect(detailsCalls).toBe(2);
  });

  it('does not offer Composio details for non-Composio installs', async () => {
    const install = db
      .prepare("INSERT INTO user_connectors (user_id, connector_slug, status, config_json) VALUES (?, 'netsuite', 'connected', ?)")
      .run(USER.id, JSON.stringify({ settings: {} }));
    const result = await call('GET', `/api/connectors/install/${Number(install.lastInsertRowid)}/details`);
    expect(result.status).toBe(400);
    expect(detailsCalls).toBe(0);
  });

});

describe('RingCentral connector routes', () => {
  const settings = {
    serverUrl: 'https://platform.ringcentral.com',
    clientId: 'ringcentral-client-id',
    clientSecret: 'ringcentral-client-secret',
    jwt: 'ringcentral-long-lived-jwt',
  };

  it('verifies and installs a reusable custom connector without echoing settings', async () => {
    const result = await call('POST', '/api/connectors/ringcentral/install', { settings });
    expect(result).toEqual({
      status: 200,
      json: { ok: true, status: 'connected', redirectUrl: null, health: ringCentralHealth },
    });
    expect(ringCentralHealthCalls).toEqual([settings]);
    const listed = await call('GET', '/api/connectors');
    const ringcentral = listed.json.connectors.find((connector: any) => connector.slug === 'ringcentral');
    expect(ringcentral).toMatchObject({ name: 'RingCentral', kind: 'custom', installs: [{ status: 'connected' }] });
    const response = JSON.stringify(listed.json);
    expect(response).not.toContain(settings.clientId);
    expect(response).not.toContain(settings.clientSecret);
    expect(response).not.toContain(settings.jwt);
  });

  it('rejects an unreviewed server URL without testing or persisting credentials', async () => {
    const result = await call('POST', '/api/connectors/ringcentral/install', {
      settings: { ...settings, serverUrl: 'https://attacker.example' },
    });
    expect(result.status).toBe(400);
    expect(result.json.error).toContain('server URL');
    expect(ringCentralHealthCalls).toEqual([]);
    expect(db.prepare("SELECT 1 FROM user_connectors WHERE connector_slug = 'ringcentral'").get()).toBeUndefined();
  });

  it('keeps a sanitized error row and supports a repeatable data-free health check', async () => {
    ringCentralHealth = {
      ok: false,
      status: 'error',
      error: 'RingCentral authentication was rejected. Check the server-to-server JWT credentials.',
      timeoutStage: null,
      timings: { tokenMs: null, queryMs: null, totalMs: 90 },
    };
    const failed = await call('POST', '/api/connectors/ringcentral/install', { settings });
    expect(failed.status).toBe(502);
    expect(failed.json).toMatchObject({ ok: false, installId: expect.any(Number), health: { status: 'error' } });
    expect(JSON.stringify(failed.json)).not.toContain(settings.clientSecret);
    expect(JSON.stringify(failed.json)).not.toContain(settings.jwt);

    const health = await call('POST', `/api/connectors/install/${failed.json.installId}/test`);
    expect(health).toEqual({ status: 200, json: { ok: true, health: ringCentralHealth } });
    expect(ringCentralHealthCalls).toHaveLength(2);
  });
});

describe('Composio account detail sanitizers', () => {
  it('uses the normal Composio toolkit surface', () => {
    expect(composioSessionOptions('gmail')).toEqual({
      toolkits: ['gmail'],
      mcp: true,
    });
  });

  it('removes Composio bypass tools when an access policy is active', () => {
    expect(composioSessionOptions('gmail', {
      authConfigId: 'auth-read-only',
      toolSlugs: GMAIL_READ_ONLY_V2_TOOLS,
    })).toEqual({
      toolkits: ['gmail'],
      sessionPreset: 'direct_tools',
      authConfigs: { gmail: 'auth-read-only' },
      tools: { gmail: { enable: [...GMAIL_READ_ONLY_V2_TOOLS] } },
      manageConnections: false,
      sandbox: { enable: false, enableProxyExecution: false },
      mcp: true,
    });
  });

  it.each([
    ['googledocs', GOOGLE_DOCS_READ_ONLY_V1_TOOLS],
    ['googlesheets', GOOGLE_SHEETS_READ_ONLY_V1_TOOLS],
    ['hubspot', HUBSPOT_READ_ONLY_V1_TOOLS],
  ] as const)('uses only fixed direct tools for a Limited %s session', (toolkit, toolSlugs) => {
    expect(composioSessionOptions(toolkit, {
      authConfigId: `auth-${toolkit}`,
      toolSlugs,
    })).toEqual({
      toolkits: [toolkit],
      sessionPreset: 'direct_tools',
      authConfigs: { [toolkit]: `auth-${toolkit}` },
      tools: { [toolkit]: { enable: [...toolSlugs] } },
      manageConnections: false,
      sandbox: { enable: false, enableProxyExecution: false },
      mcp: true,
    });
  });

  it('allowlists identity fields and drops credentials and provider IDs', () => {
    const identity = sanitizeComposioIdentity({
      name: 'Sam Rivera (Acme)',
      email: 'owner@example.com',
      sub: 'provider-user-id',
      access_token: 'secret-token',
      picture: 'https://example.com/photo',
    });
    expect(identity).toEqual({ displayName: 'Sam Rivera (Acme)', email: 'owner@example.com' });
    expect(JSON.stringify(identity)).not.toContain('secret');
    expect(JSON.stringify(identity)).not.toContain('provider-user-id');
  });

  it('parses account and property summaries while ignoring unknown fields', () => {
    const parsed = parseGoogleAnalyticsAccounts({
      data: {
        accountSummaries: [
          {
            account: 'accounts/24495821',
            displayName: 'Acme Store',
            credential: 'must-not-pass-through',
            propertySummaries: [
              {
                property: 'properties/324840005',
                displayName: 'Acme Store - GA4',
                canEdit: true,
                internalData: { token: 'secret' },
              },
            ],
          },
          { account: 'accounts/empty', displayName: 'No properties' },
        ],
        nextPageToken: 'next-page',
      },
    });
    expect(parsed).toEqual({
      accounts: [
        {
          id: 'accounts/24495821',
          name: 'Acme Store',
          properties: [{ id: 'properties/324840005', name: 'Acme Store - GA4', canEdit: true }],
        },
        { id: 'accounts/empty', name: 'No properties', properties: [] },
      ],
      nextPageToken: 'next-page',
    });
    expect(JSON.stringify(parsed)).not.toContain('must-not-pass-through');
    expect(JSON.stringify(parsed)).not.toContain('secret');
  });
});

describe('NetSuite connector routes', () => {
  const settings = {
    accountId: '1234567_SB1',
    clientId: 'client-id',
    certId: 'certificate-id',
    privateKey: 'test-private-key',
  };

  it('accepts a normal sandbox account ID', async () => {
    const result = await call('POST', '/api/connectors/netsuite/install', { settings });

    expect(result).toEqual({
      status: 200,
      json: { ok: true, status: 'connected', redirectUrl: null, health: netSuiteHealth },
    });
    expect(netSuiteHealthCalls).toEqual([settings]);
    expect(db.prepare("SELECT status FROM user_connectors WHERE connector_slug = 'netsuite'").get()).toEqual({
      status: 'connected',
    });
  });

  it('rejects an account ID that could alter the NetSuite hostname', async () => {
    const result = await call('POST', '/api/connectors/netsuite/install', {
      settings: { ...settings, accountId: '1234567.attacker.example' },
    });

    expect(result.status).toBe(400);
    expect(result.json.error).toContain('Invalid NetSuite account ID');
    expect(db.prepare("SELECT 1 FROM user_connectors WHERE connector_slug = 'netsuite'").get()).toBeUndefined();
  });

  it('retains an actionable error row when credential verification fails', async () => {
    netSuiteHealth = {
      ok: false,
      status: 'error',
      error: 'NetSuite authentication was rejected. Check the client and certificate credentials.',
      timeoutStage: null,
      timings: { tokenMs: null, queryMs: null, totalMs: 187 },
    };
    const result = await call('POST', '/api/connectors/netsuite/install', { settings });

    expect(result.status).toBe(502);
    expect(result.json).toMatchObject({
      ok: false,
      installId: expect.any(Number),
      error: expect.stringContaining('authentication was rejected'),
      health: {
        status: 'error',
        timings: { tokenMs: null, queryMs: null, totalMs: 187 },
      },
    });
    const row = db.prepare("SELECT status, error FROM user_connectors WHERE connector_slug = 'netsuite'").get();
    expect(row).toEqual({
      status: 'error',
      error: 'NetSuite authentication was rejected. Check the client and certificate credentials.',
    });
    const listed = await call('GET', '/api/connectors');
    expect(JSON.stringify(listed.json)).not.toContain('test-private-key');
    expect(JSON.stringify(listed.json)).not.toContain('client-id');
  });

  it('retains timeout stage and supports a retry with updated credentials', async () => {
    netSuiteHealth = {
      ok: false,
      status: 'error',
      error: 'NetSuite timed out during token acquisition after 8000 ms.',
      timeoutStage: 'token',
      timings: { tokenMs: null, queryMs: null, totalMs: 8_001 },
    };
    const failed = await call('POST', '/api/connectors/netsuite/install', { settings });
    const installId = Number(failed.json.installId);
    expect(failed.status).toBe(502);
    expect(failed.json.health.timeoutStage).toBe('token');

    netSuiteHealth = {
      ok: true,
      status: 'connected',
      error: null,
      timeoutStage: null,
      timings: { tokenMs: 90, queryMs: 110, totalMs: 200 },
    };
    const updated = { ...settings, clientId: 'updated-client-id' };
    const retried = await call('POST', '/api/connectors/netsuite/install', {
      installId,
      settings: updated,
    });
    expect(retried.status).toBe(200);
    expect(netSuiteHealthCalls.at(-1)).toEqual(updated);
    expect(db.prepare('SELECT status, error FROM user_connectors WHERE id = ?').get(installId)).toEqual({
      status: 'connected',
      error: null,
    });
  });

  it('retries a stored failed install without requiring credentials in the response round trip', async () => {
    netSuiteHealth = {
      ok: false,
      status: 'error',
      error: 'NetSuite authentication was rejected. Check the client and certificate credentials.',
      timeoutStage: null,
      timings: { tokenMs: null, queryMs: null, totalMs: 100 },
    };
    const failed = await call('POST', '/api/connectors/netsuite/install', { settings });
    const installId = Number(failed.json.installId);
    netSuiteHealth = {
      ok: true,
      status: 'connected',
      error: null,
      timeoutStage: null,
      timings: { tokenMs: 80, queryMs: 100, totalMs: 180 },
    };

    const retried = await call('POST', '/api/connectors/netsuite/install', { installId });
    expect(retried.status).toBe(200);
    expect(netSuiteHealthCalls.at(-1)).toEqual(settings);
  });

  it('exposes a repeatable data-free connection health path', async () => {
    const installed = await call('POST', '/api/connectors/netsuite/install', { settings });
    const install = db.prepare("SELECT id FROM user_connectors WHERE connector_slug = 'netsuite'").get() as { id: number };
    expect(installed.status).toBe(200);

    const healthy = await call('POST', `/api/connectors/install/${install.id}/test`);
    expect(healthy).toEqual({ status: 200, json: { ok: true, health: netSuiteHealth } });
    expect(JSON.stringify(healthy.json)).not.toContain('test-private-key');
    expect(JSON.stringify(healthy.json)).not.toContain('client-id');

    netSuiteHealth = {
      ok: false,
      status: 'error',
      error: 'NetSuite authenticated, but the assigned role does not allow this read operation.',
      timeoutStage: null,
      timings: { tokenMs: 100, queryMs: 75, totalMs: 175 },
    };
    const unhealthy = await call('POST', `/api/connectors/install/${install.id}/test`);
    expect(unhealthy.status).toBe(200);
    expect(unhealthy.json).toMatchObject({
      ok: true,
      health: {
        ok: false,
        status: 'error',
        error: expect.stringContaining('assigned role'),
        timings: { tokenMs: 100, queryMs: 75, totalMs: 175 },
      },
    });
  });
});

describe('Paper connector', () => {
  it('installs without a health check so the user can open a file afterwards', async () => {
    const result = await call('POST', '/api/connectors/paper/install', { settings: {} });
    expect(result.status).toBe(200);
    expect(result.json).toMatchObject({ ok: true, status: 'connected' });
    // Probing at install time would fail on an idle Paper and strand the install in 'error'.
    expect(paperHealthCalls).toEqual([]);
  });

  it('probes this machine when no URL was configured', async () => {
    await call('POST', '/api/connectors/paper/install', { settings: {} });
    const install = db.prepare("SELECT id FROM user_connectors WHERE connector_slug = 'paper'").get() as { id: number };

    const healthy = await call('POST', `/api/connectors/install/${install.id}/test`);
    expect(healthy).toEqual({ status: 200, json: { ok: true, health: paperHealth } });
    expect(paperHealthCalls).toEqual(['http://127.0.0.1:29979/mcp']);
  });

  it('probes the configured host when Paper runs on another machine', async () => {
    await call('POST', '/api/connectors/paper/install', { settings: { url: 'http://100.78.101.60:29979/mcp' } });
    const install = db.prepare("SELECT id FROM user_connectors WHERE connector_slug = 'paper'").get() as { id: number };

    await call('POST', `/api/connectors/install/${install.id}/test`);
    expect(paperHealthCalls).toEqual(['http://100.78.101.60:29979/mcp']);
  });

  it('surfaces an unreachable Paper as a failed test rather than an API error', async () => {
    await call('POST', '/api/connectors/paper/install', { settings: {} });
    const install = db.prepare("SELECT id FROM user_connectors WHERE connector_slug = 'paper'").get() as { id: number };
    paperHealth = {
      ok: false,
      status: 'error',
      error: 'Nothing answered at http://127.0.0.1:29979/mcp. Open Paper Desktop on that machine, or correct the URL.',
      timeoutStage: null,
      timings: { tokenMs: null, queryMs: null, totalMs: 8 },
    };

    const result = await call('POST', `/api/connectors/install/${install.id}/test`);
    expect(result.status).toBe(200);
    expect(result.json.health).toMatchObject({ ok: false, error: expect.stringContaining('Nothing answered') });
  });

  it('rejects a malformed URL instead of silently falling back to loopback', async () => {
    const result = await call('POST', '/api/connectors/paper/install', { settings: { url: 'not a url' } });
    expect(result.status).toBe(400);
    expect(result.json.error).toMatch(/full Paper MCP URL/);
  });
});
