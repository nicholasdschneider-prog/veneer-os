import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import type { ConnectorAccessChangeRow, UserConnectorRow } from '../db/db.js';
import {
  CONNECTOR_DEFS,
  connectorDef,
  connectorInstallMcpName,
  slugifyLabel,
  type ComposioInstallConfig,
  type ConnectorDef,
} from '../connectors/catalog.js';
import {
  CONNECTOR_ACCESS_MODES,
  connectorAccessModeProfile,
  latestConnectorAccessModeProfiles,
  type ConnectorAccessModeProfile,
} from '../connectors/accessModes.js';
import {
  composioAccountStatus,
  composioErrorMessage,
  createComposioManagedAuthConfig,
  deleteComposioAccount,
  getComposioConnectorDetails,
  startComposioInstall,
  validateComposioManagedAuthConfig,
  type ComposioConnectorDetails,
} from '../connectors/composio.js';
import { effectiveApiKey } from '../secrets/apiKeys.js';
import { connectorProjectIds } from '../connectors/access.js';
import {
  testNetSuiteConnection,
  type NetSuiteCredentials,
  type NetSuiteHealthResult,
} from '../connectors/netsuite/nsClient.js';
import {
  testRingCentralConnection,
  type RingCentralCredentials,
  type RingCentralHealthResult,
} from '../connectors/ringcentral/client.js';
import { resolvePaperMcpUrl } from '../connectors/paper/config.js';
import { testPaperConnection, type PaperHealthResult } from '../connectors/paper/health.js';

/**
 * Connectors API (Settings → Connectors): a code-defined catalog plus
 * installations. Personal installs belong to one user; shared installs are
 * usable by everyone. Project scope is independent, and shared installs are
 * manageable only by admins.
 * Install config (Composio MCP headers / custom settings) is never returned.
 *
 * A connector may be installed more than once (e.g. Gmail "Work" and
 * "Personal"); each install is a row with its own label and materializes as
 * its own MCP server with a stable per-install name.
 */

const InstallSchema = z.object({
  label: z.string().max(40).optional(),
  settings: z.record(z.string().max(200), z.string().max(4000)).optional(),
  sharing: z.enum(['personal', 'shared']).optional(),
  scopeMode: z.enum(['all', 'projects']).optional(),
  projectIds: z.array(z.string().trim().min(1).max(64)).max(100).optional(),
  // Present = retry of an existing pending/error install (keep its id + label).
  installId: z.number().int().positive().optional(),
  accessMode: z.enum(CONNECTOR_ACCESS_MODES).optional(),
});

const AccessSchema = z.object({
  sharing: z.enum(['personal', 'shared']),
  scopeMode: z.enum(['all', 'projects']),
  projectIds: z.array(z.string().trim().min(1).max(64)).max(100),
});

const AccessModeChangeSchema = z.object({
  accessMode: z.enum(CONNECTOR_ACCESS_MODES),
});

type ConnectorAccess = z.infer<typeof AccessSchema>;

const DETAILS_CACHE_TTL_MS = 5 * 60_000;
const DETAILS_FORCE_REFRESH_FLOOR_MS = 30_000;

interface ConnectorDetailsCacheEntry {
  fingerprint: string;
  fetchedAt: number;
  expiresAt: number;
  value?: ComposioConnectorDetails;
  inFlight?: Promise<ComposioConnectorDetails>;
}

/**
 * Custom connectors whose live state a user can probe from Settings. Paper is
 * testable but is NOT health-checked at install time: its endpoint only serves
 * tools while a design file is open, so a fresh install would otherwise land in
 * 'error' before the user has had a chance to open one.
 */
export const TESTABLE_CONNECTOR_SLUGS = ['netsuite', 'ringcentral', 'paper'] as const;
export type TestableConnectorSlug = (typeof TESTABLE_CONNECTOR_SLUGS)[number];
const TESTABLE_CONNECTOR_NAMES: Record<TestableConnectorSlug, string> = {
  netsuite: 'NetSuite',
  ringcentral: 'RingCentral',
  paper: 'Paper',
};

export interface ConnectorsRouterDependencies {
  getComposioConnectorDetails?: typeof getComposioConnectorDetails;
  createComposioManagedAuthConfig?: typeof createComposioManagedAuthConfig;
  startComposioInstall?: typeof startComposioInstall;
  validateComposioManagedAuthConfig?: typeof validateComposioManagedAuthConfig;
  composioAccountStatus?: typeof composioAccountStatus;
  deleteComposioAccount?: typeof deleteComposioAccount;
  testNetSuiteConnection?: (credentials: NetSuiteCredentials) => Promise<NetSuiteHealthResult>;
  testRingCentralConnection?: (credentials: RingCentralCredentials) => Promise<RingCentralHealthResult>;
  testPaperConnection?: (url: string) => Promise<PaperHealthResult>;
  now?: () => number;
}

/** Public origin for OAuth callbacks, from the (Cloudflare-proxied) request. */
function requestOrigin(req: Request): string {
  const proto =
    (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0]?.trim() || req.protocol || 'https';
  const host = (req.headers['x-forwarded-host'] as string | undefined)?.split(',')[0]?.trim() || req.get('host') || '';
  return `${proto}://${host}`;
}

