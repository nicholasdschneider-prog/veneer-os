import { Composio } from '@composio/core';
import path from 'node:path';
import type { ComposioOAuthScopeStrategy } from './accessModes.js';

/**
 * Thin wrapper over the Composio SDK (@composio/core) for connector installs.
 * One session per install, created with { mcp: true } so it exposes a hosted
 * MCP endpoint; sessions persist, so the URL/headers minted here are stored on
 * the install row and reused every turn (the materializer stays synchronous).
 * The user's identity at Composio is their Veneer email.
 *
 * All calls need the account-level API key (Settings → API Keys → Composio,
 * or COMPOSIO_API_KEY from the Doppler-backed service env). Never log it.
 */

export interface ComposioMcpEndpoint {
  type: 'http' | 'sse';
  url: string;
  headers?: Record<string, string>;
}

export interface ComposioInstallStart {
  sessionId: string;
  connectedAccountId: string;
  /** Where the user finishes OAuth (Composio's hosted Connect flow). Null when already connected. */
  redirectUrl: string | null;
  /** ACTIVE right away when the user had already authorized this toolkit. */
  alreadyActive: boolean;
  mcp: ComposioMcpEndpoint;
}

export interface ComposioAccessPolicy {
  authConfigId: string;
  toolSlugs: readonly string[];
}

export interface ComposioManagedAuthConfigPolicy {
  oauthScopeStrategy: ComposioOAuthScopeStrategy;
  expectedScopes: readonly string[];
  toolSlugs: readonly string[];
}

export interface ComposioTriggerStart {
  triggerId: string;
}

export interface ComposioGmailDraftInput {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  isHtml?: boolean;
  attachmentPaths: string[];
}

export interface ComposioGmailDraftResult {
  gmailUrl: string | null;
}

export interface SlackDirectMessageOption {
  id: string;
  label: string;
}

export type ComposioConnectionStatus =
  | 'INITIALIZING'
  | 'INITIATED'
  | 'ACTIVE'
  | 'FAILED'
  | 'EXPIRED'
  | 'INACTIVE'
  | 'REVOKED'
  | 'UNKNOWN';

export interface ComposioAccountIdentity {
  displayName: string | null;
  email: string | null;
}

export interface GoogleAnalyticsPropertyDetails {
  id: string;
  name: string;
  canEdit: boolean | null;
}

export interface GoogleAnalyticsAccountDetails {
  id: string;
  name: string;
  properties: GoogleAnalyticsPropertyDetails[];
}

export interface GoogleAnalyticsResourceDetails {
  kind: 'googleAnalytics';
  status: 'ready' | 'unavailable';
  accounts: GoogleAnalyticsAccountDetails[];
  truncated: boolean;
}

export type ComposioResourceDetails = GoogleAnalyticsResourceDetails;

/**
 * Public, deliberately allowlisted metadata for one installed connector.
 * Never add raw Composio account/session responses here: they may carry
 * credentials. Provider-specific resources are a union so other toolkits can
 * add safe summaries without changing the common identity contract.
 */
export interface ComposioConnectorDetails {
  provider: 'composio';
  toolkit: string;
  connectionStatus: ComposioConnectionStatus;
  identity: ComposioAccountIdentity | null;
  resources: ComposioResourceDetails[];
  issues: string[];
  fetchedAt: string;
}

