import fs from 'node:fs';
import path from 'node:path';
import type { RateLimitInfo } from '../providers/claude/wire.js';
import type { ClaudeSnapshot } from './contract.js';
import type { ClaudeLimitResetStatus } from './claudeLimitReset.js';

/**
 * Persistent Claude usage store: `<dataDir>/usage.json`, one snapshot per
 * rateLimitType PER CONNECTED ACCOUNT, newest wins. Persisted so a restart
 * doesn't blank the meters until the next turn re-emits telemetry. Atomic write
 * via a temp file + rename, mirroring secrets/store.ts. Codex usage is fetched
 * on demand (see usage/codex.ts) and is NOT persisted here — the RPC is cheap
 * and live.
 *
 * Scoping by account is what makes the account switcher usable: two
 * subscriptions report the same window ids, so a single keyspace would let
 * whichever probed last overwrite the other and the meters would describe
 * nobody. The unsuffixed methods act on the active account; the `…For` variants
 * name an account explicitly (the prober meters every account, not just the
 * active one).
 */

interface AccountUsageFile {
  snapshots?: Record<string, ClaudeSnapshot>;
  planType?: string | null;
  accountEmail?: string | null;
  limitReset?: ClaudeLimitResetStatus | null;
}

interface UsageFile {
  /** Pre-multi-account shape; migrated into `accounts.primary` on read. */
  claude?: AccountUsageFile & { accounts?: Record<string, AccountUsageFile> };
}

export type ClaudeUsageSource = ClaudeSnapshot['source'];

/** Account id legacy (single-account) snapshots migrate to — matches secrets/store.ts. */
export const LEGACY_ACCOUNT_ID = 'primary';

export interface ClaudeAccountUsage {
  accountId: string;
  snapshots: ClaudeSnapshot[];
  planType: string | null;
  accountEmail: string | null;
  limitReset: ClaudeLimitResetStatus | null;
}

export interface UsageStore {
  /** Record a Claude window for the ACTIVE account; newest wins per type. */
  recordClaude(info: RateLimitInfo & { label?: string }, source: ClaudeUsageSource): void;
  /** Record a Claude window against a named account (the prober meters all of them). */
  recordClaudeFor(accountId: string, info: RateLimitInfo & { label?: string }, source: ClaudeUsageSource): void;
  /** Active account's snapshots (one per rateLimitType), in insertion order. */
  claudeSnapshots(): ClaudeSnapshot[];
  claudeSnapshotsFor(accountId: string): ClaudeSnapshot[];
  /** Epoch ms of the newest snapshot, or null if none. Drives probe staleness. */
  newestClaudeCapturedAtMs(): number | null;
  newestClaudeCapturedAtMsFor(accountId: string): number | null;
  /** Plan name from the OAuth usage endpoint ("max" etc.); persisted. */
  claudePlanType(): string | null;
  claudePlanTypeFor(accountId: string): string | null;
  setClaudePlanType(planType: string | null): void;
  setClaudePlanTypeFor(accountId: string, planType: string | null): void;
  /** Email of the account the token belongs to (OAuth profile); persisted. */
  claudeAccountEmail(): string | null;
  claudeAccountEmailFor(accountId: string): string | null;
  /**
   * Record the token's account. When it changes from a known account, every
   * stored snapshot (and plan) belonged to the old one and is dropped — the
   * meters restart from the next telemetry rather than showing a stranger's.
   */
  setClaudeAccountEmail(email: string | null): void;
  setClaudeAccountEmailFor(accountId: string, email: string | null): void;
  /** Claude-owned once-weekly session reset eligibility, scoped per account. */
  claudeLimitReset(): ClaudeLimitResetStatus | null;
  claudeLimitResetFor(accountId: string): ClaudeLimitResetStatus | null;
  setClaudeLimitReset(status: ClaudeLimitResetStatus | null): void;
  setClaudeLimitResetFor(accountId: string, status: ClaudeLimitResetStatus | null): void;
  /** Everything stored, per account — the shape GET /api/usage is built from. */
  allClaudeAccounts(): ClaudeAccountUsage[];
  /** Drop usage for accounts that are no longer connected. */
  forgetClaudeAccountsExcept(accountIds: string[]): void;
}

