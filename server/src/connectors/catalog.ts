import { fileURLToPath } from 'node:url';
import type { McpConfig } from '../toolbox/connections.js';
import { normalizeNetSuiteAccountId } from './netsuite/config.js';
import { PAPER_DEFAULT_MCP_URL, resolvePaperMcpUrl, validatePaperSettings } from './paper/config.js';
import { validateRingCentralSettings } from './ringcentral/config.js';
import {
  GMAIL_ACCESS_MODES,
  HUBSPOT_ACCESS_MODES,
  GOOGLE_ADS_ACCESS_MODES,
  GOOGLE_ANALYTICS_ACCESS_MODES,
  GOOGLE_DOCS_ACCESS_MODES,
  GOOGLE_DRIVE_ACCESS_MODES,
  GOOGLE_SHEETS_ACCESS_MODES,
  QUICKBOOKS_ACCESS_MODES,
  type ConnectorAccessModeProfile,
} from './accessModes.js';

// The compiled NetSuite MCP server, resolved next to this file in dist/ (works
// wherever the repo lives). Spawned per turn with the install's credentials.
const NETSUITE_MCP_SERVER = fileURLToPath(new URL('./netsuite/mcpServer.js', import.meta.url));
const RINGCENTRAL_MCP_SERVER = fileURLToPath(new URL('./ringcentral/mcpServer.js', import.meta.url));

/**
 * The Connectors catalog (Settings → Connectors). Code-defined: each entry is either a
 * Composio-hosted integration (OAuth + tokens live with Composio, we store a
 * per-user MCP endpoint), or a custom one configured via `fields`. Installs
 * are per user — see the user_connectors table and routes/connectors.ts.
 */

export interface ConnectorFieldDef {
  key: string;
  label: string;
  /** 'secret' renders as a password input; values are never echoed back over the API. */
  type: 'text' | 'secret';
  placeholder?: string;
  help?: string;
  required?: boolean;
}

export interface ConnectorDef {
  slug: string;
  name: string;
  description: string;
  kind: 'composio' | 'custom';
  composio?: { toolkit: string };
  /** Optional versioned access choices. Connector-specific settings stay separate. */
  accessModes?: readonly ConnectorAccessModeProfile[];
  /** Settings a custom connector asks for at install time. */
  fields?: ConnectorFieldDef[];
  /** Custom kind only: reject malformed settings before persisting them. */
  validateSettings?: (settings: Record<string, string>) => string | null;
  /** Custom kind only: turn the user's saved settings into an MCP server entry. */
  buildMcp?: (settings: Record<string, string>) => McpConfig | null;
}

