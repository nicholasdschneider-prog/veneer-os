import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { currentHomes, proCodexHome, type Homes } from '../homes.js';

/**
 * Several Codex (ChatGPT) subscriptions connected at once, one active — the
 * Codex counterpart of the multi-account Claude support in secrets/store.ts.
 *
 * Claude accounts are tokens Veneer injects per spawn, so they can share one
 * config directory. Codex keeps its credential in `$CODEX_HOME/auth.json` and
 * offers no per-process override, so every account gets its OWN `CODEX_HOME`:
 *
 *   - the account adopted from an existing install (`primary`) keeps living in
 *     Pro's original `.codex` profile, so nothing moves on upgrade;
 *   - every further account lives in `.codex-accounts/<id>/`, where everything
 *     except `auth.json` is a symlink back into the primary profile. Sessions,
 *     the thread index, skills, config and caches are therefore ONE set of
 *     files whichever account is active, and a chat started on one account
 *     resumes on another.
 *
 * The registry itself (`DATA_DIR/codex-accounts.json`) carries no secrets:
 * only labels, identity for display, and which account is active. Web and the
 * runner each open their own store; the file is the shared channel, exactly
 * like secrets.json for Claude.
 */

/** Id of the account adopted from the pre-multi-account `.codex` profile. */
export const LEGACY_CODEX_ACCOUNT_ID = 'primary';
/** Directory (under the service home) holding the non-primary account homes. */
export const CODEX_ACCOUNTS_DIRNAME = '.codex-accounts';
/** Entries a per-account home must own itself rather than share. */
const PRIVATE_ENTRIES = new Set(['auth.json']);

export interface StoredCodexAccount {
  id: string;
  /** User-facing name. Defaults to the account email, then a generic label. */
  label: string;
  email: string | null;
  /** ChatGPT plan ("plus", "pro", …) from the id_token, or null. */
  planType: string | null;
  connectedAt: string;
}

export type CodexAccountSummary = StoredCodexAccount & {
  active: boolean;
  /** Whether the account's home still holds a credential file. */
  connected: boolean;
};

interface CodexAccountsFile {
  accounts?: StoredCodexAccount[];
  activeAccountId?: string;
}

export interface AddCodexAccountInput {
  /** Fixed id (the legacy adoption); a fresh UUID otherwise. */
  id?: string;
  email?: string | null;
  planType?: string | null;
  label?: string | null;
  connectedAt?: string;
  /** Make the new account active (default true — you just signed into it). */
  activate?: boolean;
}