function readFileSafe(file: string): UsageFile {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object') return parsed as UsageFile;
  } catch {
    /* missing or corrupt → start empty */
  }
  return {};
}

function writeAtomic(file: string, data: UsageFile): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

const OVERALL_WEEKLY = 'seven_day';
const FABLE_WEEKLY = 'seven_day_fable';
const RETIRED_OVERAGE_WEEKLY = 'seven_day_overage_included';

function isRetiredWindow(rateLimitType: string): boolean {
  return rateLimitType === RETIRED_OVERAGE_WEEKLY;
}

/**
 * A snapshot whose window has already reset describes usage that no longer
 * counts — the meter restarted at 0. Keeping it renders a permanently frozen
 * percentage (verified 2026-07-20: a `seven_day_fable` and a retired
 * `seven_day_overage_included` snapshot from 2026-07-08 sat at 77%/99% for 12
 * days, because stream events only carry `utilization` above the warning
 * threshold and so never overwrote them). Expired snapshots are dropped; the
 * window reappears when fresh telemetry reports it again.
 */
function isExpired(snap: ClaudeSnapshot, nowMs: number): boolean {
  return snap.resetsAt != null && snap.resetsAt * 1000 < nowMs;
}

/**
 * Resolve which slot a "seven_day" snapshot belongs in. The probe (headers) is
 * the anchor for the overall weekly; a stream event whose reset time disagrees
 * with it is the model-scoped (Fable) weekly. When the probe first runs over an
 * older stream-sourced overall slot with a different reset, the old snapshot is
 * migrated to the Fable slot rather than dropped — it was the scoped window all
 * along, we just couldn't tell without the probe's anchor.
 */
function weeklyKey(snapshots: Map<string, ClaudeSnapshot>, snap: ClaudeSnapshot, source: ClaudeUsageSource): string {
  if (snap.rateLimitType !== OVERALL_WEEKLY || snap.resetsAt == null) return snap.rateLimitType;
  const existing = snapshots.get(OVERALL_WEEKLY);
  if (existing?.resetsAt == null || existing.resetsAt === snap.resetsAt) return OVERALL_WEEKLY;
  // Probe and oauth both read the account's overall weekly — either anchors it.
  if (source === 'stream' && existing.source !== 'stream') return FABLE_WEEKLY;
  if (source !== 'stream' && existing.source === 'stream') {
    snapshots.set(FABLE_WEEKLY, { ...existing, rateLimitType: FABLE_WEEKLY });
  }
  return OVERALL_WEEKLY;
}

interface AccountUsage {
  snapshots: Map<string, ClaudeSnapshot>;
  planType: string | null;
  accountEmail: string | null;
  limitReset: ClaudeLimitResetStatus | null;
}

export interface UsageStoreOptions {
  /**
   * Which account the unsuffixed methods act on. Defaults to the legacy id so
   * an install with one account (or none) keeps a single stable keyspace.
   */
  activeAccountId?: () => string | null;
  /**
   * Called after a snapshot is stored (stream telemetry or a probe). The runner
   * turns this into a `usage` frame on its event socket so web can nudge open
   * browsers to re-read GET /api/usage — the nav rings then move during a turn
   * instead of waiting for someone to open the Usage page. Must not throw.
   */
  onRecord?: () => void;
}