export const CONNECTOR_DEFS: ConnectorDef[] = [
  {
    slug: 'netsuite',
    name: 'NetSuite',
    description: 'Look up data in your NetSuite account (read-only): run SuiteQL queries and pull records to build reports.',
    kind: 'custom',
    fields: [
      {
        key: 'accountId',
        label: 'Account ID',
        type: 'text',
        placeholder: '1234567',
        required: true,
        help: 'Your NetSuite account id (also the subdomain of your account URL).',
      },
      {
        key: 'clientId',
        label: 'Client ID (Consumer Key)',
        type: 'text',
        required: true,
        help: 'From the NetSuite integration record set up for OAuth 2.0 client credentials.',
      },
      {
        key: 'certId',
        label: 'Certificate ID',
        type: 'text',
        required: true,
        help: 'The certificate id (kid) of the mapped OAuth 2.0 client-credentials certificate.',
      },
      {
        key: 'privateKey',
        label: 'Private Key (PEM)',
        type: 'secret',
        required: true,
        help: 'The RSA private key (PS256) whose certificate is registered in NetSuite. Paste the full PEM, including the BEGIN/END lines.',
      },
    ],
    validateSettings: (settings) => {
      try {
        normalizeNetSuiteAccountId(settings.accountId ?? '');
        return null;
      } catch (err) {
        return (err as Error).message;
      }
    },
    buildMcp: (s) => {
      if (!s.accountId || !s.clientId || !s.certId || !s.privateKey) return null;
      return {
        transport: 'stdio',
        command: process.execPath,
        args: [NETSUITE_MCP_SERVER],
        env: {
          NS_ACCOUNT_ID: s.accountId,
          NS_CLIENT_ID: s.clientId,
          NS_CERT_ID: s.certId,
          NS_PRIVATE_KEY_PEM: s.privateKey,
        },
      };
    },
  },
  {
    slug: 'ringcentral',
    name: 'RingCentral',
    description: 'Read account identity, extensions, company phone numbers, call logs, call details, and recording metadata through a fixed read-only tool set.',
    kind: 'custom',
    fields: [
      {
        key: 'serverUrl',
        label: 'Server URL',
        type: 'text',
        placeholder: 'https://platform.ringcentral.com',
        required: false,
        help: 'Leave blank for production. RingCentral sandbox is also supported.',
      },
      {
        key: 'clientId',
        label: 'Client ID',
        type: 'text',
        required: true,
        help: 'From a RingCentral server-to-server OAuth application.',
      },
      {
        key: 'clientSecret',
        label: 'Client Secret',
        type: 'secret',
        required: true,
        help: 'Stored write-only and used only by the server to mint short-lived access tokens.',
      },
      {
        key: 'jwt',
        label: 'JWT',
        type: 'secret',
        required: true,
        help: 'The long-lived server-to-server JWT. The connector never returns it to users or agents.',
      },
    ],
    validateSettings: validateRingCentralSettings,
    buildMcp: (settings) => {
      if (!settings.clientId || !settings.clientSecret || !settings.jwt) return null;
      if (validateRingCentralSettings(settings)) return null;
      return {
        transport: 'stdio',
        command: process.execPath,
        args: [RINGCENTRAL_MCP_SERVER],
        env: {
          RC_SERVER_URL: settings.serverUrl?.trim() || 'https://platform.ringcentral.com',
          RC_CLIENT_ID: settings.clientId.trim(),
          RC_CLIENT_SECRET: settings.clientSecret,
          RC_JWT: settings.jwt.trim(),
        },
      };
    },
  },
  {
    slug: 'paper',
    name: 'Paper',
    description:
      'Read and edit a Paper (paper.design) design file: inspect artboards, write HTML, update styles, and pull screenshots back into the chat. Needs Paper Desktop running with a file open.',
    kind: 'custom',
    fields: [
      {
        key: 'url',
        label: 'Paper MCP URL',
        type: 'text',
        placeholder: PAPER_DEFAULT_MCP_URL,
        required: false,
        help: `Leave blank when Paper runs on this machine. Point it at http://<host>:29979/mcp when Paper runs on a different desktop reachable over a private network. Paper's MCP endpoint has no authentication, so anyone who can reach a non-loopback address can read and change the design file — restrict it to this Veneer host.`,
      },
    ],
    validateSettings: validatePaperSettings,
    buildMcp: (settings) => {
      if (validatePaperSettings(settings)) return null;
      return { transport: 'http', url: resolvePaperMcpUrl(settings), headers: {} };
    },
  },
  {
    slug: 'gmail',
    name: 'Gmail',
    description: 'Read, search, draft, and send email from your Gmail account.',
    kind: 'composio',
    composio: { toolkit: 'gmail' },
    accessModes: GMAIL_ACCESS_MODES,
  },
  {
    slug: 'googledrive',
    name: 'Google Drive',
    description: 'Find, read, upload, organize, and share files in Google Drive.',
    kind: 'composio',
    composio: { toolkit: 'googledrive' },
    accessModes: GOOGLE_DRIVE_ACCESS_MODES,
  },
  {
    slug: 'googledocs',
    name: 'Google Docs',
    description: 'Find, read, create, and edit documents in Google Docs.',
    kind: 'composio',
    composio: { toolkit: 'googledocs' },
    accessModes: GOOGLE_DOCS_ACCESS_MODES,
  },
  {
    slug: 'googlesheets',
    name: 'Google Sheets',
    description: 'Find, read, analyze, create, and edit spreadsheets in Google Sheets.',
    kind: 'composio',
    composio: { toolkit: 'googlesheets' },
    accessModes: GOOGLE_SHEETS_ACCESS_MODES,
  },
  {
    slug: 'googleads',
    name: 'Google Ads',
    description: 'Inspect campaign performance and manage ads, audiences, bidding, budgets, assets, conversions, and targeting.',
    kind: 'composio',
    composio: { toolkit: 'googleads' },
    accessModes: GOOGLE_ADS_ACCESS_MODES,
  },
  {
    slug: 'google_analytics',
    name: 'Google Analytics',
    description: 'Analyze accounts, properties, audiences, traffic, user behavior, conversions, and realtime reporting in Google Analytics.',
    kind: 'composio',
    composio: { toolkit: 'google_analytics' },
    accessModes: GOOGLE_ANALYTICS_ACCESS_MODES,
  },
  {
    slug: 'outlook',
    name: 'Outlook',
    description: 'Read, search, draft, and send email, and manage calendars and contacts in Outlook.',
    kind: 'composio',
    composio: { toolkit: 'outlook' },
  },
  {
    slug: 'hubspot',
    name: 'HubSpot',
    description: 'Read and manage contacts, companies, deals, tickets, activities, products, quotes, and CRM settings in HubSpot.',
    kind: 'composio',
    composio: { toolkit: 'hubspot' },
    accessModes: HUBSPOT_ACCESS_MODES,
  },
  {
    slug: 'shopify',
    name: 'Shopify',
    description: 'Manage products, orders, customers, inventory, and store operations in Shopify.',
    kind: 'composio',
    composio: { toolkit: 'shopify' },
  },
  {
    slug: 'omnisend',
    name: 'Omnisend',
    description: 'Manage contacts, lists and segments, campaigns, automations, events, orders, and products in Omnisend.',
    kind: 'composio',
    composio: { toolkit: 'omnisend' },
  },
  {
    slug: 'quickbooks',
    name: 'QuickBooks',
    description: 'Read financial data and manage customers, vendors, invoices, bills, payments, purchases, reports, and company accounting in QuickBooks Online.',
    kind: 'composio',
    composio: { toolkit: 'quickbooks' },
    accessModes: QUICKBOOKS_ACCESS_MODES,
  },
];