export interface CodexAccountStore {
  /** All registered accounts, in connection order. */
  list(): CodexAccountSummary[];
  /** The active account, or null when none is registered. */
  active(): CodexAccountSummary | null;
  activeAccountId(): string | null;
  /**
   * Register an account. Same email = the same subscription signed in again:
   * refreshed in place rather than added twice.
   */
  add(input: AddCodexAccountInput): CodexAccountSummary;
  setActive(accountId: string): boolean;
  rename(accountId: string, label: string): boolean;
  /** Forget one account; the next remaining one becomes active. Does not touch disk homes. */
  remove(accountId: string): boolean;
  updateProfile(accountId: string, profile: { email?: string | null; planType?: string | null }): void;
  /** Forget every account (the registry only). */
  clear(): void;
  /** The CODEX_HOME an account's processes run with. */
  homeFor(accountId: string): string;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** Pro's original profile for the legacy account, a sibling directory for the rest. */
export function codexAccountHome(accountId: string, homes: Homes = currentHomes()): string {
  if (accountId === LEGACY_CODEX_ACCOUNT_ID) return proCodexHome(homes);
  if (!/^[A-Za-z0-9._-]+$/.test(accountId) || accountId.startsWith('.')) {
    throw new Error(`Invalid Codex account id: ${accountId}`);
  }
  return path.join(homes.serviceHome, CODEX_ACCOUNTS_DIRNAME, accountId);
}

/** A throwaway home for a sign-in in progress; adopted or deleted afterwards. */
export function codexStagingHome(attemptId: string, homes: Homes = currentHomes()): string {
  return path.join(homes.serviceHome, CODEX_ACCOUNTS_DIRNAME, `pending-${attemptId}`);
}

/**
 * Make `home` a full Codex profile that shares everything but its credential
 * with the primary profile. Idempotent and safe to run before every spawn: a
 * file the primary profile gained since last time (a new state database, a
 * new skills directory) is linked in on the next call. An entry the account
 * already owns as a real file is left alone.
 */
export function ensureCodexAccountHome(home: string, homes: Homes = currentHomes()): string {
  const primary = proCodexHome(homes);
  fs.mkdirSync(home, { recursive: true });
  if (path.resolve(home) === path.resolve(primary)) return home;
  fs.mkdirSync(primary, { recursive: true });
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(primary);
  } catch {
    return home;
  }
  for (const name of entries) {
    if (PRIVATE_ENTRIES.has(name)) continue;
    // SQLite side files belong beside the file they journal; SQLite resolves the
    // main database through the link, so they land in the primary profile anyway.
    if (name.endsWith('-wal') || name.endsWith('-shm') || name.endsWith('-journal')) continue;
    const target = path.join(primary, name);
    const link = path.join(home, name);
    try {
      fs.lstatSync(link);
      continue; // present already, whether a link or the account's own file
    } catch {
      /* absent — link it */
    }
    try {
      fs.symlinkSync(target, link);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
  return home;
}

/** Whether a Codex home holds a (non-empty) credential file. */
export function codexHomeHasCredential(home: string): boolean {
  try {
    const stat = fs.statSync(path.join(home, 'auth.json'));
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

/** Identity (email + plan) decoded from a home's auth.json for display only. */
export function readCodexIdentity(home: string): { email: string | null; plan: string | null } | null {
  try {
    const auth = JSON.parse(fs.readFileSync(path.join(home, 'auth.json'), 'utf8')) as {
      tokens?: { id_token?: string };
    };
    const idToken = auth.tokens?.id_token;
    const payloadB64 = typeof idToken === 'string' ? idToken.split('.')[1] : undefined;
    if (!payloadB64) return null;
    const claims = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as {
      email?: string;
      'https://api.openai.com/auth'?: { chatgpt_plan_type?: string };
    };
    const email = typeof claims.email === 'string' ? claims.email : null;
    const planRaw = claims['https://api.openai.com/auth']?.chatgpt_plan_type;
    const plan = typeof planRaw === 'string' ? planRaw : null;
    return email || plan ? { email, plan } : null;
  } catch {
    return null;
  }
}

function readFileSafe(file: string): CodexAccountsFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    if (parsed && typeof parsed === 'object') return parsed as CodexAccountsFile;
  } catch {
    /* missing or corrupt → empty */
  }
  return {};
}

function writeAtomic(file: string, data: CodexAccountsFile): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function normalize(file: CodexAccountsFile): StoredCodexAccount[] {
  const out: StoredCodexAccount[] = [];
  const seen = new Set<string>();
  for (const raw of Array.isArray(file.accounts) ? file.accounts : []) {
    const id = nonEmpty(raw?.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      label: nonEmpty(raw.label) ?? nonEmpty(raw.email) ?? 'Codex account',
      email: nonEmpty(raw.email),
      planType: nonEmpty(raw.planType),
      connectedAt: nonEmpty(raw.connectedAt) ?? new Date(0).toISOString(),
    });
  }
  return out;
}

function resolveActive(file: CodexAccountsFile, accounts: StoredCodexAccount[]): StoredCodexAccount | null {
  if (accounts.length === 0) return null;
  const wanted = nonEmpty(file.activeAccountId);
  return accounts.find((a) => a.id === wanted) ?? accounts[0]!;
}

export function createCodexAccountStore(dataDir: string, homes: Homes = currentHomes()): CodexAccountStore {
  const file = path.join(dataDir, 'codex-accounts.json');

  function load(): { file: CodexAccountsFile; accounts: StoredCodexAccount[]; active: StoredCodexAccount | null } {
    const current = readFileSafe(file);
    const accounts = normalize(current);
    return { file: current, accounts, active: resolveActive(current, accounts) };
  }

  /**
   * `keepActiveFromDisk` re-reads the active id at write time: a background
   * profile refresh must never undo a switch the user made meanwhile.
   */
  function save(accounts: StoredCodexAccount[], activeId: string | null, keepActiveFromDisk = false): void {
    const wanted = keepActiveFromDisk ? nonEmpty(readFileSafe(file).activeAccountId) ?? activeId : activeId;
    if (accounts.length === 0) {
      writeAtomic(file, {});
      return;
    }
    writeAtomic(file, {
      accounts,
      activeAccountId: wanted && accounts.some((a) => a.id === wanted) ? wanted : accounts[0]!.id,
    });
  }

  function homeFor(accountId: string): string {
    return codexAccountHome(accountId, homes);
  }

  function summarize(account: StoredCodexAccount, activeId: string | null): CodexAccountSummary {
    return { ...account, active: account.id === activeId, connected: codexHomeHasCredential(homeFor(account.id)) };
  }

  return {
    list() {
      const { accounts, active } = load();
      return accounts.map((a) => summarize(a, active?.id ?? null));
    },
    active() {
      const { active } = load();
      return active ? summarize(active, active.id) : null;
    },
    activeAccountId() {
      return load().active?.id ?? null;
    },
    add(input) {
      const email = nonEmpty(input.email);
      const connectedAt = input.connectedAt ?? new Date().toISOString();
      const { accounts, active } = load();
      const fixedId = nonEmpty(input.id);
      const existing = accounts.find((a) => (fixedId && a.id === fixedId) || (email && a.email === email));
      const account: StoredCodexAccount = existing
        ? {
            ...existing,
            connectedAt,
            email: email ?? existing.email,
            planType: nonEmpty(input.planType) ?? existing.planType,
            label: nonEmpty(input.label) ?? existing.label,
          }
        : {
            id: fixedId ?? crypto.randomUUID(),
            label: nonEmpty(input.label) ?? email ?? `Codex account ${accounts.length + 1}`,
            email,
            planType: nonEmpty(input.planType),
            connectedAt,
          };
      const next = existing ? accounts.map((a) => (a.id === existing.id ? account : a)) : [...accounts, account];
      const activate = input.activate ?? true;
      const activeId = activate ? account.id : active?.id ?? account.id;
      save(next, activeId);
      return summarize(account, activeId);
    },
    setActive(accountId) {
      const { accounts } = load();
      if (!accounts.some((a) => a.id === accountId)) return false;
      save(accounts, accountId);
      return true;
    },
    rename(accountId, label) {
      const trimmed = label.trim();
      if (!trimmed) return false;
      const { accounts, active } = load();
      if (!accounts.some((a) => a.id === accountId)) return false;
      save(accounts.map((a) => (a.id === accountId ? { ...a, label: trimmed } : a)), active?.id ?? null);
      return true;
    },
    remove(accountId) {
      const { accounts, active } = load();
      if (!accounts.some((a) => a.id === accountId)) return false;
      const next = accounts.filter((a) => a.id !== accountId);
      const activeId = active && active.id !== accountId ? active.id : next[0]?.id ?? null;
      save(next, activeId);
      return true;
    },
    updateProfile(accountId, profile) {
      const { accounts, active } = load();
      const target = accounts.find((a) => a.id === accountId);
      if (!target) return;
      const email = profile.email === undefined ? target.email : nonEmpty(profile.email);
      const planType = profile.planType === undefined ? target.planType : nonEmpty(profile.planType);
      const label = target.label === 'Codex account' || target.label === target.email || /^Codex account \d+$/.test(target.label)
        ? email ?? target.label
        : target.label;
      if (email === target.email && planType === target.planType && label === target.label) return;
      save(accounts.map((a) => (a.id === accountId ? { ...a, email, planType, label } : a)), active?.id ?? null, true);
    },
    clear() {
      save([], null);
    },
    homeFor,
  };
}

/**
 * One-time adoption of a pre-multi-account install: a credential sitting in
 * Pro's original `.codex` profile with no registry entry becomes account
 * `primary`. Also re-syncs identity for registered accounts whose home has a
 * fresher id_token (Codex refreshes auth.json itself). Never throws.
 */
export function adoptCodexLogins(store: CodexAccountStore, homes: Homes = currentHomes()): void {
  try {
    const accounts = store.list();
    const primaryHome = proCodexHome(homes);
    if (!accounts.some((a) => a.id === LEGACY_CODEX_ACCOUNT_ID) && codexHomeHasCredential(primaryHome)) {
      const identity = readCodexIdentity(primaryHome);
      store.add({
        id: LEGACY_CODEX_ACCOUNT_ID,
        email: identity?.email ?? null,
        planType: identity?.plan ?? null,
        activate: accounts.length === 0,
      });
    }
    for (const account of store.list()) {
      const identity = readCodexIdentity(store.homeFor(account.id));
      if (!identity) continue;
      store.updateProfile(account.id, { email: identity.email, planType: identity.plan });
    }
  } catch {
    /* best effort */
  }
}

/**
 * Turn a finished sign-in (credential in `stagingHome`) into a registered
 * account: an existing account with the same email gets the fresh credential,
 * anyone else becomes a new account with its own home. The staging directory
 * is removed either way.
 */
export function adoptCodexLogin(
  store: CodexAccountStore,
  stagingHome: string,
  homes: Homes = currentHomes(),
): CodexAccountSummary {
  const identity = readCodexIdentity(stagingHome);
  const stagingAuth = path.join(stagingHome, 'auth.json');
  if (!codexHomeHasCredential(stagingHome)) throw new Error('The sign-in finished without writing a credential.');
  const account = store.add({ email: identity?.email ?? null, planType: identity?.plan ?? null });
  const home = ensureCodexAccountHome(store.homeFor(account.id), homes);
  fs.copyFileSync(stagingAuth, path.join(home, 'auth.json'));
  fs.chmodSync(path.join(home, 'auth.json'), 0o600);
  fs.rmSync(stagingHome, { recursive: true, force: true });
  return { ...account, connected: true };
}

/**
 * Forget an account and its credential. The primary profile keeps everything
 * but its auth.json (that profile IS the shared history); a sibling home is
 * removed outright — it held nothing but links and the credential.
 */
export function removeCodexAccountFiles(store: CodexAccountStore, accountId: string, homes: Homes = currentHomes()): void {
  const home = store.homeFor(accountId);
  if (accountId === LEGACY_CODEX_ACCOUNT_ID || path.resolve(home) === path.resolve(proCodexHome(homes))) {
    fs.rmSync(path.join(home, 'auth.json'), { force: true });
    return;
  }
  fs.rmSync(home, { recursive: true, force: true });
}
