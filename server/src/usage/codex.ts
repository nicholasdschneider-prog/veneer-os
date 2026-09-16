import fs from 'node:fs';
import path from 'node:path';
import { proCodexHome, proServiceEnv } from '../homes.js';
import { AppServerClient } from '../providers/codexAppServer/protocol.js';
import {
  codexWindows,
  normalizeCodexRpc,
  normalizeCodexSession,
  type ProviderAccountUsageBlock,
  type ProviderUsage,
} from './contract.js';
import type { CodexAccountStore } from '../codex/accounts.js';

/**
 * On-demand Codex subscription usage. Primary source is the live
 * `account/rateLimits/read` JSON-RPC against a `codex app-server` process
 * (verified 2026-07-06: params {} → {rateLimits:{primary,secondary,planType,…}}).
 * If that's unavailable (codex not installed / not logged in / hung), fall back
 * to the newest `token_count` event's `rate_limits` in ~/.codex/sessions. The
 * result is cached ~60s so a Settings poll doesn't re-spawn/re-scan constantly.
 */

const CACHE_TTL_MS = 60_000;
const RPC_TIMEOUT_MS = 8_000;
/** Only the newest few session files are worth scanning for a fallback snapshot. */
const SESSION_SCAN_LIMIT = 5;

export interface CodexUsageReaderOptions {
  codexBin: string;
  /** The account profile to read (default: CODEX_HOME, then Pro's primary profile). */
  codexHome?: string;
  /** Override the app-server client (tests). */
  client?: AppServerClient;
  /** Session directory to scan for the fallback (default ~/.codex/sessions). */
  sessionsDir?: string;
  /** Credential file metadata only; its contents are never read here. */
  authFile?: string;
  cacheTtlMs?: number;
  rpcTimeoutMs?: number;
  log?: Pick<Console, 'warn' | 'error'>;
}

export interface CodexUsageReader {
  read(): Promise<ProviderUsage>;
  /** Reap the lazily-spawned app-server process on clean shutdown. */
  shutdown(): void;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** Recursively collect *.jsonl session files, newest-modified first. */
function newestSessionFiles(dir: string, limit: number): string[] {
  const out: { file: string; mtime: number }[] = [];
  const walk = (d: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && e.name.endsWith('.jsonl')) {
        try {
          out.push({ file: full, mtime: fs.statSync(full).mtimeMs });
        } catch {
          /* vanished mid-scan */
        }
      }
    }
  };
  walk(dir);
  return out
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit)
    .map((x) => x.file);
}

/** Newest `token_count` `rate_limits` payload across the most recent session files. */
export function readNewestSessionRateLimits(sessionsDir: string, capturedAfter = 0): unknown | null {
  for (const file of newestSessionFiles(sessionsDir, SESSION_SCAN_LIMIT)) {
    let lines: string[];
    try {
      lines = fs.readFileSync(file, 'utf8').split('\n');
    } catch {
      continue;
    }
    // Scan from the end — the last token_count carries the freshest limits.
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line || !line.includes('token_count') || !line.includes('rate_limits')) continue;
      try {
        const obj = JSON.parse(line) as { timestamp?: string; payload?: { type?: string; rate_limits?: unknown } };
        // A previous login's historical meters must not follow a new account.
        if (capturedAfter && !(Date.parse(obj.timestamp ?? '') >= capturedAfter)) continue;
        if (obj.payload?.type === 'token_count' && obj.payload.rate_limits) return obj.payload.rate_limits;
      } catch {
        /* not the line we want */
      }
    }
  }
  return null;
}

