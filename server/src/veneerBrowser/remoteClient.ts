import fs from 'node:fs';
import path from 'node:path';
import tls from 'node:tls';
import { Agent } from 'undici';
import { loginHome, serviceHome } from '../homes.js';

const TIMEOUT_MS = 45_000;
// The LAN listener is either right there or it is not, so the reachability probe
// is the CONNECT alone: a Mac away from home loses two seconds once, not per
// request. Once connected the LAN attempt gets the caller's full budget, because
// starting a browser legitimately takes far longer than any probe.
const LAN_CONNECT_TIMEOUT_MS = 2_000;
const LAN_DOWN_MS = 60_000;

/**
 * Codes that can only mean the connection was never established, so nothing was
 * ever dispatched to the manager and re-sending over the tunnel is safe. Any
 * other failure — an overall timeout, a mid-request reset — may have left a
 * /promote, /save, /open or /clone already running on the other side.
 */
const CONNECT_FAILURE_CODES = new Set([
  'UND_ERR_CONNECT_TIMEOUT',
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
]);

function isConnectFailure(error: unknown): boolean {
  for (let current = error, depth = 0; current && depth < 8; depth += 1) {
    const item = current as { code?: unknown; name?: unknown; cause?: unknown };
    if (typeof item.code === 'string' && CONNECT_FAILURE_CODES.has(item.code)) return true;
    if (item.name === 'ConnectTimeoutError') return true;
    current = item.cause;
  }
  return false;
}

export interface BrowserIdentity {
  clientId: string;
  token: string;
}

export interface RemoteProfileStatus {
  active: boolean;
  status: string;
  runtimeId?: string;
}

export interface RemoteTicket {
  cdpUrl: string;
  viewerUrl: string;
  expiresAt: string;
}

export type RemoteTicketPurpose = 'viewer' | 'agent';

export interface RemoteViewerConnection extends RemoteTicket {
  /** Pinned certificate for a LAN address; null when the address is the tunnel. */
  caFile: string | null;
}

/**
 * One round trip that clones or adopts a warm copy and starts it. `cloneProfileId`
 * is the copy the manager ACTUALLY used, which differs from the requested id
 * whenever it adopted a pre-warmed one.
 */
export interface RemoteOpenResult extends RemoteTicket {
  cloneProfileId: string;
  adopted: boolean;
  sourceGeneration: number;
  runtimeId?: string;
}

export interface RemoteDownload {
  name: string;
  size: number;
  data: string;
}

export interface VeneerBrowserRemote {
  configured(): boolean;
  clientScope(): string;
  /** Path of the pinned LAN certificate while the LAN route is live, else null. */
  cdpCaFile(cdpUrl?: string): string | null;
  create(projectId: string, profileId: string, name: string): Promise<void>;
  createTemporary(projectId: string, profileId: string, name: string): Promise<void>;
  clone(projectId: string, sourceProfileId: string, cloneProfileId: string, name: string): Promise<{ sourceGeneration: number }>;
  promote(projectId: string, sourceProfileId: string, cloneProfileId: string, expectedGeneration: number): Promise<{ generation: number }>;
  saveTemporary(projectId: string, cloneProfileId: string, profileId: string, name: string): Promise<{ generation: number }>;
  rename(projectId: string, profileId: string, name: string): Promise<void>;
  delete(projectId: string, profileId: string): Promise<void>;
  start(projectId: string, profileId: string): Promise<RemoteProfileStatus>;
  stop(projectId: string, profileId: string): Promise<void>;
  status(projectId: string, profileId: string): Promise<RemoteProfileStatus>;
  open(
    projectId: string,
    sourceProfileId: string,
    cloneProfileId: string,
    purpose: RemoteTicketPurpose,
  ): Promise<RemoteOpenResult>;
  ticket(projectId: string, profileId: string, purpose: RemoteTicketPurpose): Promise<RemoteTicket>;
  /**
   * A viewer ticket for THIS server's own screencast connection. Unlike
   * ticket(), it may be minted over the LAN listener, so the address comes back
   * on the LAN host and `caFile` is the certificate that connection must pin.
   */
  viewerConnection(projectId: string, profileId: string): Promise<RemoteViewerConnection>;
  downloads(projectId: string, profileId: string): Promise<RemoteDownload[]>;
}