export function createUsageStore(dataDir: string, opts: UsageStoreOptions = {}): UsageStore {
  const file = path.join(dataDir, 'usage.json');
  // Load persisted snapshots once; keep them in memory and rewrite on every record.
  const accounts = new Map<string, AccountUsage>();
  const loaded = readFileSafe(file).claude;
  let dirtyOnLoad = false;

  /** Hydrate one account's persisted block, dropping retired/expired snapshots. */
  function hydrate(accountId: string, raw: AccountUsageFile | undefined): void {
    const entry: AccountUsage = {
      snapshots: new Map(),
      planType: typeof raw?.planType === 'string' ? raw.planType : null,
      accountEmail: typeof raw?.accountEmail === 'string' ? raw.accountEmail : null,
      limitReset: raw?.limitReset && typeof raw.limitReset === 'object' ? raw.limitReset : null,
    };
    for (const [type, snap] of Object.entries(raw?.snapshots ?? {})) {
      // Claude now reports overage as event metadata; the retired pseudo-window
      // must never compete with the real OAuth Fable meter.
      if (isRetiredWindow(type) || (snap && isRetiredWindow(snap.rateLimitType))) {
        dirtyOnLoad = true;
        continue;
      }
      if (snap && typeof snap === 'object' && typeof snap.utilization === 'number' && !isExpired(snap, Date.now())) {
        entry.snapshots.set(type, snap);
      }
    }
    accounts.set(accountId, entry);
  }

  for (const [accountId, raw] of Object.entries(loaded?.accounts ?? {})) hydrate(accountId, raw);
  // Pre-multi-account file: its snapshots belong to the one connected account,
  // which secrets/store.ts migrates under the same 'primary' id.
  if (loaded && !loaded.accounts && (loaded.snapshots || loaded.planType || loaded.accountEmail)) {
    hydrate(LEGACY_ACCOUNT_ID, loaded);
    dirtyOnLoad = true;
  }

  function entry(accountId: string): AccountUsage {
    let found = accounts.get(accountId);
    if (!found) {
      found = { snapshots: new Map(), planType: null, accountEmail: null, limitReset: null };
      accounts.set(accountId, found);
    }
    return found;
  }

  function activeId(): string {
    return opts.activeAccountId?.() ?? LEGACY_ACCOUNT_ID;
  }

  function persist(): void {
    const serialized: Record<string, AccountUsageFile> = {};
    for (const [accountId, acc] of accounts) {
      serialized[accountId] = {
        snapshots: Object.fromEntries(acc.snapshots),
        planType: acc.planType,
        accountEmail: acc.accountEmail,
        limitReset: acc.limitReset,
      };
    }
    writeAtomic(file, { claude: { accounts: serialized } });
  }

  // Rewrite immediately when the load dropped or migrated anything.
  if (dirtyOnLoad) persist();

  /** Drop snapshots whose window has since reset; persist if anything went. */
  function purgeExpired(): void {
    const now = Date.now();
    let removed = false;
    for (const acc of accounts.values()) {
      for (const [key, snap] of acc.snapshots) {
        if (isExpired(snap, now)) {
          acc.snapshots.delete(key);
          removed = true;
        }
      }
    }
    if (removed) persist();
  }

  function record(accountId: string, info: RateLimitInfo & { label?: string }, source: ClaudeUsageSource): void {
    // Older Claude clients can still emit this retired pseudo-window. It is
    // not Fable usage and must not compete with the OAuth Fable snapshot.
    if (isRetiredWindow(info.rateLimitType)) return;
    // Low-usage stream events omit `utilization` (status "allowed") — nothing
    // to meter, so don't let them blank a snapshot we already have.
    if (typeof info.utilization !== 'number') return;
    const snap: ClaudeSnapshot = {
      rateLimitType: info.rateLimitType,
      utilization: info.utilization,
      resetsAt: typeof info.resetsAt === 'number' ? info.resetsAt : null,
      status: info.status ?? null,
      source,
      ...(info.label ? { label: info.label } : {}),
      capturedAt: new Date().toISOString(),
    };
    const snapshots = entry(accountId).snapshots;
    // Claude has TWO weekly windows that both arrive typed "seven_day": the
    // overall one (probe, from the unified 7d headers) and the Fable-scoped
    // one (stream, when it is the binding claim of a Fable turn). Same type,
    // different reset times — use the reset to keep them in separate slots.
    const key = weeklyKey(snapshots, snap, source);
    snapshots.set(key, key === snap.rateLimitType ? snap : { ...snap, rateLimitType: key });
    persist();
    // Notifying is best-effort: a broken listener must never lose the write.
    try {
      opts.onRecord?.();
    } catch {
      /* the notifier's problem */
    }
  }

  function snapshotsFor(accountId: string): ClaudeSnapshot[] {
    purgeExpired();
    return [...(accounts.get(accountId)?.snapshots.values() ?? [])];
  }

  function newestFor(accountId: string): number | null {
    purgeExpired();
    let newest: number | null = null;
    for (const snap of accounts.get(accountId)?.snapshots.values() ?? []) {
      const t = Date.parse(snap.capturedAt);
      if (Number.isFinite(t) && (newest == null || t > newest)) newest = t;
    }
    return newest;
  }

  function setEmail(accountId: string, next: string | null): void {
    const acc = entry(accountId);
    if (next === acc.accountEmail) return;
    // A different identity in the same slot means a re-login as someone else;
    // the stored meters described the old account.
    const switched = acc.accountEmail != null && next != null;
    acc.accountEmail = next;
    if (switched) {
      acc.snapshots.clear();
      acc.planType = null;
      acc.limitReset = null;
    }
    persist();
  }

  function setPlan(accountId: string, next: string | null): void {
    const acc = entry(accountId);
    if (next === acc.planType) return;
    acc.planType = next;
    persist();
  }

  function setLimitReset(accountId: string, next: ClaudeLimitResetStatus | null): void {
    const acc = entry(accountId);
    acc.limitReset = next;
    persist();
    try {
      opts.onRecord?.();
    } catch {
      /* the notifier's problem */
    }
  }

  return {
    recordClaude(info, source) {
      record(activeId(), info, source);
    },
    recordClaudeFor(accountId, info, source) {
      record(accountId, info, source);
    },
    claudeSnapshots() {
      return snapshotsFor(activeId());
    },
    claudeSnapshotsFor(accountId) {
      return snapshotsFor(accountId);
    },
    newestClaudeCapturedAtMs() {
      return newestFor(activeId());
    },
    newestClaudeCapturedAtMsFor(accountId) {
      return newestFor(accountId);
    },
    claudePlanType() {
      return accounts.get(activeId())?.planType ?? null;
    },
    claudePlanTypeFor(accountId) {
      return accounts.get(accountId)?.planType ?? null;
    },
    setClaudePlanType(planType) {
      setPlan(activeId(), planType);
    },
    setClaudePlanTypeFor(accountId, planType) {
      setPlan(accountId, planType);
    },
    claudeAccountEmail() {
      return accounts.get(activeId())?.accountEmail ?? null;
    },
    claudeAccountEmailFor(accountId) {
      return accounts.get(accountId)?.accountEmail ?? null;
    },
    setClaudeAccountEmail(email) {
      setEmail(activeId(), email);
    },
    setClaudeAccountEmailFor(accountId, email) {
      setEmail(accountId, email);
    },
    claudeLimitReset() {
      return accounts.get(activeId())?.limitReset ?? null;
    },
    claudeLimitResetFor(accountId) {
      return accounts.get(accountId)?.limitReset ?? null;
    },
    setClaudeLimitReset(status) {
      setLimitReset(activeId(), status);
    },
    setClaudeLimitResetFor(accountId, status) {
      setLimitReset(accountId, status);
    },
    allClaudeAccounts() {
      purgeExpired();
      return [...accounts.entries()].map(([accountId, acc]) => ({
        accountId,
        snapshots: [...acc.snapshots.values()],
        planType: acc.planType,
        accountEmail: acc.accountEmail,
        limitReset: acc.limitReset,
      }));
    },
    forgetClaudeAccountsExcept(accountIds) {
      const keep = new Set(accountIds);
      let removed = false;
      for (const accountId of [...accounts.keys()]) {
        if (!keep.has(accountId)) {
          accounts.delete(accountId);
          removed = true;
        }
      }
      if (removed) persist();
    },
  };
}
