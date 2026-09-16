import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Local secret store: `DATA_DIR/secrets.json`, mode 0600, atomic writes.
 * Holds the Claude subscription OAuth tokens connected in-app (the same
 * `sk-ant-oat01-…` a manual `claude setup-token` produces). Kept OUT of the
 * SQLite DB (which syncs/backs-up differently) and out of the env file.
 *
 * Several accounts can be connected at once and one is active: hitting a
 * 5-hour limit on one subscription is a click, not a logout/login cycle. The
 * active account's token is what every consumer gets from `getClaudeToken()`,
 * and the claude adapter reads it per turn, so a switch lands on the next
 * message without a restart.
 *
 * Only ever persist tokens here — never log them, never return them over the API.
 */

/** Id given to a token migrated from the pre-multi-account single-token shape. */
export const LEGACY_CLAUDE_ACCOUNT_ID = 'primary';
/** Pseudo-account id for the CLAUDE_CODE_OAUTH_TOKEN env fallback. */
export const ENV_CLAUDE_ACCOUNT_ID = 'env';

export interface StoredClaudeAccount {
  id: string;
  /** User-facing name. Defaults to the account email, then a generic label. */
  label: string;
  /** Account email from the OAuth profile, when the scope allowed reading it. */
  email: string | null;
  /** Plan label from the OAuth profile ("max" etc.), or null. */
  planType: string | null;
  token: string;
  connectedAt: string;
}

/** Everything about an account EXCEPT its token — safe to return over the API. */
export type ClaudeAccountSummary = Omit<StoredClaudeAccount, 'token'> & { active: boolean };

export interface SecretsFile {
  /** Pre-multi-account shape; migrated to `claudeAccounts` on read. */
  claudeOauthToken?: string;
  connectedAt?: string;
  claudeAccounts?: StoredClaudeAccount[];
  activeClaudeAccountId?: string;
  /**
   * User-set API-key overrides, keyed by a stable id ('openrouter', 'soniox').
   * When present these win over the env/Doppler default; absent = use the default.
   * Kept here (not the DB) so they share the Claude token's 0600 hygiene and
   * survive a code reinstall along with the rest of DATA_DIR.
   */
  apiKeys?: Record<string, string>;
}

export interface ClaudeConnectionStatus {
  connected: boolean;
  connectedAt: string | null;
  /** Where the effective token comes from: the in-app store, the legacy env, or nowhere. */
  source: 'app' | 'env' | null;
}

export interface AddClaudeAccountInput {
  token: string;
  email?: string | null;
  planType?: string | null;
  label?: string | null;
  connectedAt?: string;
  /** Make the new account active (default true — you just signed into it). */
  activate?: boolean;
}

export interface SecretStore {
  /** The ACTIVE in-app Claude token, or null if no account is connected. */
  getClaudeToken(): string | null;
  /** A specific account's token, or null. Never expose the result over the API. */
  getClaudeTokenFor(accountId: string): string | null;
  /**
   * Connect an account. An account with the same email is treated as a
   * re-login: its token is refreshed in place rather than added twice.
   */
  addClaudeAccount(input: AddClaudeAccountInput): ClaudeAccountSummary;
  /** All connected accounts, tokens stripped. Empty when only the env fallback exists. */
  listClaudeAccounts(): ClaudeAccountSummary[];
  /** Id of the active account, 'env' when only the env fallback is present, else null. */
  activeClaudeAccountId(): string | null;
  /**
   * Every credential the usage prober should meter: the connected accounts, or
   * the env fallback as a single pseudo-account. Carries tokens — runner-only.
   */
  claudeAccountCredentials(): { id: string; token: string }[];
  /** Switch the active account. False when the id is unknown. */
  setActiveClaudeAccount(accountId: string): boolean;
  /** Rename an account. False when the id is unknown. */
  renameClaudeAccount(accountId: string, label: string): boolean;
  /** Disconnect one account; the next remaining one becomes active. */
  removeClaudeAccount(accountId: string): boolean;
  /** Refresh an account's identity after a profile probe (best effort). */
  updateClaudeAccountProfile(accountId: string, profile: { email?: string | null; planType?: string | null }): void;
  /** Remove ALL in-app accounts (leaves any env fallback untouched). */
  clearClaudeToken(): void;
  /** Effective status of the active account, factoring in the env fallback. */
  status(): ClaudeConnectionStatus;
  /** The user-set override for an API key id, or null if none is stored. */
  getApiKeyOverride(id: string): string | null;
  /** Store (trimmed) an override for an API key id. */
  setApiKeyOverride(id: string, value: string): void;
  /** Drop the override for an API key id (reverts to the env/Doppler default). */
  clearApiKeyOverride(id: string): void;
}