function client(apiKey: string): Composio {
  return new Composio({ apiKey, allowTracking: false });
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function shortString(value: unknown, max = 320): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

function gmailDisplayUrl(value: unknown, depth = 0): string | null {
  if (depth > 6 || value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = gmailDisplayUrl(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  const item = record(value);
  if (!item) return null;
  for (const key of ['display_url', 'displayUrl', 'url']) {
    const candidate = shortString(item[key], 2_048);
    if (!candidate) continue;
    try {
      const url = new URL(candidate);
      if (url.protocol === 'https:' && url.hostname === 'mail.google.com') return url.toString();
    } catch {
      /* malformed/non-Gmail link */
    }
  }
  for (const key of ['data', 'result', 'response']) {
    const found = gmailDisplayUrl(item[key], depth + 1);
    if (found) return found;
  }
  return null;
}

const ATTACHMENT_MIME_TYPES: Record<string, string> = {
  '.csv': 'text/csv',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.gif': 'image/gif',
  '.html': 'text/html',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.svg': 'image/svg+xml',
  '.tsv': 'text/tab-separated-values',
  '.txt': 'text/plain',
  '.webp': 'image/webp',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xml': 'application/xml',
  '.zip': 'application/zip',
};

/**
 * Stage local files through Composio, then create an unsent Gmail draft using
 * the connector's raw {name,mimetype,s3key} attachment contract. The hosted
 * MCP cannot turn an agent-local path into an s3key by itself.
 */
export async function createComposioGmailDraft(
  apiKey: string,
  sessionId: string,
  input: ComposioGmailDraftInput,
): Promise<ComposioGmailDraftResult> {
  const composio = client(apiKey);
  const attachments = await Promise.all(input.attachmentPaths.map(async (file) => {
    const uploaded = await composio.files.upload({
      file,
      toolSlug: 'GMAIL_CREATE_EMAIL_DRAFT',
      toolkitSlug: 'gmail',
    });
    return {
      ...uploaded,
      // Composio's staging response uses a generated object name and may use
      // octet-stream for CSV/text. Gmail should show the deliverable's name.
      name: path.basename(file),
      mimetype: ATTACHMENT_MIME_TYPES[path.extname(file).toLowerCase()] ?? uploaded.mimetype,
    };
  }));
  const session = await composio.sessions.use(sessionId);
  const result = await session.execute('GMAIL_CREATE_EMAIL_DRAFT', {
    recipient_email: input.to.join(', '),
    ...(input.cc?.length ? { cc: input.cc } : {}),
    ...(input.bcc?.length ? { bcc: input.bcc } : {}),
    subject: input.subject,
    body: input.body,
    is_html: input.isHtml ?? false,
    attachment: attachments,
  });
  if (result.error) {
    const detail = typeof result.error === 'string' ? result.error : 'Gmail draft creation failed';
    throw new Error(detail);
  }
  return { gmailUrl: gmailDisplayUrl(result.data) };
}

function firstString(source: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const found = shortString(source[key]);
    if (found) return found;
  }
  return null;
}

/** Keep only non-sensitive identity fields explicitly approved for the UI. */
export function sanitizeComposioIdentity(value: unknown): ComposioAccountIdentity | null {
  const info = record(value);
  if (!info) return null;
  const givenName = firstString(info, ['givenName', 'given_name', 'firstName', 'first_name']);
  const familyName = firstString(info, ['familyName', 'family_name', 'lastName', 'last_name']);
  const combinedName = [givenName, familyName].filter(Boolean).join(' ') || null;
  const displayName =
    firstString(info, ['name', 'displayName', 'display_name', 'fullName', 'full_name']) ?? combinedName;
  const candidateEmail = firstString(info, ['email', 'emailAddress', 'email_address', 'mail']);
  const email = candidateEmail && candidateEmail.includes('@') ? candidateEmail : null;
  return displayName || email ? { displayName, email } : null;
}

/** Parse one Google response page without allowing arbitrary provider fields through. */
export function parseGoogleAnalyticsAccounts(value: unknown): {
  accounts: GoogleAnalyticsAccountDetails[];
  nextPageToken: string | null;
} {
  const outer = record(value) ?? {};
  const data = record(outer.data) ?? outer;
  const summaries = Array.isArray(data.accountSummaries) ? data.accountSummaries : [];
  const accounts: GoogleAnalyticsAccountDetails[] = [];
  for (const item of summaries) {
    const summary = record(item);
    if (!summary) continue;
    const id = shortString(summary.account);
    if (!id) continue;
    const properties: GoogleAnalyticsPropertyDetails[] = [];
    const propertySummaries = Array.isArray(summary.propertySummaries) ? summary.propertySummaries : [];
    for (const rawProperty of propertySummaries) {
      const property = record(rawProperty);
      if (!property) continue;
      const propertyId = shortString(property.property);
      if (!propertyId) continue;
      properties.push({
        id: propertyId,
        name: shortString(property.displayName, 240) ?? propertyId,
        canEdit: typeof property.canEdit === 'boolean' ? property.canEdit : null,
      });
    }
    accounts.push({
      id,
      name: shortString(summary.displayName, 240) ?? id,
      properties,
    });
  }
  return { accounts, nextPageToken: shortString(data.nextPageToken, 2000) };
}

function mergeGoogleAnalyticsAccounts(
  target: GoogleAnalyticsAccountDetails[],
  incoming: GoogleAnalyticsAccountDetails[],
): void {
  for (const account of incoming) {
    const existing = target.find((candidate) => candidate.id === account.id);
    if (!existing) {
      target.push(account);
      continue;
    }
    for (const property of account.properties) {
      if (!existing.properties.some((candidate) => candidate.id === property.id)) existing.properties.push(property);
    }
  }
}

function normalizedStatus(value: unknown): ComposioConnectionStatus {
  const status = shortString(value);
  return status && ['INITIALIZING', 'INITIATED', 'ACTIVE', 'FAILED', 'EXPIRED', 'INACTIVE', 'REVOKED'].includes(status)
    ? (status as ComposioConnectionStatus)
    : 'UNKNOWN';
}

async function googleAnalyticsResources(
  session: Awaited<ReturnType<Composio['sessions']['use']>>,
): Promise<{ resource: GoogleAnalyticsResourceDetails; issue: string | null }> {
  const accounts: GoogleAnalyticsAccountDetails[] = [];
  let pageToken: string | null = null;
  let truncated = false;
  try {
    for (let page = 0; page < 10; page += 1) {
      const result = await session.execute('GOOGLE_ANALYTICS_LIST_ACCOUNT_SUMMARIES', {
        pageSize: 200,
        ...(pageToken ? { pageToken } : {}),
      });
      if (result.error) throw new Error('Google Analytics account listing failed');
      const parsed = parseGoogleAnalyticsAccounts(result.data);
      mergeGoogleAnalyticsAccounts(accounts, parsed.accounts);
      pageToken = parsed.nextPageToken;
      if (!pageToken) break;
      if (page === 9) truncated = true;
    }
    return {
      resource: { kind: 'googleAnalytics', status: 'ready', accounts, truncated },
      issue: truncated ? 'Only the first 2,000 Analytics accounts are shown.' : null,
    };
  } catch {
    return {
      resource: { kind: 'googleAnalytics', status: accounts.length ? 'ready' : 'unavailable', accounts, truncated: true },
      issue: accounts.length
        ? 'Some Google Analytics accounts could not be loaded.'
        : 'Google Analytics accounts are temporarily unavailable.',
    };
  }
}

/** Fetch safe, display-only account metadata for an installed Composio toolkit. */
export async function getComposioConnectorDetails(
  apiKey: string,
  config: Pick<ComposioInstallStart, 'sessionId' | 'connectedAccountId'>,
  toolkit: string,
): Promise<ComposioConnectorDetails> {
  const composio = client(apiKey);
  const account = await composio.connectedAccounts.get(config.connectedAccountId);
  const connectionStatus = normalizedStatus((account as { status?: unknown }).status);
  const details: ComposioConnectorDetails = {
    provider: 'composio',
    toolkit,
    connectionStatus,
    identity: null,
    resources: [],
    issues: [],
    fetchedAt: new Date().toISOString(),
  };
  if (connectionStatus !== 'ACTIVE') {
    details.issues.push(`This connection is ${connectionStatus.toLowerCase()}. Reconnect it to refresh account details.`);
    return details;
  }

  const session = await composio.sessions.use(config.sessionId);
  const identityRequest = session
    .search({ query: 'Identify the currently authenticated account for this connected toolkit.', toolkits: [toolkit] })
    .then((result) => {
      const status = result.toolkitConnectionStatuses.find(
        (item) => item.toolkit.toLowerCase() === toolkit.toLowerCase(),
      );
      return sanitizeComposioIdentity(status?.currentUserInfo);
    });

  if (toolkit === 'google_analytics') {
    const [identityResult, resourceResult] = await Promise.allSettled([
      identityRequest,
      googleAnalyticsResources(session),
    ]);
    if (identityResult.status === 'fulfilled') details.identity = identityResult.value;
    else details.issues.push('The connected Google identity could not be loaded.');
    if (resourceResult.status === 'fulfilled') {
      details.resources.push(resourceResult.value.resource);
      if (resourceResult.value.issue) details.issues.push(resourceResult.value.issue);
    } else {
      details.resources.push({
        kind: 'googleAnalytics',
        status: 'unavailable',
        accounts: [],
        truncated: true,
      });
      details.issues.push('Google Analytics accounts are temporarily unavailable.');
    }
  } else {
    try {
      details.identity = await identityRequest;
    } catch {
      details.issues.push('The connected account identity could not be loaded.');
    }
  }
  return details;
}

/**
 * Composio SDK errors often carry the raw HTTP body ('401 {"error":{...}}') —
 * unreadable in a mobile toast. Pull out their message when present.
 */
export function composioErrorMessage(err: unknown): string {
  const raw = (err as Error).message ?? String(err);
  const jsonStart = raw.indexOf('{');
  if (jsonStart !== -1) {
    try {
      const body = JSON.parse(raw.slice(jsonStart)) as { error?: { message?: string; suggested_fix?: string } };
      if (body.error?.message) {
        return [body.error.message, body.error.suggested_fix].filter(Boolean).join(' — ');
      }
    } catch {
      /* not a JSON body — fall through to the raw message */
    }
  }
  return raw;
}

function scopeList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((scope): scope is string => typeof scope === 'string');
  return typeof value === 'string'
    ? value.split(/[\s,]+/).map((scope) => scope.trim()).filter(Boolean)
    : [];
}

function sameScopes(actual: string[], expected: readonly string[]): boolean {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  return actualSet.size === expectedSet.size && [...expectedSet].every((scope) => actualSet.has(scope));
}

/** Fail closed when a stored Composio managed-auth config no longer has the
 * exact scopes in Veneer's immutable access snapshot. */
export function managedAuthConfigHasExactScopes(
  value: unknown,
  toolkit: string,
  scopes: readonly string[],
): boolean {
  const config = record(value);
  const configToolkit = record(config?.toolkit);
  const credentials = record(config?.credentials);
  return Boolean(
    config &&
    config.isComposioManaged === true &&
    config.status === 'ENABLED' &&
    configToolkit?.slug === toolkit &&
    credentials &&
    sameScopes([
      ...scopeList(credentials.scopes),
      ...scopeList(credentials.optional_scopes ?? credentials.optionalScopes),
    ], scopes) &&
    sameScopes(scopeList(credentials.user_scopes ?? credentials.userScopes), []),
  );
}

function managedAuthConfigTools(value: unknown): string[] {
  const config = record(value);
  const toolAccess = record(config?.toolAccessConfig ?? config?.tool_access_config);
  return scopeList(toolAccess?.toolsAvailableForExecution ?? toolAccess?.tools_available_for_execution);
}

/** Match both the immutable OAuth snapshot and the auth-config execution
 * allowlist. The session repeats the same tool limit as a second boundary. */
export function managedAuthConfigMatchesPolicy(
  value: unknown,
  toolkit: string,
  policy: ComposioManagedAuthConfigPolicy,
): boolean {
  return managedAuthConfigHasExactScopes(value, toolkit, policy.expectedScopes) &&
    sameScopes(managedAuthConfigTools(value), policy.toolSlugs);
}

export async function validateComposioManagedAuthConfig(
  apiKey: string,
  authConfigId: string,
  toolkit: string,
  policy: ComposioManagedAuthConfigPolicy,
): Promise<boolean> {
  const snapshot = await client(apiKey).authConfigs.get(authConfigId);
  return managedAuthConfigMatchesPolicy(snapshot, toolkit, policy);
}

export function composioManagedAuthCreateOptions(
  name: string,
  policy: ComposioManagedAuthConfigPolicy,
) {
  return {
    type: 'use_composio_managed_auth' as const,
    name,
    ...(policy.oauthScopeStrategy === 'explicit'
      ? { credentials: { scopes: policy.expectedScopes.join(',') } }
      : {}),
  };
}

export function composioManagedAuthToolUpdateOptions(policy: ComposioManagedAuthConfigPolicy) {
  return {
    type: 'default' as const,
    toolAccessConfig: { toolsAvailableForExecution: [...policy.toolSlugs] },
  };
}

/** Create and verify one managed-auth config for a versioned access profile. */
export async function createComposioManagedAuthConfig(
  apiKey: string,
  toolkit: string,
  name: string,
  policy: ComposioManagedAuthConfigPolicy,
): Promise<string> {
  const composio = client(apiKey);
  const created = await composio.authConfigs.create(toolkit, composioManagedAuthCreateOptions(name, policy));
  try {
    // toolsAvailableForExecution does not derive OAuth scopes. In particular,
    // never use toolsForConnectedAccountCreation here: it can make Composio
    // request Google scopes that its managed app does not support.
    await composio.authConfigs.update(created.id, composioManagedAuthToolUpdateOptions(policy));
    const snapshot = await composio.authConfigs.get(created.id);
    if (managedAuthConfigMatchesPolicy(snapshot, toolkit, policy)) return created.id;
  } catch (err) {
    await composio.authConfigs.delete(created.id).catch(() => undefined);
    throw err;
  }
  await composio.authConfigs.delete(created.id).catch(() => undefined);
  throw new Error('Composio managed permissions or tools changed. Veneer stopped the connection for review.');
}

export function composioSessionOptions(toolkit: string, accessPolicy?: ComposioAccessPolicy) {
  return {
    toolkits: [toolkit],
    ...(accessPolicy
      ? {
          // Direct-tools mode removes search and execution meta-tools. The
          // fixed allowlist is the only connector tool surface exposed to agents.
          sessionPreset: 'direct_tools' as const,
          authConfigs: { [toolkit]: accessPolicy.authConfigId },
          tools: { [toolkit]: { enable: [...accessPolicy.toolSlugs] } },
          manageConnections: false as const,
          sandbox: { enable: false as const, enableProxyExecution: false as const },
        }
      : {}),
    mcp: true as const,
  };
}

export async function startComposioInstall(
  apiKey: string,
  userId: string,
  toolkit: string,
  callbackUrl: string,
  accessPolicy?: ComposioAccessPolicy,
): Promise<ComposioInstallStart> {
  const composio = client(apiKey);
  const session = await composio.sessions.create(userId, composioSessionOptions(toolkit, accessPolicy));
  const request = await session.authorize(toolkit, { callbackUrl });
  return {
    sessionId: session.sessionId,
    connectedAccountId: request.id,
    redirectUrl: request.redirectUrl ?? null,
    alreadyActive: request.status === 'ACTIVE',
    mcp: {
      type: session.mcp.type === 'sse' ? 'sse' : 'http',
      url: session.mcp.url,
      headers: session.mcp.headers,
    },
  };
}

/** Raw Composio status: INITIALIZING | INITIATED | ACTIVE | FAILED | EXPIRED | INACTIVE | REVOKED. */
export async function composioAccountStatus(apiKey: string, connectedAccountId: string): Promise<string> {
  const account = await client(apiKey).connectedAccounts.get(connectedAccountId);
  return (account as { status?: string }).status ?? 'INITIATED';
}

/** Best-effort revoke + delete at Composio on uninstall; the local row is removed regardless. */
export async function deleteComposioAccount(apiKey: string, connectedAccountId: string): Promise<void> {
  try {
    await client(apiKey).connectedAccounts.delete(connectedAccountId);
  } catch {
    /* already gone, or Composio unreachable — uninstall proceeds locally */
  }
}

export async function createComposioTrigger(
  apiKey: string,
  userId: string,
  connectedAccountId: string,
  triggerSlug: string,
  triggerConfig: Record<string, unknown>,
): Promise<ComposioTriggerStart> {
  const created = await client(apiKey).triggers.create(userId, triggerSlug, {
    connectedAccountId,
    triggerConfig,
  });
  return { triggerId: created.triggerId };
}

export async function setComposioTriggerEnabled(
  apiKey: string,
  triggerId: string,
  enabled: boolean,
): Promise<void> {
  const triggers = client(apiKey).triggers;
  if (enabled) await triggers.enable(triggerId);
  else await triggers.disable(triggerId);
}

export async function deleteComposioTrigger(apiKey: string, triggerId: string): Promise<void> {
  await client(apiKey).triggers.delete(triggerId);
}

function collectSlackConversations(value: unknown, output: SlackDirectMessageOption[], depth = 0): void {
  if (depth > 5 || value === null || value === undefined) return;
  if (Array.isArray(value)) {
    for (const item of value) collectSlackConversations(item, output, depth + 1);
    return;
  }
  const item = record(value);
  if (!item) return;
  const id = shortString(item.id, 100);
  if (id?.startsWith('D') && !output.some((candidate) => candidate.id === id)) {
    const user = record(item.user);
    const label =
      firstString(item, ['name', 'display_name', 'displayName', 'user']) ??
      (user ? firstString(user, ['real_name', 'realName', 'display_name', 'displayName', 'name']) : null) ??
      id;
    output.push({ id, label });
  }
  for (const key of ['channels', 'conversations', 'ims', 'items', 'data', 'response']) {
    if (key in item) collectSlackConversations(item[key], output, depth + 1);
  }
}

/** Bounded, read-only picker data for the event-automation editor. */
export async function listSlackDirectMessages(
  apiKey: string,
  sessionId: string,
): Promise<SlackDirectMessageOption[]> {
  const session = await client(apiKey).sessions.use(sessionId);
  const result = await session.execute('SLACK_LIST_CONVERSATIONS', {
    types: 'im',
    limit: 200,
    exclude_archived: true,
  });
  if (result.error) throw new Error('Slack DM listing failed');
  const options: SlackDirectMessageOption[] = [];
  collectSlackConversations(result.data, options);
  return options.slice(0, 200);
}

export async function parseComposioWebhook(
  apiKey: string,
  body: Buffer,
  headers: Record<string, unknown>,
  verifySecret: string,
) {
  return client(apiKey).triggers.parse(
    { body, headers },
    { verifySecret },
  );
}