export class VeneerBrowserRemoteError extends Error {
  constructor(readonly status: number) {
    super(`Veneer Browser manager returned HTTP ${status}.`);
    this.name = 'VeneerBrowserRemoteError';
  }
}

export function isVeneerBrowserRemoteError(error: unknown, status: number): boolean {
  return error instanceof VeneerBrowserRemoteError && error.status === status;
}

function parseEnvFile(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)\s*$/.exec(line);
    if (!match) continue;
    let value = match[2] ?? '';
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[match[1]!] = value;
  }
  return out;
}

function safeIdentity(value: Record<string, string | undefined>): BrowserIdentity | null {
  const clientId = (value.VP_VENEER_BROWSER_CLIENT_ID ?? '').trim();
  const token = (value.VP_VENEER_BROWSER_TOKEN ?? '').trim();
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(clientId) || !token || token.length > 1000) return null;
  return { clientId, token };
}

function identityFilesUnder(home: string): string[] {
  return [path.join(home, '.config', 'veneer-pro', 'browser.env')];
}

export function readBrowserIdentity(explicitFile?: string | null): BrowserIdentity | null {
  const direct = safeIdentity(process.env);
  if (direct) return direct;
  const candidates = [
    explicitFile,
    process.env.VP_VENEER_BROWSER_IDENTITY_FILE,
    ...identityFilesUnder(serviceHome()),
    // The installer writes browser.env under the login home. When the service
    // runs with a separate VP_SERVICE_HOME, this fallback still finds it.
    ...(loginHome() === serviceHome() ? [] : identityFilesUnder(loginHome())),
  ].filter((item): item is string => Boolean(item));
  for (const file of candidates) {
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile() || (stat.mode & 0o077) !== 0) continue;
      const identity = safeIdentity(parseEnvFile(file));
      if (identity) return identity;
    } catch {
      // Missing or unreadable identity means this instance is not configured.
    }
  }
  return null;
}

// Compared by host, not by origin: a ticket is a wss: address while the base is
// https:, so their origins never match even when they name the same listener.
function sameHost(url: string, base: string): boolean {
  try {
    return new URL(url).host === new URL(base).host;
  } catch {
    return false;
  }
}