/** One connector def plus the user's installs of it (array; ordered by id). */
function connectorView(
  db: AppContext['db'],
  def: ConnectorDef,
  rows: UserConnectorRow[],
  userId: number,
  isAdmin: boolean,
): Record<string, unknown> {
  return {
    slug: def.slug,
    name: def.name,
    description: def.description,
    kind: def.kind,
    fields: def.fields ?? [],
    accessModes: latestConnectorAccessModeProfiles(def.accessModes).map((profile) => ({
      mode: profile.mode,
      version: profile.version,
      label: profile.label,
      description: profile.description,
      capabilities: profile.capabilities,
      providerPermissionNote: profile.providerPermissionNote,
      recommended: profile.recommended,
    })),
    installs: rows.map((r) => {
      const profile = connectorAccessModeProfile(def.accessModes, r.access_mode, r.access_version);
      const change = db.prepare('SELECT * FROM connector_access_changes WHERE connector_id = ?').get(r.id) as
        | ConnectorAccessChangeRow
        | undefined;
      const target = change
        ? connectorAccessModeProfile(def.accessModes, change.access_mode, change.access_version)
        : null;
      return ({
      id: r.id,
      label: r.label,
      mention: connectorInstallMcpName(def.slug, r.label, r.sharing, r.id),
      status: r.status,
      error: r.error,
      sharing: r.sharing,
      scopeMode: r.scope_mode,
      projects: (
        db
          .prepare(
            `SELECT p.id, p.name
               FROM user_connector_projects cp
               JOIN projects p ON p.id = cp.project_id
              WHERE cp.connector_id = ?
              ORDER BY p.name COLLATE NOCASE, p.id`,
          )
          .all(r.id) as { id: string; name: string }[]
      ),
      ownedByMe: r.user_id === userId,
      canManage: r.sharing === 'shared' ? isAdmin : r.user_id === userId,
      createdAt: r.created_at,
      accessMode: def.accessModes?.length
        ? profile
          ? {
              mode: profile.mode,
              version: profile.version,
              label: profile.label,
              description: profile.description,
              capabilities: profile.capabilities,
              providerPermissionNote: profile.providerPermissionNote,
            }
          : {
              mode: null,
              version: null,
              label: 'Existing access',
              description: 'Reconnect to select and enforce a verified access mode.',
              capabilities: [],
            }
        : null,
      accessChange: change && target
        ? {
            status: change.status,
            error: change.error,
            targetMode: target.mode,
            targetLabel: target.label,
          }
        : null,
    }); }),
  };
}