export function createCodexUsageReader(opts: CodexUsageReaderOptions): CodexUsageReader {
  const log = opts.log ?? console;
  const codexHome = opts.codexHome ?? (process.env.CODEX_HOME?.trim() || proCodexHome());
  const sessionsDir = opts.sessionsDir ?? path.join(codexHome, 'sessions');
  const authFile = opts.authFile ?? path.join(codexHome, 'auth.json');
  const cacheTtl = opts.cacheTtlMs ?? CACHE_TTL_MS;
  const rpcTimeout = opts.rpcTimeoutMs ?? RPC_TIMEOUT_MS;
  // Lazily spawned, reused across reads (the client respawns itself on death).
  let client: AppServerClient | null = opts.client ?? null;
  let cache: { at: number; value: ProviderUsage } | null = null;
  let authRevision: string | null = null;
  let pending: { revision: string; result: Promise<ProviderUsage> } | null = null;

  function currentAuth(): { revision: string; modifiedAt: number } | null {
    try {
      const stat = fs.statSync(authFile);
      if (!stat.isFile() || stat.size === 0) return null;
      return { revision: `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`, modifiedAt: stat.mtimeMs };
    } catch {
      return null;
    }
  }

  function syncAuth(): ReturnType<typeof currentAuth> {
    const auth = currentAuth();
    const revision = auth?.revision ?? null;
    if (revision !== authRevision) {
      authRevision = revision;
      cache = null;
      pending = null;
      // The long-lived app server can retain the previous account in memory.
      if (!opts.client) {
        client?.shutdown();
        client = null;
      }
    }
    return auth;
  }

  function unavailable(): ProviderUsage {
    return {
      connected: false, planType: null, windows: [], capturedAt: null, source: null,
      error: 'Codex usage is unavailable — it may not be installed or signed in.',
    };
  }

  async function readLive(): Promise<ProviderUsage | null> {
    // Pro's own Codex profile: this reads the subscription's rate limits, so it
    // must use the service login, never whatever HOME this process inherited.
    if (!client) client = new AppServerClient({ codexBin: opts.codexBin, env: { ...proServiceEnv(), CODEX_HOME: codexHome }, log });
    let res: unknown;
    try {
      res = await withTimeout(client.request('account/rateLimits/read', {}), rpcTimeout);
    } catch (err) {
      log.warn(`[usage] codex rateLimits RPC failed: ${(err as Error).message}`);
      return null;
    }
    const rateLimits = (res as { rateLimits?: unknown } | null)?.rateLimits;
    const snap = normalizeCodexRpc(rateLimits);
    const windows = codexWindows(snap);
    return {
      connected: true,
      planType: snap.planType,
      windows,
      capturedAt: new Date().toISOString(),
      source: 'live',
      error: null,
    };
  }

  function readSessions(capturedAfter: number): ProviderUsage | null {
    const rateLimits = readNewestSessionRateLimits(sessionsDir, capturedAfter);
    if (!rateLimits) return null;
    const snap = normalizeCodexSession(rateLimits);
    return {
      connected: true,
      planType: snap.planType,
      windows: codexWindows(snap),
      capturedAt: new Date().toISOString(),
      source: 'sessions',
      error: null,
    };
  }

  return {
    async read() {
      const auth = syncAuth();
      if (!auth) return unavailable();
      if (cache && Date.now() - cache.at < cacheTtl) return cache.value;
      if (pending?.revision === auth.revision) return pending.result;
      const result = (async () => {
        let value = await readLive();
        // Logout/account replacement may have happened while the RPC was pending.
        if (syncAuth()?.revision !== auth.revision) return unavailable();
        if (!value) value = readSessions(auth.modifiedAt);
        if (!value) value = unavailable();
        // Cache failures too so multiple viewers cannot repeatedly spawn Codex.
        cache = { at: Date.now(), value };
        return value;
      })();
      const request = { revision: auth.revision, result };
      pending = request;
      try {
        return await result;
      } finally {
        // An old account's completion must not clear its replacement's request.
        if (pending === request) pending = null;
      }
    },
    shutdown() {
      // Only reap a client we own; an injected one belongs to the caller.
      if (!opts.client) client?.shutdown();
    },
  };
}

export interface CodexAccountUsageOptions {
  codexBin: string;
  accounts: Pick<CodexAccountStore, 'list' | 'homeFor'>;
  /** Build one reader per account (tests inject fakes). */
  readerFor?: (accountId: string, codexHome: string) => CodexUsageReader;
  cacheTtlMs?: number;
  rpcTimeoutMs?: number;
  log?: Pick<Console, 'warn' | 'error'>;
}

/**
 * Usage across every connected Codex account. Same `CodexUsageReader` shape as
 * a single reader, so `GET /api/usage` is unchanged for a one-account install:
 * the top-level fields describe the ACTIVE account, and `accounts` carries one
 * block per registered account so the Usage screen can show which one still
 * has headroom. One lazily-spawned reader per account; readers for removed
 * accounts are shut down on the next read.
 */
export function createCodexAccountUsage(opts: CodexAccountUsageOptions): CodexUsageReader {
  const log = opts.log ?? console;
  const readers = new Map<string, CodexUsageReader>();
  const readerFor = opts.readerFor ?? ((_id: string, codexHome: string) =>
    createCodexUsageReader({
      codexBin: opts.codexBin, codexHome, cacheTtlMs: opts.cacheTtlMs, rpcTimeoutMs: opts.rpcTimeoutMs, log,
    }));

  function reader(accountId: string): CodexUsageReader {
    let existing = readers.get(accountId);
    if (!existing) {
      existing = readerFor(accountId, opts.accounts.homeFor(accountId));
      readers.set(accountId, existing);
    }
    return existing;
  }

  return {
    async read() {
      const accounts = opts.accounts.list();
      const live = new Set(accounts.map((a) => a.id));
      for (const [id, r] of readers) {
        if (!live.has(id)) {
          r.shutdown();
          readers.delete(id);
        }
      }
      if (accounts.length === 0) {
        return {
          connected: false, planType: null, windows: [], capturedAt: null, source: null,
          error: 'Codex usage is unavailable — it may not be installed or signed in.',
        };
      }
      const blocks: ProviderAccountUsageBlock[] = await Promise.all(accounts.map(async (account) => {
        const usage = await reader(account.id).read();
        return {
          accountId: account.id,
          label: account.label,
          accountEmail: account.email,
          planType: usage.planType ?? account.planType,
          active: account.active,
          windows: usage.windows,
          capturedAt: usage.capturedAt,
          source: usage.source,
          limitReset: null,
          connected: usage.connected,
          error: usage.error,
        };
      }));
      const active = blocks.find((b) => b.active) ?? blocks[0]!;
      return {
        connected: active.connected ?? false,
        planType: active.planType,
        accountEmail: active.accountEmail,
        windows: active.windows,
        capturedAt: active.capturedAt,
        source: active.source,
        error: active.error ?? null,
        accounts: blocks,
      };
    },
    shutdown() {
      for (const r of readers.values()) r.shutdown();
      readers.clear();
    },
  };
}
