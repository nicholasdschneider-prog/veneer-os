import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, Info, Loader2, LockKeyhole, Plus, RefreshCw, Settings2, ShieldCheck, Trash2, TriangleAlert, UserRound, UsersRound } from 'lucide-react';
import {
  api,
  type ConnectorAccessWrite,
  type ConnectorAccessMode,
  type ConnectorAccessModeProfile,
  type ConnectorAccountDetails,
  type ConnectorInfo,
  type ConnectorHealthResult,
  type ConnectorInstall,
  type ConnectorInstallWrite,
  type ConnectorScopeMode,
  type ConnectorSharing,
} from '../lib/api';
import type { Project } from '../lib/types';
import { ConnectorGlyph } from '../lib/connectorIcons';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

type InstalledEntry = { connector: ConnectorInfo; install: ConnectorInstall };

/** Custom connectors that expose a live "Test connection" probe (mirrors the server list). */
const TESTABLE_CONNECTOR_SLUGS = ['netsuite', 'ringcentral', 'paper'];

// `new URL()` keeps the brackets on an IPv6 hostname, so both spellings appear.
const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '::1', '[::1]'];

/**
 * Paper's MCP endpoint has no authentication. On loopback that is fine; pointed
 * at another machine it means anyone who can reach that host:port can read and
 * rewrite the design file, so the setup form says so before the user saves.
 */
