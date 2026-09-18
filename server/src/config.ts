import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3100),
  DATA_DIR: z
    .string()
    .default(path.join(os.homedir(), '.local', 'share', 'veneer-pro')),
  // Fails closed: a deployment that never sets this refuses to start rather
  // than silently handing owner access to every caller (see loadConfig).
  VP_IDENTITY: z.enum(['cloudflare', 'dev']).default('cloudflare'),
  VP_CF_TEAM_DOMAIN: z.string().optional(),
  VP_CF_AUD: z.string().optional(),
  // The identity every request is attributed to under VP_IDENTITY=dev.
  VP_DEV_EMAIL: z.string().trim().min(1).default('owner@example.com'),
  VP_CLAUDE_BIN: z.string().default('claude'),
  VP_CODEX_BIN: z.string().default('codex'),
  VP_GROK_BIN: z.string().default('grok'),
  // Live source checkout the Platform Dev agent edits + builds + restarts.
  VP_SOURCE_DIR: z.string().default(path.join(os.homedir(), 'veneer-pro')),
  // Absolute ceiling on one turn. It is no longer the primary guard: liveness is
  // measured by VP_TURN_INACTIVITY_MS below, and this only reaps a turn that
  // stays busy-looking forever (see providers/turnWatchdog.ts).
  VP_TURN_TIMEOUT_MS: z.coerce.number().int().positive().default(6 * 60 * 60 * 1000),
  // Idle time with no provider progress before a turn is reaped. Poll-style
  // tool calls deliberately do not count as progress.
  VP_TURN_INACTIVITY_MS: z.coerce.number().int().positive().default(15 * 60 * 1000),
  VP_APPROVAL_TIMEOUT_MS: z.coerce.number().int().positive().default(10 * 60 * 1000),
  SONIOX_API_KEY: z.string().optional(),
  // Legacy OpenRouter environment fallback. Client Doppler sits ahead of this;
  // Settings → API Keys remains the highest-precedence local override.
  OPENROUTER_API_KEY: z.string().optional(),
  // Shared cross-provider memory. The generated self-hosted API key is kept in
  // the service env; leaving it unset disables memory without affecting chats.
  SUPERMEMORY_BASE_URL: z.string().url().default('http://127.0.0.1:6767'),
  SUPERMEMORY_API_KEY: z.string().optional(),
  // Composio account key — powers hosted connectors (Gmail etc., #/connectors).
  COMPOSIO_API_KEY: z.string().optional(),
  // Verifies provider events delivered to POST /webhooks/composio. This is the
  // project webhook subscription secret, not the Composio API key.
  COMPOSIO_WEBHOOK_SECRET: z.string().optional(),
  // Runner IPC: the standalone agent-execution process binds this loopback port;
  // web talks to it there (runner/client.ts). Same env file both services read.
  // fill_email_code (Veneer Browser): the ONE mailbox whose emailed
  // verification codes the runner may read, through the shared Gmail
  // connector labeled with this address. Unset disables the tool.
  VP_EMAIL_CODE_MAILBOX: z.string().trim().email().optional(),
  // Comma-separated sender addresses or domains a code may come from; the
  // agent can narrow this list but never widen it. Empty accepts any sender.
  VP_EMAIL_CODE_SENDERS: z.string().optional(),
  // Optional user_connectors.id pin when more than one shared install carries the label.
  VP_EMAIL_CODE_CONNECTOR_ID: z.coerce.number().int().positive().optional(),
  VP_RUNNER_PORT: z.coerce.number().int().positive().default(3101),
  // Local Mini App runner IPC. It is a separate service so an app crash or
  // restart cannot disturb the web process or active agent turns.
  VP_APP_RUNNER_PORT: z.coerce.number().int().positive().default(3102),
  // Browser-terminal IPC. Its own service so shells outlive a web restart: a
  // ship swaps the web process while the ptys keep running here.
  VP_TERM_PORT: z.coerce.number().int().positive().default(3103),
  // Desktop transport. 'vnc' pipes /ws/desktop to x11vnc (Linux only: needs
  // Xvfb + openbox + x11vnc + noVNC). 'cdp' streams the shared Chrome over the
  // DevTools protocol instead, which needs no display server and so works on
  // macOS too. Default stays 'vnc' until the CDP path has soaked on the canary.
  VP_DESKTOP_MODE: z.enum(['vnc', 'cdp']).default('vnc'),
  // Loopback DevTools port of the shared desktop Chrome. agentBrowser drives the
  // same browser on this port via `--cdp`.
  VP_DESKTOP_CDP_PORT: z.coerce.number().int().positive().default(9223),
  // First-party browser manager. On Veneer OS it runs on this same Mac as
  // com.veneer.browser-manager, so the default is its loopback TLS listener —
  // https, because the ticket and CDP gates accept nothing else, and its
  // self-signed certificate is trusted through NODE_EXTRA_CA_CERTS (set in the
  // launchd plists by installer/install-darwin.mjs). Point this elsewhere to use
  // a manager on another host. The bearer identity is read from a user-only
  // file (browser.env) and is never part of Config.
  VP_VENEER_BROWSER_URL: z.string().url().default('https://localhost:7301'),
  VP_VENEER_BROWSER_IDENTITY_FILE: z.string().optional(),
  // Optional shortcut to the same manager over the LAN, skipping the tunnel when
  // the manager is on another host on this network. Both must be set: the URL of
  // the manager's LAN TLS listener, and the file holding its self-signed
  // certificate to pin. https only: the LAN request carries the same bearer
  // identity as the tunnel, and a pinned certificate is the whole point of this
  // route. A local manager needs neither — VP_VENEER_BROWSER_URL already is the
  // short path — so both stay unset on a stock Veneer OS install, while
  // VP_VENEER_BROWSER_LAN_CA still records where the loopback certificate is.
  VP_VENEER_BROWSER_LAN_URL: z
    .string()
    .url()
    .refine((value) => value.startsWith('https://'), {
      message: 'VP_VENEER_BROWSER_LAN_URL must start with https:// so the client token is never sent in cleartext.',
    })
    .optional(),
  VP_VENEER_BROWSER_LAN_CA: z.string().optional(),
  // Direct LAN listener for the Veneer Browser live view: a hostname with a
  // real certificate that resolves to this machine's LAN address. The app stays
  // behind the public hostname; only the ticketed viewer socket is served here.
  // Host, cert and key must all be set for the listener to start.
  VP_LAN_VIEWER_HOST: z.string().trim().min(1).optional(),
  VP_LAN_VIEWER_PORT: z.coerce.number().int().positive().max(65_535).default(3443),
  VP_LAN_VIEWER_CERT: z.string().optional(),
  VP_LAN_VIEWER_KEY: z.string().optional(),
  // Pages publishing (Cloudflare R2). All optional; publishing stays disabled
  // unless account id, api token AND public base are all present (see Config.pages).
  VP_PAGES_CF_ACCOUNT_ID: z.string().optional(),
  VP_PAGES_CF_API_TOKEN: z.string().optional(),
  VP_PAGES_BUCKET: z.string().default('veneer-pages'),
  VP_PAGES_PUBLIC_BASE: z.string().optional(),
  // Mini-app publishing (one isolated Cloudflare Worker + route per app).
  // Kept separate from Pages because the Workers token needs broader scope.
  VP_APPS_CF_ACCOUNT_ID: z.string().optional(),
  VP_APPS_CF_API_TOKEN: z.string().optional(),
  VP_APPS_CF_ZONE_ID: z.string().optional(),
  VP_APPS_PUBLIC_ORIGIN: z.string().url().optional(),
});