function readFileSafe(file: string): SecretsFile {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object') return parsed as SecretsFile;
  } catch {
    /* missing or corrupt → treat as empty */
  }
  return {};
}

function writeAtomic(file: string, data: SecretsFile): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  // Ensure mode even if the file pre-existed with a looser umask.
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* best effort */
  }
}

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * The account list as the rest of the code should see it, whatever shape is on
 * disk. A pre-multi-account `claudeOauthToken` becomes account `primary` —
 * matching the id the usage store migrates its legacy snapshots to, so an
 * existing login keeps both its token AND its meters.
 */
function normalizeAccounts(file: SecretsFile): StoredClaudeAccount[] {
  const accounts: StoredClaudeAccount[] = [];
  const seen = new Set<string>();
  for (const raw of Array.isArray(file.claudeAccounts) ? file.claudeAccounts : []) {
    const token = nonEmpty(raw?.token);
    const id = nonEmpty(raw?.id);
    if (!token || !id || seen.has(id)) continue;
    seen.add(id);
    accounts.push({
      id,
      label: nonEmpty(raw.label) ?? nonEmpty(raw.email) ?? 'Claude account',
      email: nonEmpty(raw.email),
      planType: nonEmpty(raw.planType),
      token,
      connectedAt: nonEmpty(raw.connectedAt) ?? new Date(0).toISOString(),
    });
  }
  const legacy = nonEmpty(file.claudeOauthToken);
  if (legacy && !seen.has(LEGACY_CLAUDE_ACCOUNT_ID) && !accounts.some((a) => a.token === legacy)) {
    accounts.unshift({
      id: LEGACY_CLAUDE_ACCOUNT_ID,
      label: 'Claude account',
      email: null,
      planType: null,
      token: legacy,
      connectedAt: nonEmpty(file.connectedAt) ?? new Date(0).toISOString(),
    });
  }
  return accounts;
}

/** The active account, defaulting to the first when the stored id is stale. */
function resolveActive(file: SecretsFile, accounts: StoredClaudeAccount[]): StoredClaudeAccount | null {
  if (accounts.length === 0) return null;
  const wanted = nonEmpty(file.activeClaudeAccountId);
  return accounts.find((a) => a.id === wanted) ?? accounts[0]!;
}

function summarize(account: StoredClaudeAccount, activeId: string | null): ClaudeAccountSummary {
  const { token: _token, ...rest } = account;
  return { ...rest, active: account.id === activeId };
}