export function createConnectorsRouter(ctx: AppContext, deps: ConnectorsRouterDependencies = {}): Router {
  const { db } = ctx;
  const router = express.Router();
  const detailsCache = new Map<number, ConnectorDetailsCacheEntry>();
  const loadComposioDetails = deps.getComposioConnectorDetails ?? getComposioConnectorDetails;
  const provisionComposioAuthConfig = deps.createComposioManagedAuthConfig ?? createComposioManagedAuthConfig;
  const beginComposioInstall = deps.startComposioInstall ?? startComposioInstall;
  const validateManagedAuthConfig = deps.validateComposioManagedAuthConfig ?? validateComposioManagedAuthConfig;
  const loadComposioAccountStatus = deps.composioAccountStatus ?? composioAccountStatus;
  const removeComposioAccount = deps.deleteComposioAccount ?? deleteComposioAccount;
  const checkNetSuite = deps.testNetSuiteConnection ?? testNetSuiteConnection;
  const checkRingCentral = deps.testRingCentralConnection ?? testRingCentralConnection;
  const checkPaper = deps.testPaperConnection ?? ((url: string) => testPaperConnection(url));
  const now = deps.now ?? Date.now;

  const composioKey = (): string | null =>
    effectiveApiKey('composio', ctx.secrets, ctx.config, ctx.doppler).value;
  const isAdmin = (req: Request): boolean => req.user!.role === 'owner' || req.user!.role === 'consultant';

  const rowById = (id: number): UserConnectorRow | undefined =>
    db.prepare('SELECT * FROM user_connectors WHERE id = ?').get(id) as UserConnectorRow | undefined;

  const accessChangeFor = (id: number): ConnectorAccessChangeRow | undefined =>
    db.prepare('SELECT * FROM connector_access_changes WHERE connector_id = ?').get(id) as
      | ConnectorAccessChangeRow
      | undefined;

  async function authConfigFor(
    apiKey: string,
    def: ConnectorDef,
    profile: ConnectorAccessModeProfile,
  ): Promise<string> {
    if (!def.composio || !profile.composio) throw new Error('This access mode has no Composio policy.');
    const storedScopes = JSON.stringify(profile.composio.oauthScopes);
    const storedTools = JSON.stringify(profile.composio.toolSlugs);
    const existing = db
      .prepare(
        `SELECT auth_config_id, toolkit_version, oauth_scope_strategy, oauth_scopes_json, tool_slugs_json
           FROM connector_auth_configs
          WHERE connector_slug = ? AND access_mode = ? AND access_version = ?`,
      )
      .get(def.slug, profile.mode, profile.version) as
        | {
            auth_config_id: string;
            toolkit_version: string;
            oauth_scope_strategy: string;
            oauth_scopes_json: string;
            tool_slugs_json: string;
          }
        | undefined;
    const policy = {
      oauthScopeStrategy: profile.composio.oauthScopeStrategy,
      expectedScopes: profile.composio.oauthScopes,
      toolSlugs: profile.composio.toolSlugs,
    };
    if (existing) {
      const localSnapshotMatches =
        existing.toolkit_version === profile.composio.toolkitVersion &&
        existing.oauth_scope_strategy === profile.composio.oauthScopeStrategy &&
        existing.oauth_scopes_json === storedScopes &&
        existing.tool_slugs_json === storedTools;
      const remoteSnapshotMatches = localSnapshotMatches
        ? await validateManagedAuthConfig(
            apiKey,
            existing.auth_config_id,
            def.composio.toolkit,
            policy,
          ).catch(() => false)
        : false;
      if (remoteSnapshotMatches) return existing.auth_config_id;
      db.prepare(
        `DELETE FROM connector_auth_configs
          WHERE connector_slug = ? AND access_mode = ? AND access_version = ?`,
      ).run(def.slug, profile.mode, profile.version);
    }

    const id = await provisionComposioAuthConfig(
      apiKey,
      def.composio.toolkit,
      `Veneer Pro / ${def.name} / ${profile.label} / v${profile.version}`,
      policy,
    );
    db.prepare(
      `INSERT OR IGNORE INTO connector_auth_configs
         (connector_slug, access_mode, access_version, auth_config_id, toolkit_version,
          oauth_scope_strategy, oauth_scopes_json, tool_slugs_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      def.slug,
      profile.mode,
      profile.version,
      id,
      profile.composio.toolkitVersion,
      profile.composio.oauthScopeStrategy,
      storedScopes,
      storedTools,
    );
    return (
      db
        .prepare(
          `SELECT auth_config_id FROM connector_auth_configs
            WHERE connector_slug = ? AND access_mode = ? AND access_version = ?`,
        )
        .get(def.slug, profile.mode, profile.version) as { auth_config_id: string }
    ).auth_config_id;
  }

  function composioInstallConfig(
    start: Awaited<ReturnType<typeof startComposioInstall>>,
    composioUserId: string,
  ): ComposioInstallConfig {
    return {
      sessionId: start.sessionId,
      connectedAccountId: start.connectedAccountId,
      composioUserId,
      mcp: start.mcp,
    };
  }

  const rowsFor = (userId: number, slug: string): UserConnectorRow[] =>
    db
      .prepare('SELECT * FROM user_connectors WHERE user_id = ? AND connector_slug = ? ORDER BY id')
      .all(userId, slug) as UserConnectorRow[];

  function canSee(req: Request, row: UserConnectorRow): boolean {
    return row.user_id === req.user!.id || row.sharing === 'shared';
  }

  function canManage(req: Request, row: UserConnectorRow): boolean {
    return row.sharing === 'shared' ? isAdmin(req) : row.user_id === req.user!.id;
  }

  function resolveAccess(
    req: Request,
    incoming: Partial<ConnectorAccess>,
    fallback?: UserConnectorRow,
  ): ConnectorAccess | null {
    const parsed = AccessSchema.safeParse({
      sharing: incoming.sharing ?? fallback?.sharing ?? 'personal',
      scopeMode: incoming.scopeMode ?? fallback?.scope_mode ?? 'all',
      projectIds: incoming.projectIds ?? (fallback ? connectorProjectIds(db, fallback.id) : []),
    });
    if (!parsed.success) return null;
    const access = { ...parsed.data, projectIds: [...new Set(parsed.data.projectIds)] };
    if (access.sharing === 'shared' && !isAdmin(req)) return null;
    if (access.scopeMode === 'projects' && access.projectIds.length === 0) return null;
    if (access.scopeMode === 'all') access.projectIds = [];
    const found = access.projectIds.length
      ? (db
          .prepare(`SELECT id FROM projects WHERE id IN (${access.projectIds.map(() => '?').join(',')})`)
          .all(...access.projectIds) as { id: string }[])
      : [];
    if (found.length !== access.projectIds.length) return null;
    return access;
  }

  function applyAccess(id: number, access: ConnectorAccess): void {
    const write = db.transaction(() => {
      db.prepare(
        "UPDATE user_connectors SET sharing = ?, scope_mode = ?, updated_at = datetime('now') WHERE id = ?",
      ).run(access.sharing, access.scopeMode, id);
      db.prepare('DELETE FROM user_connector_projects WHERE connector_id = ?').run(id);
      const insert = db.prepare('INSERT INTO user_connector_projects (connector_id, project_id) VALUES (?, ?)');
      for (const projectId of access.projectIds) insert.run(id, projectId);
    });
    write();
  }

  function insertRow(
    userId: number,
    slug: string,
    label: string | null,
    status: string,
    error: string | null,
    configJson: string,
    access: ConnectorAccess,
    profile: ConnectorAccessModeProfile | null = null,
  ): number {
    let id = 0;
    const write = db.transaction(() => {
      const info = db.prepare(
        `INSERT INTO user_connectors
           (user_id, connector_slug, label, status, error, config_json, sharing, scope_mode,
            access_mode, access_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        userId,
        slug,
        label,
        status,
        error,
        configJson,
        access.sharing,
        access.scopeMode,
        profile?.mode ?? null,
        profile?.version ?? null,
      );
      id = Number(info.lastInsertRowid);
      const insert = db.prepare('INSERT INTO user_connector_projects (connector_id, project_id) VALUES (?, ?)');
      for (const projectId of access.projectIds) insert.run(id, projectId);
    });
    write();
    return id;
  }

  function updateRow(
    id: number,
    status: string,
    error: string | null,
    configJson: string,
    profile?: ConnectorAccessModeProfile | null,
  ): void {
    detailsCache.delete(id);
    db.prepare(
      `UPDATE user_connectors
          SET status = ?, error = ?, config_json = ?,
              access_mode = COALESCE(?, access_mode),
              access_version = COALESCE(?, access_version),
              updated_at = datetime('now')
        WHERE id = ?`,
    ).run(status, error, configJson, profile?.mode ?? null, profile?.version ?? null, id);
  }

  function setStatus(id: number, status: string, error: string | null): void {
    db.prepare("UPDATE user_connectors SET status = ?, error = ?, updated_at = datetime('now') WHERE id = ?").run(
      status,
      error,
      id,
    );
  }

  function customSettings(row: UserConnectorRow): Record<string, string> | null {
    try {
      const parsed = JSON.parse(row.config_json) as { settings?: unknown };
      if (!parsed.settings || typeof parsed.settings !== 'object' || Array.isArray(parsed.settings)) return null;
      return Object.fromEntries(
        Object.entries(parsed.settings as Record<string, unknown>).map(([key, value]) => [key, String(value)]),
      );
    } catch {
      return null;
    }
  }

  function netSuiteCredentials(settings: Record<string, string>): NetSuiteCredentials {
    return {
      accountId: settings.accountId?.trim() ?? '',
      clientId: settings.clientId?.trim() ?? '',
      certId: settings.certId?.trim() ?? '',
      privateKey: settings.privateKey ?? '',
    };
  }

  function ringCentralCredentials(settings: Record<string, string>): RingCentralCredentials {
    return {
      serverUrl: settings.serverUrl?.trim() || 'https://platform.ringcentral.com',
      clientId: settings.clientId?.trim() ?? '',
      clientSecret: settings.clientSecret ?? '',
      jwt: settings.jwt?.trim() ?? '',
    };
  }

  function completeAccessModeChange(row: UserConnectorRow, change: ConnectorAccessChangeRow): string | null {
    let oldAccountId: string | null = null;
    try {
      oldAccountId = (JSON.parse(row.config_json) as ComposioInstallConfig).connectedAccountId ?? null;
    } catch {
      /* A malformed old config must not block a valid replacement. */
    }
    const write = db.transaction(() => {
      db.prepare(
        `UPDATE user_connectors
            SET config_json = ?, access_mode = ?, access_version = ?,
                status = 'connected', error = NULL, updated_at = datetime('now')
          WHERE id = ?`,
      ).run(change.config_json, change.access_mode, change.access_version, row.id);
      db.prepare('DELETE FROM connector_access_changes WHERE connector_id = ?').run(row.id);
    });
    write();
    detailsCache.delete(row.id);
    return oldAccountId;
  }

  function defFor(req: Request, res: Response): ConnectorDef | null {
    const def = connectorDef(String(req.params.slug));
    if (!def) {
      res.status(404).json({ ok: false, error: 'Unknown connector' });
      return null;
    }
    return def;
  }

  router.get('/', (req, res) => {
    const rows = db
      .prepare("SELECT * FROM user_connectors WHERE user_id = ? OR sharing = 'shared' ORDER BY id")
      .all(req.user!.id) as UserConnectorRow[];
    const bySlug = new Map<string, UserConnectorRow[]>();
    for (const r of rows) {
      const list = bySlug.get(r.connector_slug) ?? [];
      list.push(r);
      bySlug.set(r.connector_slug, list);
    }
    res.json({
      ok: true,
      connectors: CONNECTOR_DEFS.map((d) =>
        connectorView(db, d, bySlug.get(d.slug) ?? [], req.user!.id, isAdmin(req)),
      ),
    });
  });

  // Live status check — the UI polls this after the user returns from the
  // Composio Connect flow until the account goes ACTIVE. Id-based and
  // registered before any '/:slug/...' route so 'install' is never a slug.
  router.get('/install/:id/status', (req, res) => {
    const row = rowById(Number(req.params.id));
    if (!row || !canSee(req, row)) {
      res.status(404).json({ ok: false, error: 'Unknown install' });
      return;
    }
    const def = connectorDef(row.connector_slug);
    const apiKey = composioKey();
    if (row.status !== 'pending' || def?.kind !== 'composio' || !apiKey) {
      res.json({ ok: true, status: row.status, error: row.error });
      return;
    }
    let accountId: string | null = null;
    try {
      accountId = (JSON.parse(row.config_json) as ComposioInstallConfig).connectedAccountId ?? null;
    } catch {
      /* malformed config — report the stored status below */
    }
    if (!accountId) {
      res.json({ ok: true, status: row.status, error: row.error });
      return;
    }
    void loadComposioAccountStatus(apiKey, accountId)
      .then(async (remote) => {
        if (remote === 'ACTIVE') {
          updateRow(row.id, 'connected', null, row.config_json);
          res.json({ ok: true, status: 'connected', error: null });
        } else if (['FAILED', 'EXPIRED', 'INACTIVE', 'REVOKED'].includes(remote)) {
          const message = `Sign-in ${remote.toLowerCase()} — remove and try again.`;
          setStatus(row.id, 'error', message);
          res.json({ ok: true, status: 'error', error: message });
        } else {
          res.json({ ok: true, status: 'pending', error: null });
        }
      })
      .catch(() => res.json({ ok: true, status: row.status, error: row.error }));
  });

  /** Start a second Composio connection for a mode change. The current MCP
   * session stays active until this replacement account is ACTIVE. */
  router.post('/install/:id/access-mode', (req, res) => {
    const row = rowById(Number(req.params.id));
    if (!row || !canSee(req, row)) {
      res.status(404).json({ ok: false, error: 'Unknown install' });
      return;
    }
    if (!canManage(req, row)) {
      res.status(403).json({ ok: false, error: 'You cannot change this connector.' });
      return;
    }
    if (row.status !== 'connected') {
      res.status(409).json({ ok: false, error: 'Finish the current connection before changing its access mode.' });
      return;
    }
    const body = AccessModeChangeSchema.safeParse(req.body ?? {});
    const def = connectorDef(row.connector_slug);
    const profile = body.success
      ? connectorAccessModeProfile(def?.accessModes, body.data.accessMode)
      : null;
    if (!body.success || !def?.composio || !profile?.composio) {
      res.status(400).json({ ok: false, error: 'Choose an available access mode.' });
      return;
    }
    if (row.access_mode === profile.mode && row.access_version === profile.version) {
      res.status(409).json({ ok: false, error: `${profile.label} is already active.` });
      return;
    }
    if (accessChangeFor(row.id)) {
      res.status(409).json({ ok: false, error: 'An access mode change is already waiting for sign-in.' });
      return;
    }
    const apiKey = composioKey();
    if (!apiKey) {
      res.status(400).json({ ok: false, error: 'Add your Composio API key in Settings → API Keys first.' });
      return;
    }
    let currentConfig: ComposioInstallConfig;
    try {
      currentConfig = JSON.parse(row.config_json) as ComposioInstallConfig;
    } catch {
      res.status(409).json({ ok: false, error: 'This connection must be removed and installed again.' });
      return;
    }
    const owner = db.prepare('SELECT email FROM users WHERE id = ?').get(row.user_id) as { email: string } | undefined;
    const ownerEmail = owner?.email ?? req.user!.email;
    const composioUserId = currentConfig.composioUserId ?? (
      row.label ? `${ownerEmail}#${slugifyLabel(row.label)}` : ownerEmail
    );
    const callback = new URLSearchParams({ connected: def.slug, accessChange: String(row.id) });
    const callbackUrl = `${requestOrigin(req)}/#/settings/connectors?${callback.toString()}`;
    void authConfigFor(apiKey, def, profile)
      .then((authConfigId) => beginComposioInstall(
        apiKey,
        composioUserId,
        def.composio!.toolkit,
        callbackUrl,
        { authConfigId, toolSlugs: profile.composio!.toolSlugs },
      ))
      .then((start) => {
        const config = composioInstallConfig(start, composioUserId);
        db.prepare(
          `INSERT INTO connector_access_changes
             (connector_id, access_mode, access_version, status, error, config_json)
           VALUES (?, ?, ?, 'pending', NULL, ?)`,
        ).run(row.id, profile.mode, profile.version, JSON.stringify(config));
        if (start.alreadyActive) {
          const change = accessChangeFor(row.id)!;
          const oldAccountId = completeAccessModeChange(row, change);
          if (oldAccountId && oldAccountId !== start.connectedAccountId) {
            void removeComposioAccount(apiKey, oldAccountId);
          }
          res.json({ ok: true, status: 'connected', redirectUrl: null });
          return;
        }
        res.json({ ok: true, status: 'pending', redirectUrl: start.redirectUrl });
      })
      .catch((err: Error) => {
        res.status(502).json({ ok: false, error: `Composio: ${composioErrorMessage(err)}` });
      });
  });

  router.get('/install/:id/access-mode/status', (req, res) => {
    const row = rowById(Number(req.params.id));
    if (!row || !canSee(req, row)) {
      res.status(404).json({ ok: false, error: 'Unknown install' });
      return;
    }
    const change = accessChangeFor(row.id);
    if (!change) {
      res.json({ ok: true, status: 'idle', error: null });
      return;
    }
    if (change.status === 'error') {
      res.json({ ok: true, status: 'error', error: change.error });
      return;
    }
    const apiKey = composioKey();
    let config: ComposioInstallConfig;
    try {
      config = JSON.parse(change.config_json) as ComposioInstallConfig;
    } catch {
      res.status(500).json({ ok: false, error: 'The pending access mode change is incomplete.' });
      return;
    }
    if (!apiKey || !config.connectedAccountId) {
      res.json({ ok: true, status: 'pending', error: null });
      return;
    }
    void loadComposioAccountStatus(apiKey, config.connectedAccountId)
      .then((remote) => {
        if (remote === 'ACTIVE') {
          const oldAccountId = completeAccessModeChange(row, change);
          if (oldAccountId && oldAccountId !== config.connectedAccountId) {
            void removeComposioAccount(apiKey, oldAccountId);
          }
          res.json({ ok: true, status: 'connected', error: null });
          return;
        }
        if (['FAILED', 'EXPIRED', 'INACTIVE', 'REVOKED'].includes(remote)) {
          const error = `Sign-in ${remote.toLowerCase()}. Your existing access is unchanged.`;
          db.prepare(
            `UPDATE connector_access_changes
                SET status = 'error', error = ?, updated_at = datetime('now')
              WHERE connector_id = ?`,
          ).run(error, row.id);
          res.json({ ok: true, status: 'error', error });
          return;
        }
        res.json({ ok: true, status: 'pending', error: null });
      })
      .catch(() => res.json({ ok: true, status: 'pending', error: null }));
  });

  router.post('/install/:id/access-mode/cancel', (req, res) => {
    const row = rowById(Number(req.params.id));
    if (!row || !canSee(req, row)) {
      res.status(404).json({ ok: false, error: 'Unknown install' });
      return;
    }
    if (!canManage(req, row)) {
      res.status(403).json({ ok: false, error: 'You cannot change this connector.' });
      return;
    }
    const change = accessChangeFor(row.id);
    if (!change) {
      res.json({ ok: true });
      return;
    }
    let accountId: string | null = null;
    try {
      accountId = (JSON.parse(change.config_json) as ComposioInstallConfig).connectedAccountId ?? null;
    } catch {
      /* Local cleanup still proceeds. */
    }
    db.prepare('DELETE FROM connector_access_changes WHERE connector_id = ?').run(row.id);
    const apiKey = composioKey();
    if (apiKey && accountId) void removeComposioAccount(apiKey, accountId);
    res.json({ ok: true });
  });

  /** Data-free custom-connector health check. */
  router.post('/install/:id/test', (req, res) => {
    const row = rowById(Number(req.params.id));
    if (!row || !canSee(req, row)) {
      res.status(404).json({ ok: false, error: 'Unknown install' });
      return;
    }
    if (!TESTABLE_CONNECTOR_SLUGS.includes(row.connector_slug as TestableConnectorSlug)) {
      res.status(400).json({ ok: false, error: 'Connection testing is not available for this connector.' });
      return;
    }
    const slug = row.connector_slug as TestableConnectorSlug;
    const settings = customSettings(row);
    if (!settings) {
      res.status(409).json({ ok: false, error: `This ${TESTABLE_CONNECTOR_NAMES[slug]} connection has incomplete settings.` });
      return;
    }
    const healthRequest = slug === 'netsuite'
      ? checkNetSuite(netSuiteCredentials(settings))
      : slug === 'ringcentral'
        ? checkRingCentral(ringCentralCredentials(settings))
        : checkPaper(resolvePaperMcpUrl(settings));
    void healthRequest
      .then((health) => res.json({ ok: true, health }))
      .catch(() =>
        res.json({
          ok: true,
          health: {
            ok: false,
            status: 'error',
            error: `${TESTABLE_CONNECTOR_NAMES[slug]} connection testing failed unexpectedly.`,
            timeoutStage: null,
            timings: { tokenMs: null, queryMs: null, totalMs: 0 },
          } satisfies NetSuiteHealthResult | RingCentralHealthResult | PaperHealthResult,
        }),
      );
  });

  // Account metadata is deliberately separate from the catalog response: the
  // UI asks for it only when a row is expanded. Successful lookups are cached
  // and concurrent requests coalesce, keeping provider traffic predictable.
  router.get('/install/:id/details', (req, res) => {
    const row = rowById(Number(req.params.id));
    if (!row || !canSee(req, row)) {
      res.status(404).json({ ok: false, error: 'Unknown install' });
      return;
    }
    const def = connectorDef(row.connector_slug);
    if (def?.kind !== 'composio' || !def.composio) {
      res.status(400).json({ ok: false, error: 'Account details are not available for this connector.' });
      return;
    }
    if (row.status !== 'connected') {
      res.status(409).json({ ok: false, error: 'Finish connecting this account before loading its details.' });
      return;
    }
    const apiKey = composioKey();
    if (!apiKey) {
      res.status(503).json({ ok: false, error: 'Connected account details are temporarily unavailable.' });
      return;
    }
    let config: ComposioInstallConfig;
    try {
      config = JSON.parse(row.config_json) as ComposioInstallConfig;
    } catch {
      res.status(500).json({ ok: false, error: 'This connector has incomplete account information.' });
      return;
    }
    if (!config.sessionId || !config.connectedAccountId) {
      res.status(500).json({ ok: false, error: 'This connector has incomplete account information.' });
      return;
    }

    const fingerprint = `${config.connectedAccountId}:${config.sessionId}`;
    const currentTime = now();
    const cached = detailsCache.get(row.id);
    const forceRequested = req.query.refresh === '1' && canManage(req, row);
    if (cached?.fingerprint === fingerprint) {
      if (cached.inFlight) {
        void cached.inFlight
          .then((details) => res.json({ ok: true, details }))
          .catch(() => res.status(502).json({ ok: false, error: 'Connected account details could not be loaded.' }));
        return;
      }
      const refreshAllowed = forceRequested && currentTime - cached.fetchedAt >= DETAILS_FORCE_REFRESH_FLOOR_MS;
      if (cached.value && !refreshAllowed && currentTime < cached.expiresAt) {
        res.json({ ok: true, details: cached.value });
        return;
      }
    }

    const request = loadComposioDetails(apiKey, config, def.composio.toolkit);
    detailsCache.set(row.id, {
      fingerprint,
      fetchedAt: currentTime,
      expiresAt: currentTime + DETAILS_CACHE_TTL_MS,
      inFlight: request,
    });
    void request
      .then((details) => {
        const finishedAt = now();
        detailsCache.set(row.id, {
          fingerprint,
          fetchedAt: finishedAt,
          expiresAt: finishedAt + DETAILS_CACHE_TTL_MS,
          value: details,
        });
        res.json({ ok: true, details });
      })
      .catch(() => {
        const active = detailsCache.get(row.id);
        if (active?.inFlight === request) detailsCache.delete(row.id);
        res.status(502).json({ ok: false, error: 'Connected account details could not be loaded.' });
      });
  });

  router.patch('/install/:id', (req, res) => {
    const row = rowById(Number(req.params.id));
    if (!row || !canSee(req, row)) {
      res.status(404).json({ ok: false, error: 'Unknown install' });
      return;
    }
    if (!canManage(req, row)) {
      res.status(403).json({ ok: false, error: 'You cannot manage this connector.' });
      return;
    }
    if (req.body?.sharing === 'shared' && !isAdmin(req)) {
      res.status(403).json({ ok: false, error: 'Administrator access is required to share a connector.' });
      return;
    }
    const body = AccessSchema.safeParse(req.body ?? {});
    const access = body.success ? resolveAccess(req, body.data, row) : null;
    if (!access) {
      res.status(400).json({ ok: false, error: 'Choose a valid user access and project scope.' });
      return;
    }

    applyAccess(row.id, access);
    const fresh = rowById(row.id)!;
    const def = connectorDef(row.connector_slug)!;
    const view = connectorView(db, def, [fresh], req.user!.id, isAdmin(req));
    res.json({ ok: true, install: (view.installs as unknown[])[0] });
  });

  router.post('/install/:id/uninstall', (req, res) => {
    const row = rowById(Number(req.params.id));
    if (!row || !canSee(req, row)) {
      res.status(404).json({ ok: false, error: 'Unknown install' });
      return;
    }
    if (!canManage(req, row)) {
      res.status(403).json({ ok: false, error: 'You cannot remove this connector.' });
      return;
    }
    const eventAutomations = (
      db.prepare(
        `SELECT COUNT(*) AS count FROM scheduled_tasks
         WHERE connector_id = ? AND trigger_kind = 'event'`,
      ).get(row.id) as { count: number }
    ).count;
    if (eventAutomations > 0) {
      res.status(409).json({
        ok: false,
        error: `Delete the ${eventAutomations === 1 ? 'automation' : `${eventAutomations} automations`} using this connector first.`,
      });
      return;
    }
    const finish = (): void => {
      detailsCache.delete(row.id);
      db.prepare('DELETE FROM user_connectors WHERE id = ?').run(row.id);
      res.json({ ok: true });
    };
    const def = connectorDef(row.connector_slug);
    const apiKey = composioKey();
    if (def?.kind === 'composio' && apiKey) {
      const accountIds: string[] = [];
      try {
        const accountId = (JSON.parse(row.config_json) as ComposioInstallConfig).connectedAccountId;
        if (accountId) accountIds.push(accountId);
      } catch {
        /* malformed config — nothing to revoke remotely */
      }
      const pendingChange = accessChangeFor(row.id);
      if (pendingChange) {
        try {
          const accountId = (JSON.parse(pendingChange.config_json) as ComposioInstallConfig).connectedAccountId;
          if (accountId) accountIds.push(accountId);
        } catch {
          /* malformed pending config — local cascade cleanup still proceeds */
        }
      }
      if (accountIds.length) {
        void Promise.all([...new Set(accountIds)].map((accountId) => removeComposioAccount(apiKey, accountId))).then(finish);
        return;
      }
    }
    finish();
  });

  router.post('/:slug/install', (req, res) => {
    const def = defFor(req, res);
    if (!def) return;
    const body = InstallSchema.safeParse(req.body ?? {});
    if (!body.success) {
      res.status(400).json({ ok: false, error: 'Invalid settings' });
      return;
    }
    const user = req.user!;
    if (body.data.sharing === 'shared' && !isAdmin(req)) {
      res.status(403).json({ ok: false, error: 'Administrator access is required to share a connector.' });
      return;
    }
    const trimmed = body.data.label?.trim();
    const label = trimmed ? trimmed : undefined;

    // Retry: an existing pending/error row is reused (keeps its id + label);
    // we just mint a fresh session and UPDATE it.
    let retryRow: UserConnectorRow | undefined;
    if (body.data.installId !== undefined) {
      retryRow = rowById(body.data.installId);
      if (!retryRow || retryRow.user_id !== user.id || retryRow.connector_slug !== def.slug) {
        res.status(404).json({ ok: false, error: 'Unknown install' });
        return;
      }
      if (retryRow.status === 'connected') {
        res.status(409).json({ ok: false, error: `${def.name} is already connected.` });
        return;
      }
    }

    let selectedAccessProfile: ConnectorAccessModeProfile | null = null;
    if (def.accessModes?.length) {
      const selectedMode = body.data.accessMode ?? retryRow?.access_mode;
      selectedAccessProfile = connectorAccessModeProfile(
        def.accessModes,
        selectedMode,
      );
      if (!selectedAccessProfile) {
        res.status(400).json({ ok: false, error: `Choose Limited or Full for ${def.name}.` });
        return;
      }
    } else if (body.data.accessMode) {
      res.status(400).json({ ok: false, error: `${def.name} does not offer access modes yet.` });
      return;
    }

    const access = resolveAccess(
      req,
      {
        sharing: body.data.sharing,
        scopeMode: body.data.scopeMode,
        projectIds: body.data.projectIds,
      },
      retryRow,
    );
    if (!access) {
      res.status(400).json({ ok: false, error: 'Choose a valid user access and project scope.' });
      return;
    }

    // New install: enforce the label rules against the user's existing installs.
    if (!retryRow) {
      const existing = rowsFor(user.id, def.slug);
      if (existing.length && !label) {
        res.status(400).json({
          ok: false,
          error: `You already have ${def.name} connected — give this account a label (e.g. "Work").`,
        });
        return;
      }
      if (label) {
        const wanted = slugifyLabel(label);
        if (existing.some((r) => r.label && slugifyLabel(r.label) === wanted)) {
          res.status(409).json({ ok: false, error: `That label is already in use for ${def.name}.` });
          return;
        }
      }
    }

    // The install's label: its own on retry, the (trimmed) new label otherwise.
    const effectiveLabel: string | null = retryRow ? retryRow.label : label ?? null;

    if (def.kind === 'custom') {
      // Custom retries may reuse the safely stored write-only settings, or
      // replace them when the caller supplies an updated credential set.
      const settings = body.data.settings ?? (retryRow ? customSettings(retryRow) ?? {} : {});
      const missing = (def.fields ?? []).filter((f) => f.required !== false && !settings[f.key]?.trim());
      if (missing.length) {
        res.status(400).json({ ok: false, error: `Missing: ${missing.map((f) => f.label).join(', ')}` });
        return;
      }
      const validationError = def.validateSettings?.(settings);
      if (validationError) {
        res.status(400).json({ ok: false, error: validationError });
        return;
      }
      const configJson = JSON.stringify({ settings });
      if (def.slug !== 'netsuite' && def.slug !== 'ringcentral') {
        if (retryRow) {
          updateRow(retryRow.id, 'connected', null, configJson, selectedAccessProfile);
          applyAccess(retryRow.id, access);
        } else insertRow(user.id, def.slug, effectiveLabel, 'connected', null, configJson, access, selectedAccessProfile);
        res.json({ ok: true, status: 'connected', redirectUrl: null });
        return;
      }

      const installId = retryRow
        ? retryRow.id
        : insertRow(user.id, def.slug, effectiveLabel, 'pending', null, configJson, access, selectedAccessProfile);
      if (retryRow) {
        updateRow(installId, 'pending', null, configJson, selectedAccessProfile);
        applyAccess(installId, access);
      }
      const healthRequest = def.slug === 'netsuite'
        ? checkNetSuite(netSuiteCredentials(settings))
        : checkRingCentral(ringCentralCredentials(settings));
      void healthRequest
        .then((health) => {
          if (health.ok) {
            setStatus(installId, 'connected', null);
            res.json({ ok: true, status: 'connected', redirectUrl: null, health });
            return;
          }
          setStatus(installId, 'error', health.error);
          res.status(502).json({
            ok: false,
            error: health.error ?? `${def.name} credentials or read access could not be verified.`,
            installId,
            health,
          });
        })
        .catch(() => {
          const error = `${def.name} credentials or read access could not be verified.`;
          setStatus(installId, 'error', error);
          res.status(502).json({ ok: false, error, installId });
        });
      return;
    }

    // Composio kind: mint a session (persistent MCP endpoint) + a Connect Link.
    const apiKey = composioKey();
    if (!apiKey) {
      res.status(400).json({ ok: false, error: 'Add your Composio API key in Settings → API Keys first.' });
      return;
    }
    // A labeled install gets a distinct Composio identity so it binds its own
    // account (otherwise every install of a toolkit would share one account).
    const composioUserId = effectiveLabel ? `${user.email}#${slugifyLabel(effectiveLabel)}` : user.email;
    const callback = new URLSearchParams({ connected: def.slug });
    if (access.scopeMode === 'projects' && access.projectIds[0]) callback.set('project', access.projectIds[0]);
    const callbackUrl = `${requestOrigin(req)}/#/settings/connectors?${callback.toString()}`;
    const accessPolicy = selectedAccessProfile?.composio
      ? authConfigFor(apiKey, def, selectedAccessProfile).then((authConfigId) => ({
          authConfigId,
          toolSlugs: selectedAccessProfile!.composio!.toolSlugs,
        }))
      : Promise.resolve(null);
    void accessPolicy
      .then((policy) => policy
        ? beginComposioInstall(apiKey, composioUserId, def.composio!.toolkit, callbackUrl, policy)
        : beginComposioInstall(apiKey, composioUserId, def.composio!.toolkit, callbackUrl))
      .then(async (start) => {
        const config = composioInstallConfig(start, composioUserId);
        const status = start.alreadyActive ? 'connected' : 'pending';
        const configJson = JSON.stringify(config);
        let replacedAccountId: string | null = null;
        if (retryRow) {
          try {
            replacedAccountId = (JSON.parse(retryRow.config_json) as ComposioInstallConfig).connectedAccountId ?? null;
          } catch {
            /* malformed failed config — the valid retry can still replace it */
          }
          updateRow(retryRow.id, status, null, configJson, selectedAccessProfile);
          applyAccess(retryRow.id, access);
        } else insertRow(user.id, def.slug, effectiveLabel, status, null, configJson, access, selectedAccessProfile);
        if (replacedAccountId && replacedAccountId !== start.connectedAccountId) {
          await removeComposioAccount(apiKey, replacedAccountId);
        }
        res.json({ ok: true, status, redirectUrl: start.alreadyActive ? null : start.redirectUrl });
      })
      .catch((err: Error) => {
        res.status(502).json({ ok: false, error: `Composio: ${composioErrorMessage(err)}` });
      });
  });

  return router;
}