function paperExposureWarning(slug: string, url: string): string | null {
  if (slug !== 'paper') return null;
  const raw = url.trim();
  if (!raw) return null;
  let host: string;
  try {
    host = new URL(raw).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (LOOPBACK_HOSTS.includes(host)) return null;
  return `Paper's MCP endpoint has no authentication. Anyone who can reach ${host}:29979 can read and change this design file. Restrict it to this Veneer host.`;
}

function projectFromHash(): string | null {
  return new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('project');
}

export function ConnectorsScreen({ role, onToast }: { role: string; onToast: (message: string) => void }) {
  const [connectors, setConnectors] = useState<ConnectorInfo[] | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [setupSlug, setSetupSlug] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [detailsId, setDetailsId] = useState<number | null>(null);
  const [healthById, setHealthById] = useState<Record<number, ConnectorHealthResult>>({});
  const pollTimer = useRef<number | null>(null);
  const initialProjectId = projectFromHash();
  const canShare = role === 'owner' || role === 'consultant';

  const load = useCallback(() => {
    void Promise.all([api.connectors(), api.projects()])
      .then(([connectorResult, projectResult]) => {
        setConnectors(connectorResult.connectors);
        setProjects(projectResult.projects);
        setError(null);
      })
      .catch((err: Error) => setError(err.message));
  }, []);
  useEffect(load, [load]);

  useEffect(() => {
    const pending = connectors?.flatMap((c) => c.installs.filter((i) => i.status === 'pending' && i.ownedByMe)) ?? [];
    const accessChanges = connectors?.flatMap((c) => c.installs.filter((i) => i.accessChange?.status === 'pending')) ?? [];
    if (pending.length === 0 && accessChanges.length === 0) return;
    pollTimer.current = window.setTimeout(() => {
      void Promise.all(
        [
          ...pending.map((i) => api.connectorStatus(i.id).then((r) => r.status !== 'pending').catch(() => false)),
          ...accessChanges.map((i) => api.connectorAccessModeStatus(i.id).then((r) => r.status !== 'pending').catch(() => false)),
        ],
      ).then((changed) => {
        if (changed.some(Boolean)) load();
        else setConnectors((cur) => (cur ? [...cur] : cur));
      });
    }, 2500);
    return () => {
      if (pollTimer.current) window.clearTimeout(pollTimer.current);
    };
  }, [connectors, load]);

  const installConnector = useCallback(
    async (connector: ConnectorInfo, opts: ConnectorInstallWrite) => {
      setBusy(opts.installId ? `install-${opts.installId}` : `slug-${connector.slug}`);
      try {
        const result = await api.installConnector(connector.slug, opts);
        if (result.redirectUrl) {
          window.location.href = result.redirectUrl;
          return;
        }
        setSetupSlug(null);
        onToast(`${connector.name} connected`);
        load();
      } catch (err) {
        onToast((err as Error).message);
        // NetSuite verification failures intentionally leave a retryable error
        // row; refresh so it is visible without requiring a page reload.
        load();
      } finally {
        setBusy(null);
      }
    },
    [load, onToast],
  );

  const uninstall = useCallback(
    async (connector: ConnectorInfo, install: ConnectorInstall) => {
      const name = install.label ? `${connector.name} — ${install.label}` : connector.name;
      const impact = install.sharing === 'shared'
        ? install.scopeMode === 'all'
          ? ' Everybody will lose access.'
          : ' Everybody in its selected projects will lose access.'
        : '';
      if (!window.confirm(`Disconnect ${name}?${impact}`)) return;
      setBusy(`install-${install.id}`);
      try {
        await api.uninstallConnector(install.id);
        if (editingId === install.id) setEditingId(null);
        if (detailsId === install.id) setDetailsId(null);
        onToast(`${name} disconnected`);
        load();
      } catch (err) {
        onToast((err as Error).message);
      } finally {
        setBusy(null);
      }
    },
    [detailsId, editingId, load, onToast],
  );

  const updateAccess = useCallback(
    async (install: ConnectorInstall, access: ConnectorAccessWrite) => {
      setBusy(`install-${install.id}`);
      try {
        await api.updateConnectorAccess(install.id, access);
        setEditingId(null);
        onToast('Connector access updated');
        load();
      } catch (err) {
        onToast((err as Error).message);
      } finally {
        setBusy(null);
      }
    },
    [load, onToast],
  );

  const changeAccessMode = useCallback(
    async (connector: ConnectorInfo, install: ConnectorInstall, accessMode: ConnectorAccessMode) => {
      setBusy(`install-${install.id}`);
      try {
        const result = await api.changeConnectorAccessMode(install.id, accessMode);
        if (result.redirectUrl) {
          window.location.href = result.redirectUrl;
          return;
        }
        onToast(`${connector.name} access mode updated`);
        load();
      } catch (err) {
        onToast((err as Error).message);
      } finally {
        setBusy(null);
      }
    },
    [load, onToast],
  );

  const cancelAccessModeChange = useCallback(async (install: ConnectorInstall) => {
    setBusy(`install-${install.id}`);
    try {
      await api.cancelConnectorAccessModeChange(install.id);
      onToast('Access mode change cancelled; existing access was kept');
      load();
    } catch (err) {
      onToast((err as Error).message);
    } finally {
      setBusy(null);
    }
  }, [load, onToast]);

  const testConnection = useCallback(async (connector: ConnectorInfo, install: ConnectorInstall) => {
    setBusy(`health-${install.id}`);
    try {
      const result = await api.testConnectorConnection(install.id);
      setHealthById((current) => ({ ...current, [install.id]: result.health }));
      onToast(
        result.health.ok
          ? `${connector.name} responded in ${result.health.timings.totalMs} ms`
          : result.health.error ?? `${connector.name} connection test failed`,
      );
    } catch (err) {
      onToast((err as Error).message);
    } finally {
      setBusy(null);
    }
  }, [onToast]);

  const installed: InstalledEntry[] =
    connectors?.flatMap((connector) => connector.installs.map((install) => ({ connector, install }))) ?? [];
  const editing = installed.find(({ install }) => install.id === editingId) ?? null;
  const contextProject = projects.find((project) => project.id === initialProjectId) ?? null;
  const library = connectors
    ? [...connectors].sort(
        (a, b) =>
          Number(b.installs.some((install) => install.status === 'connected')) -
          Number(a.installs.some((install) => install.status === 'connected')),
      )
    : [];

  return (
    <div>
      <p className="mb-5 px-1 text-sm text-muted-foreground">
        {contextProject
          ? `Manage which accounts are available in ${contextProject.name}. You can also make an account available in other projects.`
          : 'Choose who can use each connected account and which projects can use it.'}
      </p>

      {error ? <div className="mb-4 rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</div> : null}
      {connectors === null && !error ? <p className="px-1 py-6 text-center text-sm text-muted-foreground">Loading…</p> : null}

      {installed.length > 0 ? (
        <section className="mb-7">
          <h2 className="mb-3 px-1 text-lg font-semibold">Connected</h2>
          <div role="table" aria-label="Connected accounts" className="overflow-hidden rounded-xl border bg-card text-sm">
            <div
              role="row"
              className="hidden grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)_minmax(0,1fr)_10rem] gap-3 border-b bg-muted/40 px-3 py-2.5 text-xs font-semibold text-muted-foreground sm:grid"
            >
              <div role="columnheader">Account</div>
              <div role="columnheader">Status</div>
              <div role="columnheader">Access</div>
              <div role="columnheader" className="text-right">Actions</div>
            </div>
            <div>
              {installed.map(({ connector, install }) => {
                const isEditing = editing?.install.id === install.id;
                const isShowingDetails = detailsId === install.id;
                return (
                  <div key={install.id} role="rowgroup" className="border-t first:border-t-0">
                    <InstalledRow
                      connector={connector}
                      install={install}
                      busy={busy === `install-${install.id}` || busy === `health-${install.id}`}
                      health={healthById[install.id] ?? null}
                      expanded={isEditing || isShowingDetails}
                      accessExpanded={isEditing}
                      detailsExpanded={isShowingDetails}
                      onDetails={() => {
                        setEditingId(null);
                        setDetailsId((current) => current === install.id ? null : install.id);
                      }}
                      onManage={() => {
                        setDetailsId(null);
                        setEditingId((current) => current === install.id ? null : install.id);
                      }}
                      onRemove={() => void uninstall(connector, install)}
                      onRetry={() => void installConnector(connector, { installId: install.id })}
                      onTest={() => void testConnection(connector, install)}
                    />
                    {isShowingDetails ? (
                      <div id={`connector-details-${install.id}`} role="row" className="border-t bg-muted/20">
                        <div role="cell" className="px-4 py-4">
                          <AccountDetailsCard connector={connector} install={install} />
                        </div>
                      </div>
                    ) : null}
                    {isEditing ? (
                      <div id={`connector-access-${install.id}`} role="row" className="border-t bg-muted/20">
                        <div role="cell" className="px-4 py-4">
                          <EditAccessCard
                            key={install.id}
                            connector={connector}
                            install={install}
                            projects={projects}
                            canShare={canShare}
                            busy={busy === `install-${install.id}`}
                            onCancel={() => setEditingId(null)}
                            onSave={(access) => void updateAccess(install, access)}
                            onAccessMode={(mode) => void changeAccessMode(connector, install, mode)}
                            onCancelAccessMode={() => void cancelAccessModeChange(install)}
                          />
                        </div>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>
        </section>
      ) : null}

      {connectors !== null ? (
        <section className="mb-7">
          <h2 className="mb-3 px-1 text-lg font-semibold">Library</h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {library.map((connector) => {
              const ownCount = connector.installs.filter((install) => install.ownedByMe).length;
              return setupSlug === connector.slug ? (
                <div key={connector.slug} className="col-span-full">
                  <SetupCard
                    connector={connector}
                    busy={busy === `slug-${connector.slug}`}
                    withLabel={ownCount > 0}
                    projects={projects}
                    initialProjectId={initialProjectId}
                    canShare={canShare}
                    onCancel={() => setSetupSlug(null)}
                    onSubmit={(opts) => void installConnector(connector, opts)}
                  />
                </div>
              ) : (
                <LibraryCard
                  key={connector.slug}
                  connector={connector}
                  ownCount={ownCount}
                  busy={busy === `slug-${connector.slug}`}
                  onSetup={() => setSetupSlug(connector.slug)}
                />
              );
            })}
          </div>
        </section>
      ) : null}
    </div>
  );
}

function ConnectorIcon({ slug, className }: { slug: string; className?: string }) {
  return <ConnectorGlyph slug={slug} className={className ?? 'size-9'} />;
}

function parseConnectorDate(iso: string): Date {
  return new Date(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`);
}

function connectionAge(iso: string): string {
  const elapsedMinutes = Math.max(0, Math.round((Date.now() - parseConnectorDate(iso).getTime()) / 60_000));
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  if (elapsedMinutes < 1) return 'just now';
  if (elapsedMinutes < 60) return formatter.format(-elapsedMinutes, 'minute');
  const hours = Math.round(elapsedMinutes / 60);
  if (hours < 24) return formatter.format(-hours, 'hour');
  const days = Math.round(hours / 24);
  if (days < 30) return formatter.format(-days, 'day');
  const months = Math.round(days / 30);
  if (months < 12) return formatter.format(-months, 'month');
  return formatter.format(-Math.round(days / 365), 'year');
}

function availabilityLabel(install: ConnectorInstall): string {
  if (install.scopeMode === 'all') return 'All projects';
  if (install.projects.length === 0) return 'Projects: None';
  if (install.projects.length === 1) return `Project: ${install.projects[0]!.name}`;
  return `Projects: ${install.projects.length}`;
}

function InstalledRow({
  connector,
  install,
  busy,
  health,
  expanded,
  accessExpanded,
  detailsExpanded,
  onDetails,
  onManage,
  onRemove,
  onRetry,
  onTest,
}: {
  connector: ConnectorInfo;
  install: ConnectorInstall;
  busy: boolean;
  health: ConnectorHealthResult | null;
  expanded: boolean;
  accessExpanded: boolean;
  detailsExpanded: boolean;
  onDetails: () => void;
  onManage: () => void;
  onRemove: () => void;
  onRetry: () => void;
  onTest: () => void;
}) {
  return (
    <div
      role="row"
      className={`grid grid-cols-2 gap-x-4 gap-y-3 px-3 py-3 sm:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)_minmax(0,1fr)_10rem] sm:items-center sm:gap-3 ${expanded ? 'bg-muted/20' : ''}`}
    >
      <div role="cell" className="col-span-2 flex min-w-0 items-center gap-3 sm:col-span-1">
        <ConnectorIcon slug={connector.slug} className="size-9 shrink-0" />
        <div className="min-w-0">
          <p className="truncate font-medium">{connector.name}</p>
          {install.label ? <p className="truncate text-xs text-muted-foreground">{install.label}</p> : null}
          {install.status === 'connected' ? (
            <p className="mt-0.5 truncate text-xs text-foreground/75">@{install.mention}</p>
          ) : null}
        </div>
      </div>
      <div role="cell" className="min-w-0 text-xs">
        <span className="mb-1 block font-semibold text-muted-foreground sm:hidden">Status</span>
        {install.status === 'connected' ? (
          <p className="flex items-center gap-1 text-brand">
            <CheckCircle2 className="size-3.5 shrink-0" /> Connected
          </p>
        ) : install.status === 'pending' ? (
          <p className="flex items-center gap-1 text-muted-foreground">
            <Loader2 className="size-3.5 shrink-0 animate-spin" /> Finishing sign-in…
          </p>
        ) : (
          <p className="flex items-start gap-1 text-destructive">
            <TriangleAlert className="mt-px size-3.5 shrink-0" />
            <span className="line-clamp-2" title={install.error ?? 'Something went wrong'}>
              {install.error ?? 'Something went wrong'}
            </span>
          </p>
        )}
        {install.status === 'connected' ? (
          <p className="mt-0.5 whitespace-nowrap text-muted-foreground">{connectionAge(install.createdAt)}</p>
        ) : null}
        {health ? (
          <p className={`mt-0.5 line-clamp-2 ${health.ok ? 'text-muted-foreground' : 'text-destructive'}`}>
            {health.ok ? `Tested · ${health.timings.totalMs} ms` : health.error ?? 'Connection test failed'}
          </p>
        ) : null}
      </div>
      <div role="cell" className="min-w-0 text-xs text-muted-foreground">
        <span className="mb-1 block font-semibold sm:hidden">Access</span>
        <p className="flex items-center gap-1 truncate">
          {install.sharing === 'shared' ? <UsersRound className="size-3" /> : <UserRound className="size-3" />}
          {install.sharing === 'shared' ? 'Everybody' : 'Only me'}
        </p>
        <p className="truncate" title={install.projects.map((project) => project.name).join(', ')}>
          {availabilityLabel(install)}
        </p>
        {install.accessMode ? (
          <p
            className="mt-1 flex items-center gap-1 truncate text-foreground/80"
            title={[install.accessMode.description, install.accessMode.providerPermissionNote].filter(Boolean).join(' ')}
          >
            {install.accessMode.mode === 'read_only'
              ? <ShieldCheck className="size-3" />
              : install.accessMode.mode === 'full'
                ? <LockKeyhole className="size-3" />
                : <TriangleAlert className="size-3" />}
            {install.accessMode.label}
          </p>
        ) : connector.kind === 'composio' ? (
          <p className="mt-1 flex items-center gap-1 truncate text-foreground/80" title="Includes the full connector surface offered by Composio.">
            <LockKeyhole className="size-3" /> Full access
          </p>
        ) : (
          <p className="mt-1 flex items-center gap-1 truncate text-foreground/80" title="This custom connector exposes a fixed read-only tool set.">
            <ShieldCheck className="size-3" /> Read only
          </p>
        )}
        {install.accessChange ? (
          <p className={install.accessChange.status === 'error' ? 'mt-0.5 truncate text-destructive' : 'mt-0.5 truncate text-brand'}>
            {install.accessChange.status === 'pending'
              ? `Changing to ${install.accessChange.targetLabel}…`
              : install.accessChange.error ?? 'Access mode change failed'}
          </p>
        ) : null}
      </div>
      <div role="cell" className="col-span-2 flex flex-wrap gap-1.5 sm:col-span-1 sm:justify-end">
        {(install.status === 'pending' || install.status === 'error') && install.ownedByMe ? (
          <Button variant="outline" size="sm" className="h-8 flex-1 rounded-lg px-2.5 sm:flex-none" onClick={onRetry} disabled={busy}>
            {install.status === 'pending' ? 'Finish sign-in' : 'Retry'}
          </Button>
        ) : null}
        {TESTABLE_CONNECTOR_SLUGS.includes(connector.slug) && (install.status === 'connected' || install.status === 'error') ? (
          <Button
            variant="outline"
            size="sm"
            className="h-8 flex-1 rounded-lg px-2.5 sm:flex-none"
            onClick={onTest}
            disabled={busy}
          >
            <RefreshCw className={`size-3.5 ${busy ? 'animate-spin' : ''}`} />
            Test connection
          </Button>
        ) : null}
        {connector.kind === 'composio' && install.status === 'connected' ? (
          <Button
            variant="ghost"
            size="sm"
            className="size-8 shrink-0 rounded-lg p-0 text-muted-foreground"
            onClick={onDetails}
            disabled={busy}
            aria-label={`${detailsExpanded ? 'Hide' : 'Show'} connected account details for ${connector.name}${install.label ? ` — ${install.label}` : ''}`}
            aria-expanded={detailsExpanded}
            aria-controls={`connector-details-${install.id}`}
            title="Connected account details"
          >
            <Info className="size-4" />
          </Button>
        ) : null}
        {install.canManage ? (
          <Button
            variant="ghost"
            size="sm"
            className="size-8 shrink-0 rounded-lg p-0 text-muted-foreground"
            onClick={onManage}
            disabled={busy}
            aria-label={`Edit access for ${connector.name}${install.label ? ` — ${install.label}` : ''}`}
            aria-expanded={accessExpanded}
            aria-controls={`connector-access-${install.id}`}
            title="Edit access"
          >
            <Settings2 className="size-4" />
          </Button>
        ) : null}
        {install.canManage ? (
          <Button
            variant="ghost"
            size="sm"
            className="size-8 shrink-0 rounded-lg p-0 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
            onClick={onRemove}
            disabled={busy}
            aria-label={`Disconnect ${connector.name}${install.label ? ` — ${install.label}` : ''}`}
            title="Disconnect"
          >
            <Trash2 className="size-4" />
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function AccountDetailsCard({ connector, install }: { connector: ConnectorInfo; install: ConnectorInstall }) {
  const [details, setDetails] = useState<ConnectorAccountDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(false);

  const load = useCallback(async (refresh = false) => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.connectorDetails(install.id, refresh);
      if (mounted.current) setDetails(result.details);
    } catch (err) {
      if (mounted.current) setError((err as Error).message);
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [install.id]);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
    };
  }, [load]);

  const analytics = details?.resources.find((resource) => resource.kind === 'googleAnalytics');
  const propertyCount = analytics?.accounts.reduce((total, account) => total + account.properties.length, 0) ?? 0;

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <p className="font-medium">Connected account details</p>
          <p className="text-xs text-muted-foreground">Loaded from {connector.name} only when you open this panel.</p>
        </div>
        {install.canManage ? (
          <Button
            variant="ghost"
            size="sm"
            className="h-8 shrink-0 rounded-lg px-2 text-xs text-muted-foreground"
            onClick={() => void load(true)}
            disabled={loading}
          >
            <RefreshCw className={`size-3.5 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        ) : null}
      </div>

      {loading && !details ? (
        <p role="status" className="flex items-center gap-2 rounded-xl border bg-background px-3 py-4 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading account details…
        </p>
      ) : null}
      {error ? (
        <div role="alert" className="rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-3 text-sm text-destructive">
          <p>{error}</p>
          <Button variant="outline" size="sm" className="mt-2 h-8 rounded-lg" onClick={() => void load(true)}>
            Try again
          </Button>
        </div>
      ) : null}

      {details ? (
        <div className="space-y-3">
          <div className="rounded-xl border bg-background px-3 py-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Authenticated identity</p>
            {details.identity ? (
              <div className="mt-1">
                <p className="font-medium">{details.identity.displayName ?? details.identity.email}</p>
                {details.identity.email && details.identity.email !== details.identity.displayName ? (
                  <p className="text-sm text-muted-foreground">{details.identity.email}</p>
                ) : null}
              </div>
            ) : (
              <p className="mt-1 text-sm text-muted-foreground">
                The provider did not share an account name or email for this connection.
              </p>
            )}
            {details.connectionStatus !== 'ACTIVE' ? (
              <p className="mt-2 flex items-center gap-1.5 text-sm text-destructive">
                <TriangleAlert className="size-4" /> Connection status: {details.connectionStatus.toLowerCase()}
              </p>
            ) : null}
          </div>

          {analytics ? (
            <div className="rounded-xl border bg-background px-3 py-3">
              <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
                <p className="font-medium">Google Analytics access</p>
                {analytics.status === 'ready' ? (
                  <p className="text-xs text-muted-foreground">
                    {analytics.accounts.length} {analytics.accounts.length === 1 ? 'account' : 'accounts'} · {propertyCount}{' '}
                    {propertyCount === 1 ? 'property' : 'properties'}
                  </p>
                ) : null}
              </div>
              {analytics.status === 'unavailable' ? (
                <p className="text-sm text-muted-foreground">The Analytics account list is currently unavailable.</p>
              ) : analytics.accounts.length === 0 ? (
                <p className="text-sm text-muted-foreground">No Google Analytics accounts are visible to this login.</p>
              ) : (
                <div className="max-h-80 space-y-2 overflow-x-hidden overflow-y-auto pr-1">
                  {analytics.accounts.map((account) => (
                    <details key={account.id} className="rounded-lg border bg-muted/10">
                      <summary className="cursor-pointer px-3 py-2.5 marker:text-muted-foreground">
                        <span className="inline-flex max-w-[calc(100%-1rem)] flex-wrap items-baseline gap-x-2 gap-y-0.5 align-middle">
                          <span className="font-medium">{account.name}</span>
                          <span className="break-all font-mono text-xs text-muted-foreground">{account.id}</span>
                          <span className="text-xs text-muted-foreground">
                            {account.properties.length} {account.properties.length === 1 ? 'property' : 'properties'}
                          </span>
                        </span>
                      </summary>
                      <div className="border-t px-3 py-2.5">
                        {account.properties.length ? (
                          <ul className="space-y-2">
                            {account.properties.map((property) => (
                              <li key={property.id} className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
                                <span>{property.name}</span>
                                <span className="break-all font-mono text-xs text-muted-foreground">{property.id}</span>
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <p className="text-sm text-muted-foreground">No GA4 properties were returned for this account.</p>
                        )}
                      </div>
                    </details>
                  ))}
                </div>
              )}
            </div>
          ) : null}

          {details.issues.length ? (
            <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 px-3 py-2.5 text-sm text-muted-foreground">
              {details.issues.map((issue) => <p key={issue}>{issue}</p>)}
            </div>
          ) : null}
          <p className="text-right text-[11px] text-muted-foreground">Updated {connectionAge(details.fetchedAt)}</p>
        </div>
      ) : null}
    </div>
  );
}

function LibraryCard({
  connector,
  ownCount,
  busy,
  onSetup,
}: {
  connector: ConnectorInfo;
  ownCount: number;
  busy: boolean;
  onSetup: () => void;
}) {
  const connectedCount = connector.installs.filter((install) => install.status === 'connected').length;
  return (
    <div className="flex flex-col items-center rounded-2xl border px-3 py-4 text-center">
      <ConnectorIcon slug={connector.slug} className="size-10" />
      <p className="mt-2.5 w-full truncate text-sm font-medium">{connector.name}</p>
      {connectedCount > 0 ? (
        <p className="mt-0.5 text-xs text-muted-foreground">{connectedCount} available</p>
      ) : (
        <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{connector.description}</p>
      )}
      <div className="mt-auto w-full pt-3">
        <Button
          variant={ownCount === 0 ? 'secondary' : 'outline'}
          size="sm"
          className="h-9 w-full rounded-xl"
          onClick={onSetup}
          disabled={busy}
        >
          {ownCount > 0 ? <Plus className="size-4" /> : null}
          {ownCount > 0 ? 'Add account' : 'Connect'}
        </Button>
      </div>
    </div>
  );
}

function AccessFields({
  sharing,
  scopeMode,
  projectIds,
  projects,
  canShare,
  onSharing,
  onScopeMode,
  onProjects,
}: {
  sharing: ConnectorSharing;
  scopeMode: ConnectorScopeMode;
  projectIds: string[];
  projects: Project[];
  canShare: boolean;
  onSharing: (sharing: ConnectorSharing) => void;
  onScopeMode: (mode: ConnectorScopeMode) => void;
  onProjects: (ids: string[]) => void;
}) {
  const toggleProject = (id: string) =>
    onProjects(projectIds.includes(id) ? projectIds.filter((value) => value !== id) : [...projectIds, id]);
  return (
    <div className="space-y-4">
      <fieldset>
        <legend className="mb-2 text-sm font-medium">Who can use it?</legend>
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            className={`rounded-xl border px-3 py-2.5 text-left ${sharing === 'personal' ? 'border-brand bg-brand/10' : ''}`}
            onClick={() => onSharing('personal')}
          >
            <span className="flex items-center gap-2 font-medium"><UserRound className="size-4" /> Only me</span>
            <span className="mt-1 block text-xs text-muted-foreground">Your chats only</span>
          </button>
          <button
            type="button"
            className={`rounded-xl border px-3 py-2.5 text-left ${sharing === 'shared' ? 'border-brand bg-brand/10' : ''}`}
            onClick={() => canShare && onSharing('shared')}
            disabled={!canShare}
          >
            <span className="flex items-center gap-2 font-medium"><UsersRound className="size-4" /> Everybody</span>
            <span className="mt-1 block text-xs text-muted-foreground">{canShare ? 'All users' : 'Admin only'}</span>
          </button>
        </div>
      </fieldset>

      <fieldset>
        <legend className="mb-2 text-sm font-medium">Available in</legend>
        <label className="mb-2 flex items-center gap-2 rounded-xl border px-3 py-2.5">
          <input type="radio" checked={scopeMode === 'all'} onChange={() => onScopeMode('all')} />
          <span>All projects</span>
        </label>
        <label className="flex items-center gap-2 rounded-xl border px-3 py-2.5">
          <input type="radio" checked={scopeMode === 'projects'} onChange={() => onScopeMode('projects')} />
          <span>Selected projects</span>
        </label>
        {scopeMode === 'projects' ? (
          <div className="mt-2 max-h-48 space-y-1 overflow-y-auto rounded-xl border p-2">
            {projects.length ? projects.map((project) => (
              <label key={project.id} className="flex items-center gap-2 rounded-lg px-2 py-2 hover:bg-accent/50">
                <input type="checkbox" checked={projectIds.includes(project.id)} onChange={() => toggleProject(project.id)} />
                <span className="min-w-0 truncate">{project.name}</span>
              </label>
            )) : <p className="px-2 py-3 text-sm text-muted-foreground">Create a project first.</p>}
          </div>
        ) : null}
      </fieldset>
    </div>
  );
}

export function AccessModeChoices({
  profiles,
  value,
  disabled = false,
  onChange,
}: {
  profiles: ConnectorAccessModeProfile[];
  value: ConnectorAccessMode | null;
  disabled?: boolean;
  onChange: (mode: ConnectorAccessMode) => void;
}) {
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {profiles.map((profile) => (
        <button
          key={`${profile.mode}:${profile.version}`}
          type="button"
          className={`rounded-xl border px-3 py-3 text-left ${value === profile.mode ? 'border-brand bg-brand/10' : ''}`}
          aria-pressed={value === profile.mode}
          onClick={() => onChange(profile.mode)}
          disabled={disabled}
        >
          <span className="flex items-center gap-2 font-medium">
            {profile.mode === 'read_only' ? <ShieldCheck className="size-4" /> : <LockKeyhole className="size-4" />}
            {profile.label}
            {profile.recommended ? <span className="text-[11px] font-normal text-brand">Recommended</span> : null}
          </span>
          <span className="mt-1 block text-xs text-muted-foreground">{profile.description}</span>
          <span className="mt-2 block space-y-1 text-xs text-muted-foreground">
            {profile.capabilities.map((capability) => <span key={capability} className="block">• {capability}</span>)}
          </span>
          {profile.providerPermissionNote ? (
            <span className="mt-2 flex items-start gap-1.5 rounded-lg border border-amber-500/30 bg-amber-500/5 px-2 py-2 text-xs text-muted-foreground">
              <TriangleAlert className="mt-px size-3.5 shrink-0 text-amber-700" />
              <span>{profile.providerPermissionNote}</span>
            </span>
          ) : null}
        </button>
      ))}
    </div>
  );
}

function SetupCard({
  connector,
  busy,
  withLabel,
  projects,
  initialProjectId,
  canShare,
  onCancel,
  onSubmit,
}: {
  connector: ConnectorInfo;
  busy: boolean;
  withLabel: boolean;
  projects: Project[];
  initialProjectId: string | null;
  canShare: boolean;
  onCancel: () => void;
  onSubmit: (opts: ConnectorInstallWrite) => void;
}) {
  const validInitial = initialProjectId && projects.some((project) => project.id === initialProjectId) ? initialProjectId : null;
  const [label, setLabel] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const [sharing, setSharing] = useState<ConnectorSharing>('personal');
  const [scopeMode, setScopeMode] = useState<ConnectorScopeMode>(validInitial ? 'projects' : 'all');
  const [projectIds, setProjectIds] = useState<string[]>(validInitial ? [validInitial] : []);
  const [accessMode, setAccessMode] = useState<ConnectorAccessMode | null>(
    connector.accessModes.find((profile) => profile.recommended)?.mode ?? connector.accessModes[0]?.mode ?? null,
  );
  const fieldsComplete = connector.fields.every((field) => field.required === false || (values[field.key] ?? '').trim());
  const scopeComplete = scopeMode === 'all' || projectIds.length > 0;
  const complete = fieldsComplete && scopeComplete && (!withLabel || label.trim()) &&
    (connector.accessModes.length === 0 || accessMode !== null);

  return (
    <div className="rounded-xl border px-4 py-4">
      <div className="mb-4 flex items-center gap-3">
        <ConnectorIcon slug={connector.slug} />
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">Set up {connector.name}</p>
          <p className="text-sm text-muted-foreground">{connector.description}</p>
        </div>
      </div>
      <div className="flex flex-col gap-4">
        {withLabel ? (
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Account name</span>
            <Input value={label} placeholder="Work" maxLength={40} onChange={(event) => setLabel(event.target.value)} className="h-12 rounded-xl px-4 text-base" />
          </label>
        ) : null}
        {connector.fields.map((field) => (
          <label key={field.key} className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">{field.label}</span>
            <Input
              type={field.type === 'secret' ? 'password' : 'text'}
              value={values[field.key] ?? ''}
              placeholder={field.placeholder}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              autoComplete="off"
              onChange={(event) => setValues((current) => ({ ...current, [field.key]: event.target.value }))}
              className="h-12 rounded-xl px-4 text-base"
            />
            {field.help ? <span className="text-xs text-muted-foreground">{field.help}</span> : null}
            {paperExposureWarning(connector.slug, values[field.key] ?? '') ? (
              <span className="flex items-start gap-1.5 text-xs text-destructive">
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                {paperExposureWarning(connector.slug, values[field.key] ?? '')}
              </span>
            ) : null}
          </label>
        ))}
        {connector.accessModes.length ? (
          <fieldset>
            <legend className="mb-2 text-sm font-medium">Choose access mode</legend>
            <AccessModeChoices profiles={connector.accessModes} value={accessMode} onChange={setAccessMode} />
          </fieldset>
        ) : connector.kind === 'composio' ? (
          <div className="flex items-start gap-2 rounded-xl border bg-muted/30 px-3 py-3">
            <LockKeyhole className="mt-0.5 size-4 shrink-0" />
            <div>
              <p className="text-sm font-medium">Full access</p>
              <p className="text-xs text-muted-foreground">
                This connection includes the full connector surface offered by Composio.
              </p>
            </div>
          </div>
        ) : null}
        <AccessFields
          sharing={sharing}
          scopeMode={scopeMode}
          projectIds={projectIds}
          projects={projects}
          canShare={canShare}
          onSharing={setSharing}
          onScopeMode={setScopeMode}
          onProjects={setProjectIds}
        />
        <div className="flex gap-2">
          <Button
            variant="secondary"
            className="h-11 flex-1 rounded-xl"
            onClick={() => onSubmit({
              settings: values,
              ...(withLabel ? { label: label.trim() } : {}),
              sharing,
              scopeMode,
              projectIds: scopeMode === 'projects' ? projectIds : [],
              ...(accessMode ? { accessMode } : {}),
            })}
            disabled={!complete || busy}
          >
            {busy ? 'Connecting…' : 'Connect'}
          </Button>
          <Button variant="ghost" className="h-11 rounded-xl" onClick={onCancel} disabled={busy}>Cancel</Button>
        </div>
      </div>
    </div>
  );
}

function EditAccessCard({
  connector,
  install,
  projects,
  canShare,
  busy,
  onCancel,
  onSave,
  onAccessMode,
  onCancelAccessMode,
}: {
  connector: ConnectorInfo;
  install: ConnectorInstall;
  projects: Project[];
  canShare: boolean;
  busy: boolean;
  onCancel: () => void;
  onSave: (access: ConnectorAccessWrite) => void;
  onAccessMode: (mode: ConnectorAccessMode) => void;
  onCancelAccessMode: () => void;
}) {
  const [sharing, setSharing] = useState(install.sharing);
  const [scopeMode, setScopeMode] = useState(install.scopeMode);
  const [projectIds, setProjectIds] = useState(install.projects.map((project) => project.id));
  const currentMode = install.accessMode?.mode ?? null;
  const [accessMode, setAccessMode] = useState<ConnectorAccessMode | null>(
    currentMode ?? connector.accessModes.find((profile) => profile.recommended)?.mode ?? connector.accessModes[0]?.mode ?? null,
  );
  const selectedProfile = connector.accessModes.find((profile) => profile.mode === accessMode);
  const profileChanged = Boolean(selectedProfile && (
    accessMode !== currentMode || selectedProfile.version !== install.accessMode?.version
  ));
  const complete = scopeMode === 'all' || projectIds.length > 0;
  return (
    <div className="space-y-5">
      {connector.accessModes.length ? (
        <fieldset>
          <legend className="mb-2 text-sm font-medium">Access mode</legend>
          <p className="mb-2 text-xs text-muted-foreground">
            An access change opens sign-in again. Your current connection stays active until the new connection is ready.
          </p>
          <AccessModeChoices
            profiles={connector.accessModes}
            value={accessMode}
            disabled={busy || Boolean(install.accessChange)}
            onChange={setAccessMode}
          />
          {install.accessMode?.mode === null ? (
            <p className="mt-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-muted-foreground">
              This account has existing access. Reconnect it to select and enforce Limited or Full access.
            </p>
          ) : null}
          {install.accessChange ? (
            <div className="mt-2 flex items-center justify-between gap-3 rounded-lg border bg-background px-3 py-2">
              <p className="text-xs">
                {install.accessChange.status === 'pending'
                  ? `Waiting to finish ${install.accessChange.targetLabel} sign-in.`
                  : install.accessChange.error ?? 'Access mode change failed.'}
              </p>
              <Button variant="ghost" size="sm" className="h-8 shrink-0" onClick={onCancelAccessMode} disabled={busy}>
                Cancel change
              </Button>
            </div>
          ) : accessMode && profileChanged ? (
            <Button
              variant="outline"
              className="mt-2 h-10 w-full rounded-xl"
              onClick={() => onAccessMode(accessMode)}
              disabled={busy}
            >
              {accessMode === currentMode ? 'Reconnect to update access' : 'Reconnect to change mode'}
            </Button>
          ) : null}
        </fieldset>
      ) : null}
      <div className={connector.accessModes.length ? 'border-t pt-5' : ''}>
        <AccessFields
          sharing={sharing}
          scopeMode={scopeMode}
          projectIds={projectIds}
          projects={projects}
          canShare={canShare}
          onSharing={setSharing}
          onScopeMode={setScopeMode}
          onProjects={setProjectIds}
        />
        <div className="mt-4 flex gap-2">
          <Button className="h-11 flex-1 rounded-xl" disabled={!complete || busy} onClick={() => onSave({ sharing, scopeMode, projectIds: scopeMode === 'projects' ? projectIds : [] })}>
            {busy ? 'Saving…' : 'Save access'}
          </Button>
          <Button variant="ghost" className="h-11 rounded-xl" disabled={busy} onClick={onCancel}>Cancel</Button>
        </div>
      </div>
    </div>
  );
}
