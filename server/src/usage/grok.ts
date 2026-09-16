import fs from 'node:fs';
import path from 'node:path';
import { proGrokHome } from '../homes.js';
import { readGrokAuth, type GrokAccount } from '../grok/deviceAuth.js';
import { buildGrokProvider, normalizeGrokBilling, type ProviderUsage } from './contract.js';

/**
 * On-demand Grok SuperGrok credit usage. The official CLI's TUI `/usage`
 * hits this same REST path; `grok agent stdio` still has no `x.ai/billing`
 * method (verified 2026-08-12 on grok 1.0.3). Dollar `/v1/billing` is zeros
 * on a subscription and is not used here.
 */

const BILLING_URL = 'https://cli-chat-proxy.grok.com/v1/billing?format=credits';
const CACHE_TTL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
const SUPERGROK_PREFIX = 'https://auth.x.ai::';
const LEGACY_SIGNIN = 'https://accounts.x.ai/sign-in';
const RECONNECT_ERROR = 'Grok sign-in expired. Reconnect it in Settings → Providers.';

export interface GrokAuthSnapshot {
  connected: boolean;
  account: GrokAccount | null;
  parsed: unknown | null;
}

export interface GrokUsageReaderOptions {
  getAuth?: () => GrokAuthSnapshot;
  fetchImpl?: typeof fetch;
  now?: () => number;
  cacheTtlMs?: number;
  requestTimeoutMs?: number;
  log?: Pick<Console, 'warn' | 'error'>;
}

export interface GrokUsageReader {
  read(refresh?: boolean): Promise<ProviderUsage>;
}

function defaultGetAuth(): GrokAuthSnapshot {
  const file = path.join(process.env.GROK_HOME || proGrokHome(), 'auth.json');
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return { connected: false, account: null, parsed: null };
  }
  const probe = readGrokAuth(() => raw);
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  return { connected: probe.connected, account: probe.account, parsed };
}

function isBillingEntry(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const key = (value as { key?: unknown }).key;
  return typeof key === 'string' && key.trim().length > 0;
}

/** Prefer SuperGrok OIDC (`https://auth.x.ai::<client>`), then the legacy sign-in scope. */
export function pickGrokBillingEntry(auth: unknown): Record<string, unknown> | null {
  if (!auth || typeof auth !== 'object' || Array.isArray(auth)) return null;
  const obj = auth as Record<string, unknown>;
  const entries = Object.entries(obj);
  const preferred = entries.find(([name, value]) => name.startsWith(SUPERGROK_PREFIX) && isBillingEntry(value));
  if (preferred) return preferred[1] as Record<string, unknown>;
  if (isBillingEntry(obj[LEGACY_SIGNIN])) return obj[LEGACY_SIGNIN] as Record<string, unknown>;
  const first = entries.find(([, value]) => isBillingEntry(value));
  return first ? (first[1] as Record<string, unknown>) : null;
}

export function grokTokenExpiryMs(entry: Record<string, unknown>): number | null {
  const raw = entry.expires_at;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

const PLAN_KEYS = ['plan', 'plan_type', 'subscription', 'subscription_tier'] as const;

export function grokPlanTypeFromEntry(entry: Record<string, unknown>, account: GrokAccount | null): string | null {
  for (const key of PLAN_KEYS) {
    const value = entry[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  // Numeric JWT `tier` is not a display name — do not invent "SuperGrok Heavy".
  if (typeof entry.tier === 'string' && entry.tier.trim() && !/^\d+$/.test(entry.tier.trim())) {
    return entry.tier.trim();
  }
  return account?.plan ?? null;
}

function redactUsageError(message: string): string {
  return message
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, '[redacted]');
}

export function createGrokUsageReader(opts: GrokUsageReaderOptions = {}): GrokUsageReader {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  const cacheTtl = opts.cacheTtlMs ?? CACHE_TTL_MS;
  const timeout = opts.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const getAuth = opts.getAuth ?? defaultGetAuth;
  const log = opts.log ?? console;
  let cache: { at: number; value: ProviderUsage } | null = null;

  async function load(): Promise<ProviderUsage> {
    const auth = getAuth();
    if (!auth.connected) {
      return buildGrokProvider(null, false, null, null, null);
    }
    const entry = pickGrokBillingEntry(auth.parsed);
    const planType = entry ? grokPlanTypeFromEntry(entry, auth.account) : (auth.account?.plan ?? null);
    if (!entry) {
      return buildGrokProvider(null, true, planType, null, RECONNECT_ERROR);
    }
    const expiresAt = grokTokenExpiryMs(entry);
    if (expiresAt != null && expiresAt <= now()) {
      return buildGrokProvider(null, true, planType, null, RECONNECT_ERROR);
    }
    const token = String(entry.key).trim();
    const capturedAt = new Date(now()).toISOString();
    try {
      const res = await fetchImpl(BILLING_URL, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          'x-grok-client-mode': 'cli',
          'x-xai-token-auth': 'xai-grok-cli',
        },
        signal: AbortSignal.timeout(timeout),
      });
      if (res.status === 401) return buildGrokProvider(null, true, planType, capturedAt, RECONNECT_ERROR);
      if (res.status === 403) {
        return buildGrokProvider(null, true, planType, capturedAt, 'Grok team usage is unavailable.');
      }
      if (!res.ok) {
        return buildGrokProvider(null, true, planType, capturedAt, `Grok usage is unavailable (${res.status}).`);
      }
      const body: unknown = await res.json().catch(() => null);
      return buildGrokProvider(normalizeGrokBilling(body), true, planType, capturedAt, null);
    } catch (err) {
      log.warn(`[usage] grok billing failed: ${redactUsageError((err as Error).message)}`);
      return buildGrokProvider(null, true, planType, capturedAt, 'Grok usage is unavailable.');
    }
  }

  return {
    async read(refresh = false) {
      if (!refresh && cache && now() - cache.at < cacheTtl) return cache.value;
      const value = await load();
      cache = { at: now(), value };
      return value;
    },
  };
}