export function connectorDef(slug: string): ConnectorDef | undefined {
  return CONNECTOR_DEFS.find((d) => d.slug === slug);
}

/** A label → its slug form: lowercase, non-alphanumeric runs → single '-',
 * trimmed, capped at 24 chars; empty result falls back to 'account'. */
export function slugifyLabel(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
    .replace(/-+$/g, '');
  return slug || 'account';
}

/** THE naming rule for a per-install MCP server and its "@" mention token:
 * unlabeled installs use the bare slug; labeled ones append the label slug. */
export function connectorMcpName(slug: string, label: string | null): string {
  return label ? `${slug}-${slugifyLabel(label)}` : slug;
}

/** Shared installs can coexist with a user's personal install (and with other
 * shared installs), so their runtime names include the durable row id. */
export function connectorInstallMcpName(
  slug: string,
  label: string | null,
  sharing: 'personal' | 'shared',
  id: number,
): string {
  const base = connectorMcpName(slug, label);
  return sharing === 'shared' ? `${base}-everyone-${id}` : base;
}

/** Stored per-install config (user_connectors.config_json — may contain secrets). */
export interface ComposioInstallConfig {
  sessionId: string;
  connectedAccountId: string;
  /** Identity used at Composio for this install (user.email, or `email#<labelslug>`
   * for a labeled install so Composio binds a distinct account per install). */
  composioUserId?: string;
  mcp: { type: 'http' | 'sse'; url: string; headers?: Record<string, string> };
}
export interface CustomInstallConfig {
  settings: Record<string, string>;
}

/**
 * The MCP server entry for one connected install, in toolbox McpConfig shape
 * so the materializer emits it exactly like a toolbox connection. Null when
 * the stored config can't produce one (malformed, or a custom def without
 * buildMcp) — callers skip those.
 */
export function connectorMcpConfig(
  def: ConnectorDef,
  configJson: string,
): McpConfig | null {
  const parsed = JSON.parse(configJson) as ComposioInstallConfig | CustomInstallConfig;
  if (def.kind === 'composio') {
    const mcp = (parsed as ComposioInstallConfig).mcp;
    if (!mcp?.url) return null;
    return { transport: mcp.type === 'sse' ? 'sse' : 'http', url: mcp.url, headers: mcp.headers ?? {} };
  }
  const settings = (parsed as CustomInstallConfig).settings ?? {};
  return def.buildMcp?.(settings) ?? null;
}
