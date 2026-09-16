import type Database from 'better-sqlite3';
import type { Config } from './config.js';
import type { IdentityResolver } from './identity/cloudflareAccess.js';
import type { RunnerClient } from './runner/client.js';
import type { UserRow } from './db/db.js';
import type { SecretStore } from './secrets/store.js';
import type { ClaudeConnectManager } from './claude/setupToken.js';
import type { CodexConnectManager } from './codex/deviceAuth.js';
import type { CodexAccountStore } from './codex/accounts.js';
import type { GrokConnectManager } from './grok/deviceAuth.js';
import type { CodexUsageReader } from './usage/codex.js';
import type { GrokUsageReader } from './usage/grok.js';
import type { OpenRouterUsageReader } from './usage/openrouter.js';
import type { LocalAppRunnerClient } from './miniApps/localClient.js';
import type { DopplerRuntime, DopplerTokenStore } from './secrets/doppler.js';
import type { ProjectDopplerCli } from './secrets/projectDopplerCli.js';
import type { PageExpiryService } from './pages/expiry.js';
import type { SupermemoryProvisioner } from './memory/provision.js';

/** One AppContext threads all server state (spec §3 convention) — no module-level singletons. */
export interface AppContext {
  config: Config;
  db: Database.Database;
  /**
   * Async handle to the runner process (owns adapters + conversation manager +
   * usage writer). Every turn-related call goes over IPC — web runs no manager.
   */
  manager: RunnerClient;
  resolveIdentity: IdentityResolver;
  secrets: SecretStore;
  /** Client-scoped Doppler credentials (0600 file, outside SQLite/backups). */
  dopplerTokens: DopplerTokenStore;
  /** Short-lived, memory-only snapshot of the read-only runtime config. */
  doppler: DopplerRuntime;
  /**
   * Main-Pro-only wrapper around the interactive user's authenticated Doppler
   * CLI (null on client instances). Routes use it to write a secret the user
   * typed into a secret card without ever handing it to an agent.
   */
  projectDopplerCli?: ProjectDopplerCli | null;
  claudeConnect: ClaudeConnectManager;
  codexConnect: CodexConnectManager;
  /** Registry of connected Codex accounts and their profiles (see codex/accounts.ts). */
  codexAccounts: CodexAccountStore;
  /** Drives `grok login --device-auth`; Grok owns its own auth.json. */
  grokConnect: GrokConnectManager;
  /** On-demand Codex subscription usage (live RPC, session-file fallback, ~60s cache). */
  codexUsage: CodexUsageReader;
  /** On-demand Grok SuperGrok credit usage (CLI billing REST, ~60s cache). */
  grokUsage: GrokUsageReader;
  /** OpenRouter key totals + management analytics, cached for five minutes. */
  openRouterUsage: OpenRouterUsageReader;
  /** Local Mini App lifecycle control; app HTTP traffic is proxied separately. */
  appRunner?: LocalAppRunnerClient;
  /** Coordinates active page publishes with the expiry cleanup loop. */
  pageExpiry?: PageExpiryService;
  /** Idempotent local Memory setup, retried as provider credentials appear. */
  memoryProvisioner?: SupermemoryProvisioner;
  /** Single-use tickets for the direct LAN viewer socket (present when configured). */
  viewerTickets?: import('./channels/lanViewer.js').ViewerTicketStore;
  /**
   * Clean-shutdown-then-exit(0); systemd (`Restart=always`) brings the service
   * back. Wired in index.ts once the http server exists. Owner/consultant only,
   * via POST /api/admin/restart — used to unstick the box from the phone.
   */
  requestRestart?: () => void;
}

export function findUserByEmail(db: Database.Database, email: string): UserRow | undefined {
  return db.prepare('SELECT * FROM users WHERE email = ?').get(email.trim().toLowerCase()) as UserRow | undefined;
}

export function userCount(db: Database.Database): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
}