export interface Config {
  port: number;
  dataDir: string;
  identity: 'cloudflare' | 'dev';
  cfTeamDomain: string | null;
  cfAud: string | null;
  claudeBin: string;
  codexBin: string;
  grokBin: string;
  /** Live source checkout the Platform Dev agent operates on (cwd + build + restart). */
  sourceDir: string;
  /** Absolute per-turn ceiling; the inactivity window below is the real guard. */
  turnTimeoutMs: number;
  /** Idle time with no provider progress before a turn is reaped. */
  turnInactivityMs: number;
  /** Pending approvals auto-deny after this long (spec workstream B: 10 min). */
  approvalTimeoutMs: number;
  /** Fixed identity used when identity mode is `dev`. */
  devEmail: string;
  /** Soniox API key for realtime dictation. */
  sonioxApiKey: string | null;
  /** Default OpenRouter API key; overridable in Settings → API Keys. */
  openRouterApiKey: string | null;
  /** Loopback self-hosted Supermemory endpoint. */
  supermemoryBaseUrl: string;
  /** Self-hosted Supermemory bearer key; null disables all memory features. */
  supermemoryApiKey: string | null;
  /** Composio account key for hosted connectors; overridable in Settings → API Keys. */
  composioApiKey: string | null;
  /** Server-only signature secret for the public Composio webhook ingress. */
  composioWebhookSecret: string | null;
  /** Mailbox fill_email_code reads through the shared Gmail connector, or null when the tool is off. */
  emailCode: { mailbox: string; senders: string[]; connectorId: number | null } | null;
  /** Loopback port the runner's IPC server binds; web's runner client dials it. */
  runnerPort: number;
  /** Loopback port the local Mini App runner binds. */
  appRunnerPort: number;
  /** Loopback port the terminal service binds; web's /ws/term relay dials it. */
  termPort: number;
  /** Desktop transport: the portable CDP screencast, or the Linux-only VNC pipe. */
  desktopMode: 'vnc' | 'cdp';
  /** Loopback DevTools port of the shared desktop Chrome. */
  desktopCdpPort: number;
  /** Control-plane origin of the browser manager; on Veneer OS, this Mac's own. */
  veneerBrowserUrl: string | null;
  /** Optional explicit path to the machine's client identity file. */
  veneerBrowserIdentityFile: string | null;
  /** Optional LAN origin of the same browser manager, tried before the one above. */
  veneerBrowserLanUrl: string | null;
  /**
   * Certificate file pinning the manager's self-signed listener, LAN or
   * loopback. It is also the one root handed to the agent-browser CLI, which
   * inherits none of this process's own (mcp/agentBrowser.ts).
   */
  veneerBrowserLanCa: string | null;
  /** Direct LAN viewer listener, or null when not configured on this host. */
  lanViewer: { host: string; port: number; certFile: string; keyFile: string } | null;
  /**
   * Cloudflare R2 config for the Pages feature, or null when publishing is not
   * configured. Non-null requires accountId, apiToken AND publicBase all set.
   */
  pages: { accountId: string; apiToken: string; bucket: string; publicBase: string } | null;
  /** Stable origin shared by Cloudflare and local Mini App deployments. */
  appPublicOrigin: string | null;
  /** Non-secret Mini App deployment identity, retained when the API token comes from Doppler. */
  miniAppsBase: {
    accountId: string;
    zoneId: string;
    publicOrigin: string;
    tenant: string;
  } | null;
  /** Cloudflare Workers configuration for private mini apps, or null when disabled. */
  miniApps: {
    accountId: string;
    apiToken: string;
    zoneId: string;
    publicOrigin: string;
    tenant: string;
  } | null;
}