export function createVeneerBrowserRemote(options: {
  baseUrl: string | null;
  identityFile?: string | null;
  lanUrl?: string | null;
  lanCaFile?: string | null;
  fetchImpl?: typeof fetch;
}): VeneerBrowserRemote {
  const fetchImpl = options.fetchImpl ?? fetch;
  const identity = (): BrowserIdentity | null => readBrowserIdentity(options.identityFile);
  const configured = (): boolean => Boolean(options.baseUrl && identity());

  // The manager's listener presents a self-signed certificate, so it is reachable
  // only through a dispatcher that trusts exactly that file. An unreadable file
  // means no pinned route at all: every request then behaves as it did before.
  const baseUrl = options.baseUrl ? options.baseUrl.replace(/\/+$/, '') : null;
  let pinnedCaPem: string | null = null;
  let lanCaFile: string | null = null;
  if (options.lanCaFile) {
    try {
      pinnedCaPem = fs.readFileSync(options.lanCaFile, 'utf8');
      lanCaFile = options.lanCaFile;
    } catch {
      // No pinned certificate on this machine, so only publicly trusted roots
      // remain. Say so once: a pinned certificate that is set but silently
      // ignored looks like a working shortcut. The path is not a secret; the
      // bearer token is, and never appears here.
      console.warn(
        `Veneer Browser: LAN shortcut disabled — the pinned certificate at ${options.lanCaFile} could not be read. Using the tunnel only.`,
      );
    }
  }
  let lanAgent: Agent | null = null;
  let lanBase: string | null = null;
  if (options.lanUrl && pinnedCaPem) {
    lanAgent = new Agent({ connect: { ca: pinnedCaPem, timeout: LAN_CONNECT_TIMEOUT_MS } });
    lanBase = options.lanUrl.replace(/\/+$/, '');
  }
  // Who does the pinned certificate belong to? With a separate LAN listener
  // configured it is that listener's, and the base URL is the publicly trusted
  // tunnel. With no second address it can only be the base URL's own — which is
  // the Veneer OS shape, where the manager is this Mac's self-signed
  // https://localhost:7301. Then every connection to it has to pin, instead of
  // depending on NODE_EXTRA_CA_CERTS happening to be set for the service.
  const baseIsPinned = Boolean(pinnedCaPem && baseUrl && (!lanBase || sameHost(lanBase, baseUrl)));
  // Additive, unlike the LAN dispatcher: `ca` replaces the default root set, so
  // the system roots are carried along in case this base is publicly trusted
  // after all. Only TLS origins get a dispatcher at all.
  const baseAgent =
    baseIsPinned && pinnedCaPem && baseUrl?.startsWith('https:')
      ? new Agent({ connect: { ca: [...tls.rootCertificates, pinnedCaPem] } })
      : null;

  /**
   * The pinned certificate for a ticket address, or null when that address is
   * not one we pinned. Only the two hosts we actually trust qualify — the LAN
   * listener and, on Veneer OS, the base URL itself — so a ticket naming any
   * other host never hands our private root to it.
   */
  const pinnedFor = (url: string): string | null => {
    if (!lanCaFile) return null;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    // A cleartext address has no certificate to pin in the first place.
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'wss:') return null;
    if (lanBase && sameHost(url, lanBase)) return lanCaFile;
    if (baseIsPinned && baseUrl && sameHost(url, baseUrl)) return lanCaFile;
    return null;
  };
  // A LAN miss is remembered briefly so a laptop away from home pays the probe
  // once a minute rather than on every single call.
  let lanDownUntil = 0;

  const send = (
    base: string,
    route: string,
    init: RequestInit,
    auth: BrowserIdentity,
    timeoutMs: number,
    dispatcher?: Agent,
  ): Promise<Response> =>
    fetchImpl(`${base}${route}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${auth.token}`,
        Accept: 'application/json',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      },
      signal: AbortSignal.timeout(timeoutMs),
      ...(dispatcher ? { dispatcher } : {}),
    } as RequestInit);

  async function request<T>(
    route: string,
    init: RequestInit = {},
    timeoutMs = TIMEOUT_MS,
    tunnelOnly = false,
  ): Promise<T> {
    const auth = identity();
    if (!baseUrl || !auth) throw new Error('Veneer Browser is not configured on this client.');
    let response: Response | null = null;
    if (lanBase && lanAgent && !tunnelOnly && Date.now() >= lanDownUntil) {
      try {
        response = await send(lanBase, route, init, auth, timeoutMs, lanAgent);
      } catch (error) {
        // Only a failure to establish the connection falls back, because only
        // then is it certain the manager never saw the request. Anything else —
        // an overall timeout, a reset mid-flight — may already have promoted,
        // saved or opened something, and re-sending it over the tunnel would
        // report a conflict for work that actually succeeded.
        // An HTTP status from the LAN is the manager's own answer either way,
        // and is never retried over the tunnel.
        if (!isConnectFailure(error)) throw error;
        lanDownUntil = Date.now() + LAN_DOWN_MS;
      }
    }
    if (!response) response = await send(baseUrl, route, init, auth, timeoutMs, baseAgent ?? undefined);
    if (!response.ok) {
      // Do not include the response body. It can contain a short-lived control ticket.
      throw new VeneerBrowserRemoteError(response.status);
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  const encoded = (projectId: string, profileId: string): string =>
    `/v1/profiles/${encodeURIComponent(profileId)}?projectId=${encodeURIComponent(projectId)}`;
  const post = (projectId: string, profileId: string, action: string): Promise<any> =>
    request(`/v1/profiles/${encodeURIComponent(profileId)}/${action}`, {
      method: 'POST',
      body: JSON.stringify({ projectId }),
    });

  return {
    configured,
    clientScope() {
      return identity()?.clientId ?? '';
    },
    cdpCaFile(cdpUrl) {
      if (!lanCaFile) return null;
      // A tunnel address is trusted by the public roots already; only a pinned
      // address — the LAN listener, or this Mac's own manager on Veneer OS —
      // has to carry its certificate to agent-browser.
      if (!cdpUrl) return lanCaFile;
      return pinnedFor(cdpUrl);
    },
    create: (projectId, profileId, name) =>
      request('/v1/profiles', { method: 'POST', body: JSON.stringify({ projectId, profileId, name }) }).then(() => undefined),
    createTemporary: (projectId, profileId, name) =>
      request('/v1/temporary-profiles', {
        method: 'POST',
        body: JSON.stringify({ projectId, profileId, name }),
      }).then(() => undefined),
    clone: (projectId, sourceProfileId, cloneProfileId, name) =>
      request<{ profile: { sourceGeneration?: number } }>(`/v1/profiles/${encodeURIComponent(sourceProfileId)}/clone`, {
        method: 'POST',
        body: JSON.stringify({ projectId, cloneProfileId, name }),
      }, 3 * 60_000).then((value) => ({ sourceGeneration: value.profile.sourceGeneration ?? 1 })),
    promote: (projectId, sourceProfileId, cloneProfileId, expectedGeneration) =>
      request<{ profile: { generation?: number } }>(`/v1/profiles/${encodeURIComponent(sourceProfileId)}/promote`, {
        method: 'POST',
        body: JSON.stringify({ projectId, cloneProfileId, expectedGeneration }),
      }, 3 * 60_000).then((value) => ({ generation: value.profile.generation ?? expectedGeneration + 1 })),
    saveTemporary: (projectId, cloneProfileId, profileId, name) =>
      request<{ profile: { generation?: number } }>(`/v1/profiles/${encodeURIComponent(cloneProfileId)}/save`, {
        method: 'POST',
        body: JSON.stringify({ projectId, profileId, name }),
      }, 3 * 60_000).then((value) => ({ generation: value.profile.generation ?? 1 })),
    rename: (projectId, profileId, name) =>
      request(encoded(projectId, profileId), { method: 'PATCH', body: JSON.stringify({ projectId, name }) }).then(() => undefined),
    delete: (projectId, profileId) => request(encoded(projectId, profileId), { method: 'DELETE' }).then(() => undefined),
    start: (projectId, profileId) => post(projectId, profileId, 'start'),
    stop: (projectId, profileId) => post(projectId, profileId, 'stop').then(() => undefined),
    status: (projectId, profileId) => request(encoded(projectId, profileId)),
    open: (projectId, sourceProfileId, cloneProfileId, purpose) =>
      request<Partial<RemoteOpenResult> & RemoteTicket>(
        `/v1/profiles/${encodeURIComponent(sourceProfileId)}/open`,
        { method: 'POST', body: JSON.stringify({ projectId, cloneProfileId, purpose }) },
        3 * 60_000,
      ).then((value) => ({
        cloneProfileId: value.cloneProfileId ?? cloneProfileId,
        adopted: value.adopted === true,
        sourceGeneration: value.sourceGeneration ?? 1,
        cdpUrl: value.cdpUrl,
        viewerUrl: value.viewerUrl,
        expiresAt: value.expiresAt,
        ...(value.runtimeId ? { runtimeId: value.runtimeId } : {}),
      })),
    ticket: (projectId, profileId, purpose) =>
      // Always the tunnel, whoever the ticket is for. The address in the reply
      // is derived from the host that was asked, and neither consumer can reach
      // a LAN one: a viewer address opens in the user's own browser, and the
      // agent-browser CLI carries its own certificate roots that no environment
      // variable can add to. Only /open takes the LAN shortcut.
      request(`/v1/profiles/${encodeURIComponent(profileId)}/ticket`, {
        method: 'POST',
        body: JSON.stringify({ projectId, purpose }),
      }, TIMEOUT_MS, true),
    viewerConnection: (projectId, profileId) =>
      // The server itself is the consumer here, and it holds the pinned LAN
      // certificate, so this one ticket may take the LAN shortcut: the
      // screencast then never leaves the building.
      request<RemoteTicket>(`/v1/profiles/${encodeURIComponent(profileId)}/ticket`, {
        method: 'POST',
        body: JSON.stringify({ projectId, purpose: 'viewer' }),
      }).then((value) => ({
        cdpUrl: value.cdpUrl,
        viewerUrl: value.viewerUrl,
        expiresAt: value.expiresAt,
        caFile: pinnedFor(value.viewerUrl),
      })),
    downloads: (projectId, profileId) =>
      request<{ files: RemoteDownload[] }>(
        `/v1/profiles/${encodeURIComponent(profileId)}/downloads?projectId=${encodeURIComponent(projectId)}`,
      )
        .then((value) => value.files ?? []),
  };
}