export function createSecretStore(
  dataDir: string,
  env: NodeJS.ProcessEnv = process.env,
): SecretStore {
  const file = path.join(dataDir, 'secrets.json');

  /** Read, normalize, and drop the legacy single-token fields from what we write back. */
  function load(): { file: SecretsFile; accounts: StoredClaudeAccount[]; active: StoredClaudeAccount | null } {
    const current = readFileSafe(file);
    const accounts = normalizeAccounts(current);
    return { file: current, accounts, active: resolveActive(current, accounts) };
  }

  /**
   * Persist an account list + active id, retiring the legacy single-token
   * fields. `keepActiveFromDisk` re-reads which account is active at write
   * time: the web process switches accounts while the runner writes profile
   * updates from its usage probe, and a background write must never silently
   * undo a switch the user just made.
   */
  function save(
    current: SecretsFile,
    accounts: StoredClaudeAccount[],
    activeId: string | null,
    keepActiveFromDisk = false,
  ): void {
    const next: SecretsFile = { ...current };
    const wanted = keepActiveFromDisk ? nonEmpty(readFileSafe(file).activeClaudeAccountId) ?? activeId : activeId;
    delete next.claudeOauthToken;
    delete next.connectedAt;
    if (accounts.length === 0) {
      delete next.claudeAccounts;
      delete next.activeClaudeAccountId;
    } else {
      next.claudeAccounts = accounts;
      next.activeClaudeAccountId = wanted && accounts.some((a) => a.id === wanted) ? wanted : accounts[0]!.id;
    }
    writeAtomic(file, next);
  }

  function envToken(): string | null {
    return nonEmpty(env.CLAUDE_CODE_OAUTH_TOKEN);
  }

  return {
    getClaudeToken() {
      return load().active?.token ?? null;
    },
    getClaudeTokenFor(accountId) {
      if (accountId === ENV_CLAUDE_ACCOUNT_ID) return envToken();
      return load().accounts.find((a) => a.id === accountId)?.token ?? null;
    },
    addClaudeAccount(input) {
      const token = input.token.trim();
      const email = nonEmpty(input.email);
      const connectedAt = input.connectedAt ?? new Date().toISOString();
      const { file: current, accounts, active } = load();
      // Same email = the same subscription signed in again. Refresh in place so
      // a re-login never leaves a dead duplicate row behind.
      const existing = email ? accounts.find((a) => a.email === email) : undefined;
      const account: StoredClaudeAccount = existing
        ? {
            ...existing,
            token,
            connectedAt,
            planType: nonEmpty(input.planType) ?? existing.planType,
            label: nonEmpty(input.label) ?? existing.label,
          }
        : {
            id: crypto.randomUUID(),
            label: nonEmpty(input.label) ?? email ?? `Claude account ${accounts.length + 1}`,
            email,
            planType: nonEmpty(input.planType),
            token,
            connectedAt,
          };
      const next = existing ? accounts.map((a) => (a.id === existing.id ? account : a)) : [...accounts, account];
      const activate = input.activate ?? true;
      const activeId = activate ? account.id : active?.id ?? account.id;
      save(current, next, activeId);
      return summarize(account, activeId);
    },
    listClaudeAccounts() {
      const { accounts, active } = load();
      return accounts.map((a) => summarize(a, active?.id ?? null));
    },
    activeClaudeAccountId() {
      const { active } = load();
      if (active) return active.id;
      return envToken() ? ENV_CLAUDE_ACCOUNT_ID : null;
    },
    claudeAccountCredentials() {
      const { accounts } = load();
      if (accounts.length > 0) return accounts.map((a) => ({ id: a.id, token: a.token }));
      const fallback = envToken();
      return fallback ? [{ id: ENV_CLAUDE_ACCOUNT_ID, token: fallback }] : [];
    },
    setActiveClaudeAccount(accountId) {
      const { file: current, accounts } = load();
      if (!accounts.some((a) => a.id === accountId)) return false;
      save(current, accounts, accountId);
      return true;
    },
    renameClaudeAccount(accountId, label) {
      const trimmed = label.trim();
      if (!trimmed) return false;
      const { file: current, accounts, active } = load();
      if (!accounts.some((a) => a.id === accountId)) return false;
      save(current, accounts.map((a) => (a.id === accountId ? { ...a, label: trimmed } : a)), active?.id ?? null);
      return true;
    },
    removeClaudeAccount(accountId) {
      const { file: current, accounts, active } = load();
      if (!accounts.some((a) => a.id === accountId)) return false;
      const next = accounts.filter((a) => a.id !== accountId);
      // Removing the active account promotes the next one rather than leaving
      // the app credential-less while another account is still connected.
      const activeId = active && active.id !== accountId ? active.id : next[0]?.id ?? null;
      save(current, next, activeId);
      return true;
    },
    updateClaudeAccountProfile(accountId, profile) {
      const { file: current, accounts, active } = load();
      const target = accounts.find((a) => a.id === accountId);
      if (!target) return;
      const email = profile.email === undefined ? target.email : nonEmpty(profile.email);
      const planType = profile.planType === undefined ? target.planType : nonEmpty(profile.planType);
      // Keep a user-chosen label; only auto-labels follow the email.
      const label = target.label === 'Claude account' || target.label === target.email
        ? email ?? target.label
        : target.label;
      if (email === target.email && planType === target.planType && label === target.label) return;
      save(
        current,
        accounts.map((a) => (a.id === accountId ? { ...a, email, planType, label } : a)),
        active?.id ?? null,
        true,
      );
    },
    clearClaudeToken() {
      const { file: current } = load();
      save(current, [], null);
    },
    status() {
      const { active } = load();
      if (active) return { connected: true, connectedAt: active.connectedAt, source: 'app' };
      if (envToken()) return { connected: true, connectedAt: null, source: 'env' };
      return { connected: false, connectedAt: null, source: null };
    },
    getApiKeyOverride(id) {
      const v = readFileSafe(file).apiKeys?.[id];
      return typeof v === 'string' && v.trim() ? v.trim() : null;
    },
    setApiKeyOverride(id, value) {
      const trimmed = value.trim();
      const current = readFileSafe(file);
      const apiKeys = { ...(current.apiKeys ?? {}) };
      if (trimmed) apiKeys[id] = trimmed;
      else delete apiKeys[id];
      writeAtomic(file, { ...current, apiKeys });
    },
    clearApiKeyOverride(id) {
      const current = readFileSafe(file);
      if (!current.apiKeys || !(id in current.apiKeys)) return;
      const apiKeys = { ...current.apiKeys };
      delete apiKeys[id];
      writeAtomic(file, { ...current, apiKeys });
    },
  };
}