/** All-or-nothing: a half-configured LAN listener is a mistake worth stopping on. */
function lanViewerConfig(parsed: {
  VP_LAN_VIEWER_HOST?: string;
  VP_LAN_VIEWER_PORT: number;
  VP_LAN_VIEWER_CERT?: string;
  VP_LAN_VIEWER_KEY?: string;
}): Config['lanViewer'] {
  const set = [parsed.VP_LAN_VIEWER_HOST, parsed.VP_LAN_VIEWER_CERT, parsed.VP_LAN_VIEWER_KEY].filter(Boolean).length;
  if (set === 0) return null;
  if (set !== 3) {
    throw new Error('VP_LAN_VIEWER_HOST, VP_LAN_VIEWER_CERT and VP_LAN_VIEWER_KEY must all be set to enable the LAN viewer listener.');
  }
  return {
    host: parsed.VP_LAN_VIEWER_HOST!,
    port: parsed.VP_LAN_VIEWER_PORT,
    certFile: path.resolve(parsed.VP_LAN_VIEWER_CERT!),
    keyFile: path.resolve(parsed.VP_LAN_VIEWER_KEY!),
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.parse(env);
  if (parsed.VP_IDENTITY === 'cloudflare' && (!parsed.VP_CF_TEAM_DOMAIN || !parsed.VP_CF_AUD)) {
    throw new Error(
      'VP_IDENTITY=cloudflare requires VP_CF_TEAM_DOMAIN and VP_CF_AUD. Set both to put this ' +
        'deployment behind Cloudflare Access, or set VP_IDENTITY=dev to opt into the local ' +
        'development identity, which authenticates nobody and must stay on localhost.',
    );
  }
  const dataDir = parsed.DATA_DIR.startsWith('~')
    ? path.join(os.homedir(), parsed.DATA_DIR.slice(1))
    : parsed.DATA_DIR;
  const appPublicOrigin = parsed.VP_APPS_PUBLIC_ORIGIN?.replace(/\/+$/, '') ?? null;
  const miniAppsBase =
    parsed.VP_APPS_CF_ACCOUNT_ID && parsed.VP_APPS_CF_ZONE_ID && appPublicOrigin
      ? {
          accountId: parsed.VP_APPS_CF_ACCOUNT_ID,
          zoneId: parsed.VP_APPS_CF_ZONE_ID,
          publicOrigin: appPublicOrigin,
          tenant: new URL(appPublicOrigin).hostname.split('.')[0] || 'veneer',
        }
      : null;
  return {
    port: parsed.PORT,
    dataDir: path.resolve(dataDir),
    identity: parsed.VP_IDENTITY,
    cfTeamDomain: parsed.VP_CF_TEAM_DOMAIN ?? null,
    cfAud: parsed.VP_CF_AUD ?? null,
    claudeBin: parsed.VP_CLAUDE_BIN,
    codexBin: parsed.VP_CODEX_BIN,
    grokBin: parsed.VP_GROK_BIN,
    sourceDir: path.resolve(
      parsed.VP_SOURCE_DIR.startsWith('~')
        ? path.join(os.homedir(), parsed.VP_SOURCE_DIR.slice(1))
        : parsed.VP_SOURCE_DIR,
    ),
    turnTimeoutMs: parsed.VP_TURN_TIMEOUT_MS,
    turnInactivityMs: parsed.VP_TURN_INACTIVITY_MS,
    approvalTimeoutMs: parsed.VP_APPROVAL_TIMEOUT_MS,
    devEmail: parsed.VP_DEV_EMAIL,
    sonioxApiKey: parsed.SONIOX_API_KEY ?? null,
    openRouterApiKey: parsed.OPENROUTER_API_KEY ?? null,
    supermemoryBaseUrl: parsed.SUPERMEMORY_BASE_URL.replace(/\/+$/, ''),
    supermemoryApiKey: parsed.SUPERMEMORY_API_KEY?.trim() || null,
    composioApiKey: parsed.COMPOSIO_API_KEY ?? null,
    composioWebhookSecret: parsed.COMPOSIO_WEBHOOK_SECRET ?? null,
    emailCode: parsed.VP_EMAIL_CODE_MAILBOX
      ? {
          mailbox: parsed.VP_EMAIL_CODE_MAILBOX.toLowerCase(),
          senders: (parsed.VP_EMAIL_CODE_SENDERS ?? '').split(',').map((entry) => entry.trim().toLowerCase()).filter(Boolean),
          connectorId: parsed.VP_EMAIL_CODE_CONNECTOR_ID ?? null,
        }
      : null,
    runnerPort: parsed.VP_RUNNER_PORT,
    appRunnerPort: parsed.VP_APP_RUNNER_PORT,
    termPort: parsed.VP_TERM_PORT,
    desktopMode: parsed.VP_DESKTOP_MODE,
    desktopCdpPort: parsed.VP_DESKTOP_CDP_PORT,
    veneerBrowserUrl: parsed.VP_VENEER_BROWSER_URL.replace(/\/+$/, ''),
    veneerBrowserIdentityFile: parsed.VP_VENEER_BROWSER_IDENTITY_FILE
      ? path.resolve(parsed.VP_VENEER_BROWSER_IDENTITY_FILE)
      : null,
    veneerBrowserLanUrl: parsed.VP_VENEER_BROWSER_LAN_URL?.replace(/\/+$/, '') ?? null,
    veneerBrowserLanCa: parsed.VP_VENEER_BROWSER_LAN_CA
      ? path.resolve(parsed.VP_VENEER_BROWSER_LAN_CA)
      : null,
    lanViewer: lanViewerConfig(parsed),
    pages:
      parsed.VP_PAGES_CF_ACCOUNT_ID && parsed.VP_PAGES_CF_API_TOKEN && parsed.VP_PAGES_PUBLIC_BASE
        ? {
            accountId: parsed.VP_PAGES_CF_ACCOUNT_ID,
            apiToken: parsed.VP_PAGES_CF_API_TOKEN,
            bucket: parsed.VP_PAGES_BUCKET,
            publicBase: parsed.VP_PAGES_PUBLIC_BASE.replace(/\/+$/, ''),
          }
        : null,
    appPublicOrigin,
    miniAppsBase,
    miniApps:
      miniAppsBase && parsed.VP_APPS_CF_API_TOKEN
        ? { ...miniAppsBase, apiToken: parsed.VP_APPS_CF_API_TOKEN }
        : null,
  };
}

/**
 * Dev identity resolves every request to the fixed owner without verifying
 * anything. Call once per process at startup so the operator sees the mode,
 * rather than logging it per request.
 */
export function warnIfDevIdentity(config: Config, log: Pick<Console, 'warn'> = console): void {
  if (config.identity !== 'dev') return;
  log.warn(
    `[veneer-pro] VP_IDENTITY=dev — every request resolves to ${config.devEmail} with no ` +
      'authentication. Never expose this process beyond localhost.',
  );
}
