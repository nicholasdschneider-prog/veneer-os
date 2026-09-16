import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseWireLine } from '../src/providers/claude/wire.js';
import { widenScopes } from '../src/claude/setupToken.js';
import { createUsageStore } from '../src/usage/store.js';
import {
  createClaudeProbe,
  fetchClaudeOauthProfile,
  fetchClaudeOauthUsage,
  planLabelFromProfile,
  probeClaudeRateLimits,
} from '../src/usage/claudeProbe.js';
import { readNewestSessionRateLimits } from '../src/usage/codex.js';
import {
  buildClaudeProvider,
  codexWindows,
  labelForWindowMinutes,
  normalizeCodexRpc,
  normalizeCodexSession,
} from '../src/usage/contract.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'usage-test-'));
}

// A verbatim rate_limit_event line as captured live (docs/protocol-notes.md).
const CLAUDE_LINE =
  '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed_warning","resetsAt":1783587600,"rateLimitType":"seven_day","utilization":0.83,"isUsingOverage":false,"surpassedThreshold":0.75},"uuid":"u1","session_id":"s1"}';

// Verbatim low-usage event (captured live 2026-07-06): `utilization` is absent
// below the warning threshold — the event must still parse, not get skipped.
const CLAUDE_LINE_NO_UTILIZATION =
  '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1783325400,"rateLimitType":"five_hour","overageStatus":"rejected","overageDisabledReason":"org_level_disabled","isUsingOverage":false},"uuid":"u2","session_id":"s1"}';

describe('claude rate_limit_event wire parsing', () => {
  it('parses a live rate_limit_event line into a typed window', () => {
    const wire = parseWireLine(CLAUDE_LINE);
    expect(wire?.kind).toBe('rate_limit');
    if (wire?.kind !== 'rate_limit') return;
    expect(wire.msg.rate_limit_info.rateLimitType).toBe('seven_day');
    expect(wire.msg.rate_limit_info.utilization).toBeCloseTo(0.83);
    expect(wire.msg.rate_limit_info.resetsAt).toBe(1783587600);
    expect(wire.msg.rate_limit_info.status).toBe('allowed_warning');
  });

  it('parses a low-usage event with no utilization field', () => {
    const wire = parseWireLine(CLAUDE_LINE_NO_UTILIZATION);
    expect(wire?.kind).toBe('rate_limit');
    if (wire?.kind !== 'rate_limit') return;
    expect(wire.msg.rate_limit_info.rateLimitType).toBe('five_hour');
    expect(wire.msg.rate_limit_info.utilization).toBeUndefined();
  });

  it('skips a malformed/empty rate_limit_event rather than surfacing it', () => {
    // Missing rateLimitType/utilization → schema fails → skip (as it was before).
    expect(parseWireLine('{"type":"rate_limit_event","rate_limit_info":{}}')).toEqual({
      kind: 'skip',
      type: 'rate_limit_event',
    });
  });
});

// Store tests need resets in the future — the store drops snapshots whose
// window has already reset (that was the frozen-meter bug, 2026-07-20).
const FUTURE_RESET = Math.floor(Date.now() / 1000) + 3600;
const LATER_RESET = FUTURE_RESET + 86400;
const FUTURE_RESET_LATE = FUTURE_RESET + 7 * 86400;

describe('usage store — merge + persistence', () => {
  it('keeps the latest snapshot per rateLimitType and survives a reload', () => {
    const dir = tmpDir();
    const store = createUsageStore(dir);
    const info = (type: string, util: number) => ({ rateLimitType: type, utilization: util, resetsAt: FUTURE_RESET });

    store.recordClaude(info('seven_day', 0.5), 'stream');
    store.recordClaude(info('five_hour', 0.2), 'stream');
    // A newer seven_day event replaces the older one (per-type latest wins).
    store.recordClaude(info('seven_day', 0.83), 'stream');

    const snaps = store.claudeSnapshots();
    expect(snaps).toHaveLength(2);
    expect(snaps.find((s) => s.rateLimitType === 'seven_day')?.utilization).toBe(0.83);

    // usage.json was written; a fresh store instance rehydrates the same state.
    expect(fs.existsSync(path.join(dir, 'usage.json'))).toBe(true);
    const reloaded = createUsageStore(dir);
    const rs = reloaded.claudeSnapshots();
    expect(rs).toHaveLength(2);
    expect(rs.find((s) => s.rateLimitType === 'five_hour')?.utilization).toBe(0.2);
  });

  it('notifies once per stored snapshot so the nav rings can refresh live', () => {
    const seen: string[] = [];
    const store = createUsageStore(tmpDir(), { onRecord: () => seen.push('changed') });

    store.recordClaude({ rateLimitType: 'five_hour', utilization: 0.2, resetsAt: FUTURE_RESET }, 'stream');
    expect(seen).toHaveLength(1);
    // A probe write counts too — Codex-style re-probes must move the ring.
    store.recordClaudeFor('other', { rateLimitType: 'five_hour', utilization: 0.4, resetsAt: FUTURE_RESET }, 'probe');
    expect(seen).toHaveLength(2);
    // Nothing was stored (no utilization), so nothing is announced.
    store.recordClaude({ rateLimitType: 'five_hour', resetsAt: LATER_RESET }, 'stream');
    expect(seen).toHaveLength(2);
  });

  it('keeps the write even when the change listener throws', () => {
    const store = createUsageStore(tmpDir(), {
      onRecord: () => {
        throw new Error('listener exploded');
      },
    });

    expect(() =>
      store.recordClaude({ rateLimitType: 'five_hour', utilization: 0.2, resetsAt: FUTURE_RESET }, 'stream'),
    ).not.toThrow();
    expect(store.claudeSnapshots()).toHaveLength(1);
  });

  it('ignores events with no utilization instead of blanking a snapshot', () => {
    const store = createUsageStore(tmpDir());
    store.recordClaude({ rateLimitType: 'five_hour', utilization: 0.2, resetsAt: FUTURE_RESET }, 'probe');
    store.recordClaude({ rateLimitType: 'five_hour', resetsAt: LATER_RESET }, 'stream');
    expect(store.claudeSnapshots()).toHaveLength(1);
    expect(store.claudeSnapshots()[0]?.utilization).toBe(0.2);
  });

  it('rejects the retired overage window without replacing the real Fable window', () => {
    const dir = tmpDir();
    const store = createUsageStore(dir);
    store.recordClaude(
      { rateLimitType: 'seven_day_fable', utilization: 0.06, resetsAt: FUTURE_RESET },
      'oauth',
    );
    store.recordClaude(
      { rateLimitType: 'seven_day_overage_included', utilization: 0.8, resetsAt: LATER_RESET },
      'stream',
    );

    expect(store.claudeSnapshots().map((s) => s.rateLimitType)).toEqual(['seven_day_fable']);
    const persisted = JSON.parse(fs.readFileSync(path.join(dir, 'usage.json'), 'utf8')) as {
      claude: { accounts: Record<string, { snapshots: Record<string, unknown> }> };
    };
    expect(persisted.claude.accounts.primary!.snapshots).not.toHaveProperty('seven_day_overage_included');
  });

  it('purges a persisted retired overage window while keeping the real Fable window', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'usage.json');
    const snapshot = (rateLimitType: string, utilization: number, source: 'stream' | 'oauth') => ({
      rateLimitType,
      utilization,
      resetsAt: LATER_RESET,
      status: null,
      source,
      capturedAt: new Date().toISOString(),
    });
    fs.writeFileSync(
      file,
      JSON.stringify({
        claude: {
          snapshots: {
            seven_day_fable: snapshot('seven_day_fable', 0.06, 'oauth'),
            seven_day_overage_included: snapshot('seven_day_overage_included', 0.8, 'stream'),
          },
          planType: 'max',
        },
      }),
    );

    const store = createUsageStore(dir);
    expect(store.claudeSnapshots().map((s) => s.rateLimitType)).toEqual(['seven_day_fable']);
    expect(store.claudePlanType()).toBe('max');
    const persisted = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      claude: { accounts: Record<string, { snapshots: Record<string, unknown> }> };
    };
    expect(persisted.claude.accounts.primary!.snapshots).not.toHaveProperty('seven_day_overage_included');
  });

  it('files a stream weekly whose reset disagrees with the probed overall weekly under seven_day_fable', () => {
    const store = createUsageStore(tmpDir());
    // Probe anchors the overall weekly; a Fable turn's binding weekly claim
    // arrives typed plain "seven_day" but resets a day later.
    store.recordClaude({ rateLimitType: 'seven_day', utilization: 0.19, resetsAt: FUTURE_RESET }, 'probe');
    store.recordClaude({ rateLimitType: 'seven_day', utilization: 0.84, resetsAt: LATER_RESET }, 'stream');

    const snaps = store.claudeSnapshots();
    expect(snaps.find((s) => s.rateLimitType === 'seven_day')?.utilization).toBe(0.19);
    expect(snaps.find((s) => s.rateLimitType === 'seven_day_fable')?.utilization).toBe(0.84);

    // A stream event matching the probe's reset is the overall weekly — updates in place.
    store.recordClaude({ rateLimitType: 'seven_day', utilization: 0.21, resetsAt: FUTURE_RESET }, 'stream');
    expect(store.claudeSnapshots().find((s) => s.rateLimitType === 'seven_day')?.utilization).toBe(0.21);
  });

  it('migrates a pre-probe stream weekly to the fable slot when the first probe disagrees on reset', () => {
    const store = createUsageStore(tmpDir());
    store.recordClaude({ rateLimitType: 'seven_day', utilization: 0.84, resetsAt: LATER_RESET }, 'stream');
    store.recordClaude({ rateLimitType: 'seven_day', utilization: 0.19, resetsAt: FUTURE_RESET }, 'probe');

    const snaps = store.claudeSnapshots();
    expect(snaps.find((s) => s.rateLimitType === 'seven_day')?.utilization).toBe(0.19);
    expect(snaps.find((s) => s.rateLimitType === 'seven_day_fable')?.utilization).toBe(0.84);
  });
});

describe('usage store — expiry of reset windows', () => {
  const PAST_RESET = Math.floor(Date.now() / 1000) - 3600;

  it('drops a snapshot once its window has reset, and keeps unexpired ones', () => {
    const store = createUsageStore(tmpDir());
    store.recordClaude({ rateLimitType: 'five_hour', utilization: 0.2, resetsAt: FUTURE_RESET }, 'probe');
    // The frozen-meter bug: a stream-only Fable weekly whose reset has passed
    // must not linger at its old percentage.
    store.recordClaude({ rateLimitType: 'seven_day_fable', utilization: 0.77, resetsAt: PAST_RESET }, 'stream');

    const snaps = store.claudeSnapshots();
    expect(snaps.map((s) => s.rateLimitType)).toEqual(['five_hour']);
  });

  it('purges expired snapshots from disk on reload', () => {
    const dir = tmpDir();
    const store = createUsageStore(dir);
    store.recordClaude({ rateLimitType: 'seven_day_fable', utilization: 0.77, resetsAt: PAST_RESET }, 'stream');

    const reloaded = createUsageStore(dir);
    expect(reloaded.claudeSnapshots()).toHaveLength(0);
    expect(reloaded.newestClaudeCapturedAtMs()).toBeNull();
  });

  it('keeps a snapshot with no reset time (nothing to judge expiry by)', () => {
    const store = createUsageStore(tmpDir());
    store.recordClaude({ rateLimitType: 'five_hour', utilization: 0.4 }, 'stream');
    expect(store.claudeSnapshots()).toHaveLength(1);
  });

  it('reports no newest capture once every snapshot has expired, so a refresh re-probes', () => {
    const store = createUsageStore(tmpDir());
    store.recordClaude({ rateLimitType: 'five_hour', utilization: 0.2, resetsAt: PAST_RESET }, 'probe');
    expect(store.newestClaudeCapturedAtMs()).toBeNull();
  });
});

describe('label derivation', () => {
  it('maps the known window lengths and falls back sensibly', () => {
    expect(labelForWindowMinutes(300)).toBe('5-hour');
    expect(labelForWindowMinutes(10080)).toBe('Weekly');
    expect(labelForWindowMinutes(60)).toBe('1-hour');
    expect(labelForWindowMinutes(1440)).toBe('1-day');
    expect(labelForWindowMinutes(null)).toBeNull();
  });
});

describe('buildClaudeProvider — snapshots → contract', () => {
  it('rounds utilization, sorts short-first, and reports newest capture/source', () => {
    const dir = tmpDir();
    const store = createUsageStore(dir);
    store.recordClaude({ rateLimitType: 'seven_day', utilization: 0.83, resetsAt: LATER_RESET }, 'stream');
    store.recordClaude({ rateLimitType: 'five_hour', utilization: 0.2, resetsAt: FUTURE_RESET }, 'probe');

    const provider = buildClaudeProvider(store.claudeSnapshots(), true);
    expect(provider.connected).toBe(true);
    expect(provider.planType).toBeNull();
    // five_hour (300) sorts before seven_day (10080).
    expect(provider.windows.map((w) => w.id)).toEqual(['five_hour', 'seven_day']);
    const weekly = provider.windows.find((w) => w.id === 'seven_day')!;
    expect(weekly.label).toBe('Weekly (all models)');
    expect(weekly.usedPercent).toBe(83);
    expect(weekly.windowMinutes).toBe(10080);
    expect(weekly.resetsAt).toBe(new Date(LATER_RESET * 1000).toISOString());
    expect(weekly.status).toBeNull();
    // Newest snapshot drives capturedAt/source (the probe one, recorded last).
    expect(provider.source).toBe('probe');
    expect(provider.capturedAt).not.toBeNull();
  });

  it('reports connected with an empty windows array when no snapshots exist', () => {
    const provider = buildClaudeProvider([], true);
    expect(provider).toMatchObject({ connected: true, windows: [], capturedAt: null, source: null });
  });

  it('labels the two weeklies apart and sorts them deterministically', () => {
    const dir = tmpDir();
    const store = createUsageStore(dir);
    store.recordClaude({ rateLimitType: 'five_hour', utilization: 0.09, resetsAt: FUTURE_RESET }, 'probe');
    store.recordClaude({ rateLimitType: 'seven_day', utilization: 0.19, resetsAt: FUTURE_RESET }, 'probe');
    store.recordClaude({ rateLimitType: 'seven_day', utilization: 0.84, resetsAt: LATER_RESET }, 'stream');

    const provider = buildClaudeProvider(store.claudeSnapshots(), true);
    expect(provider.windows.map((w) => [w.id, w.label])).toEqual([
      ['five_hour', '5-hour'],
      ['seven_day', 'Weekly (all models)'],
      ['seven_day_fable', 'Weekly (Fable)'],
    ]);
    expect(provider.windows[2]!.windowMinutes).toBe(10080);
  });
});

describe('claude header probe', () => {
  // Header names/values verbatim from a live /v1/messages response (2026-07-06).
  const LIVE_HEADERS: Record<string, string> = {
    'anthropic-ratelimit-unified-status': 'allowed',
    'anthropic-ratelimit-unified-5h-status': 'allowed',
    'anthropic-ratelimit-unified-5h-reset': '1783325400',
    'anthropic-ratelimit-unified-5h-utilization': '0.09',
    'anthropic-ratelimit-unified-7d-status': 'allowed',
    'anthropic-ratelimit-unified-7d-reset': '1783490400',
    'anthropic-ratelimit-unified-7d-utilization': '0.19',
    'anthropic-ratelimit-unified-representative-claim': 'five_hour',
  };
  const fakeFetch = (status: number, headers: Record<string, string>): typeof fetch =>
    (() => Promise.resolve(new Response('{}', { status, headers }))) as typeof fetch;

  it('parses both windows out of the unified rate-limit headers', async () => {
    const infos = await probeClaudeRateLimits('tok', fakeFetch(200, LIVE_HEADERS));
    expect(infos).toEqual([
      { rateLimitType: 'five_hour', utilization: 0.09, resetsAt: 1783325400, status: 'allowed' },
      { rateLimitType: 'seven_day', utilization: 0.19, resetsAt: 1783490400, status: 'allowed' },
    ]);
  });

  it('still captures windows off an error response that carries the headers (429)', async () => {
    const infos = await probeClaudeRateLimits('tok', fakeFetch(429, LIVE_HEADERS));
    expect(infos).toHaveLength(2);
  });

  it('throws on an error response with no telemetry', async () => {
    await expect(probeClaudeRateLimits('tok', fakeFetch(500, {}))).rejects.toThrow('HTTP 500');
  });
});

describe('claude oauth usage endpoint', () => {
  // Shape derived from Claude Code 2.1.200's bundled /usage renderer
  // (rate_limits.{five_hour,seven_day,seven_day_sonnet} + limits[] with
  // kind "weekly_scoped"; percents are whole numbers).
  const OAUTH_BODY = {
    rate_limits: {
      five_hour: { utilization: 36, resets_at: FUTURE_RESET_LATE },
      seven_day: { utilization: 4, resets_at: FUTURE_RESET_LATE },
      limits: [
        {
          kind: 'weekly_scoped',
          scope: { model: { display_name: 'Fable 5' } },
          percent: 7,
          resets_at: FUTURE_RESET_LATE,
        },
        { kind: 'session', percent: 36, resets_at: FUTURE_RESET_LATE },
      ],
    },
    subscription_type: 'max',
    juniper_tide: {
      eligible: true,
      arm: 'reset',
      available: true,
      next_available_at: '2026-09-10T17:00:00Z',
      weekly_resets_at: '2026-09-08T12:00:00Z',
      resets_per_week: 1,
    },
  };
  const jsonFetch = (status: number, body: unknown): typeof fetch =>
    (() => Promise.resolve(new Response(JSON.stringify(body), { status }))) as typeof fetch;

  it('normalizes named windows, scoped weeklies, and the plan name', async () => {
    const result = await fetchClaudeOauthUsage('tok', jsonFetch(200, OAUTH_BODY));
    expect(result).not.toBeNull();
    expect(result!.planType).toBe('max');
    expect(result!.limitReset).toMatchObject({
      available: true,
      nextAvailableAt: '2026-09-10T17:00:00Z',
      resetsPerWeek: 1,
    });
    expect(result!.infos).toEqual([
      { rateLimitType: 'five_hour', utilization: 0.36, resetsAt: FUTURE_RESET_LATE },
      { rateLimitType: 'seven_day', utilization: 0.04, resetsAt: FUTURE_RESET_LATE },
      {
        rateLimitType: 'seven_day_fable_5',
        utilization: 0.07,
        resetsAt: FUTURE_RESET_LATE,
        label: 'Weekly (Fable 5)',
      },
    ]);
  });

  it('parses the mid-2026 flat shape (no rate_limits wrapper, no subscription_type)', async () => {
    // Real captured body structure, 2026-07-23: windows at the top level,
    // null model-scoped slots, ISO resets_at, extra non-window keys.
    const iso = new Date(FUTURE_RESET_LATE * 1000).toISOString();
    const FLAT_BODY = {
      five_hour: { utilization: 17, resets_at: iso, limit_dollars: null },
      seven_day: { utilization: 5, resets_at: iso, limit_dollars: null },
      seven_day_sonnet: null,
      seven_day_opus: null,
      extra_usage: { is_enabled: false },
      limits: [
        { kind: 'session', group: 'session', percent: 17, resets_at: iso, scope: null },
        { kind: 'weekly_all', group: 'weekly', percent: 5, resets_at: iso, scope: null },
        {
          kind: 'weekly_scoped',
          group: 'weekly',
          percent: 7,
          resets_at: iso,
          scope: { model: { id: null, display_name: 'Fable' }, surface: null },
        },
      ],
    };
    const result = await fetchClaudeOauthUsage('tok', jsonFetch(200, FLAT_BODY));
    expect(result).not.toBeNull();
    expect(result!.planType).toBeNull();
    expect(result!.infos).toEqual([
      { rateLimitType: 'five_hour', utilization: 0.17, resetsAt: FUTURE_RESET_LATE },
      { rateLimitType: 'seven_day', utilization: 0.05, resetsAt: FUTURE_RESET_LATE },
      {
        rateLimitType: 'seven_day_fable',
        utilization: 0.07,
        resetsAt: FUTURE_RESET_LATE,
        label: 'Weekly (Fable)',
      },
    ]);
  });

  it('returns null on 403 (token without user:profile) so the caller can fall back', async () => {
    expect(await fetchClaudeOauthUsage('tok', jsonFetch(403, { error: 'scope' }))).toBeNull();
  });

  it('throws on other failures and on an empty/unrecognized body', async () => {
    await expect(fetchClaudeOauthUsage('tok', jsonFetch(500, {}))).rejects.toThrow('HTTP 500');
    await expect(fetchClaudeOauthUsage('tok', jsonFetch(200, {}))).rejects.toThrow('no recognizable windows');
  });

  it('accepts ISO resets_at strings', async () => {
    const iso = new Date(FUTURE_RESET_LATE * 1000).toISOString();
    const result = await fetchClaudeOauthUsage(
      'tok',
      jsonFetch(200, { rate_limits: { five_hour: { utilization: 12, resets_at: iso } } }),
    );
    expect(result!.infos[0]).toMatchObject({ rateLimitType: 'five_hour', resetsAt: FUTURE_RESET_LATE });
  });
});

describe('claude probe — oauth-first with header fallback', () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it('records oauth windows + plan and skips the header probe when oauth works', async () => {
    const store = createUsageStore(tmpDir());
    let probed = 0;
    const probe = createClaudeProbe({
      store,
      getToken: () => 'tok',
      oauthUsage: () =>
        Promise.resolve({
          infos: [
            { rateLimitType: 'seven_day_fable_5', utilization: 0.07, resetsAt: FUTURE_RESET, label: 'Weekly (Fable 5)' },
          ],
          planType: 'max',
        }),
      probe: () => {
        probed++;
        return Promise.resolve([]);
      },
    });
    const result = await probe.refreshIfStale(0);
    await flush();
    expect(result).toEqual({ probed: true, captured: 1, error: null });
    expect(probed).toBe(0);
    expect(store.claudePlanType()).toBe('max');
    const snap = store.claudeSnapshots()[0]!;
    expect(snap).toMatchObject({ rateLimitType: 'seven_day_fable_5', source: 'oauth', label: 'Weekly (Fable 5)' });
  });

  it('falls back to the header probe when the token lacks the scope (null)', async () => {
    const store = createUsageStore(tmpDir());
    const probe = createClaudeProbe({
      store,
      getToken: () => 'tok',
      oauthUsage: () => Promise.resolve(null),
      probe: () => Promise.resolve([{ rateLimitType: 'five_hour', utilization: 0.2, resetsAt: FUTURE_RESET }]),
    });
    const result = await probe.refreshIfStale(0);
    expect(result).toEqual({ probed: true, captured: 1, error: null });
    expect(store.claudeSnapshots()[0]).toMatchObject({ rateLimitType: 'five_hour', source: 'probe' });
  });

  it('falls back to the header probe when the oauth fetch throws', async () => {
    const store = createUsageStore(tmpDir());
    const probe = createClaudeProbe({
      store,
      getToken: () => 'tok',
      oauthUsage: () => Promise.reject(new Error('boom')),
      probe: () => Promise.resolve([{ rateLimitType: 'five_hour', utilization: 0.2, resetsAt: FUTURE_RESET }]),
      log: { warn: () => undefined, error: () => undefined },
    });
    const result = await probe.refreshIfStale(0);
    expect(result).toEqual({ probed: true, captured: 1, error: null });
  });
});

describe('claude oauth profile — account identity', () => {
  it('derives a tiered plan label from the org rate-limit tier', () => {
    expect(planLabelFromProfile('default_claude_max_20x', 'claude_max')).toBe('Max 20x');
    expect(planLabelFromProfile(null, 'claude_pro')).toBe('Pro');
    expect(planLabelFromProfile('weird_tier', 'something_else')).toBe('something_else');
    expect(planLabelFromProfile(null, null)).toBeNull();
  });

  it('parses the live profile shape and returns null on 403', async () => {
    const body = {
      account: { email: 'owner@example.ai', created_at: '2026-08-25T21:14:16Z' },
      organization: { organization_type: 'claude_max', rate_limit_tier: 'default_claude_max_20x' },
    };
    const ok = (() => Promise.resolve(new Response(JSON.stringify(body), { status: 200 }))) as unknown as typeof fetch;
    expect(await fetchClaudeOauthProfile('tok', ok)).toEqual({ email: 'owner@example.ai', planType: 'Max 20x' });
    const forbidden = (() => Promise.resolve(new Response('', { status: 403 }))) as unknown as typeof fetch;
    expect(await fetchClaudeOauthProfile('tok', forbidden)).toBeNull();
  });

  it('records the account email + tiered plan, and survives a profile failure', async () => {
    const store = createUsageStore(tmpDir());
    const usage = () =>
      Promise.resolve({
        infos: [{ rateLimitType: 'five_hour', utilization: 0.2, resetsAt: FUTURE_RESET }],
        planType: 'max',
      });
    const probe = createClaudeProbe({
      store,
      getToken: () => 'tok',
      oauthProfile: () => Promise.resolve({ email: 'owner@example.ai', planType: 'Max 20x' }),
      oauthUsage: usage,
      probe: () => Promise.resolve([]),
    });
    expect(await probe.refreshIfStale(0)).toEqual({ probed: true, captured: 1, error: null });
    expect(store.claudeAccountEmail()).toBe('owner@example.ai');
    expect(store.claudePlanType()).toBe('Max 20x');

    const broken = createClaudeProbe({
      store: createUsageStore(tmpDir()),
      getToken: () => 'tok',
      oauthProfile: () => Promise.reject(new Error('boom')),
      oauthUsage: usage,
      probe: () => Promise.resolve([]),
      log: { warn: () => undefined, error: () => undefined },
    });
    expect(await broken.refreshIfStale(0)).toEqual({ probed: true, captured: 1, error: null });
  });

  it('drops the old account\'s snapshots when the token switches accounts, and persists the email', () => {
    const dir = tmpDir();
    const store = createUsageStore(dir);
    store.setClaudeAccountEmail('old@example.com');
    store.setClaudePlanType('Max 5x');
    store.recordClaude({ rateLimitType: 'seven_day', utilization: 0.9, resetsAt: FUTURE_RESET }, 'oauth');
    // Same account, or first-ever identity: nothing is cleared.
    store.setClaudeAccountEmail('old@example.com');
    expect(store.claudeSnapshots()).toHaveLength(1);

    store.setClaudeAccountEmail('owner@example.ai');
    expect(store.claudeSnapshots()).toEqual([]);
    expect(store.claudePlanType()).toBeNull();
    expect(createUsageStore(dir).claudeAccountEmail()).toBe('owner@example.ai');
  });

  it('threads accountEmail into the provider contract', () => {
    expect(buildClaudeProvider([], true, 'Max 20x', 'owner@example.ai')).toMatchObject({
      planType: 'Max 20x',
      accountEmail: 'owner@example.ai',
    });
  });
});

describe('setup-token scope widening', () => {
  it('adds user:profile to the CLI authorize URL', () => {
    const url =
      'https://claude.com/cai/oauth/authorize?code=true&client_id=abc&response_type=code&redirect_uri=x&scope=user%3Ainference&code_challenge=y&code_challenge_method=S256&state=z';
    expect(widenScopes(url)).toContain('scope=user%3Ainference%20user%3Aprofile&code_challenge=y');
  });

  it('leaves an unexpected scope shape untouched', () => {
    const url = 'https://claude.com/cai/oauth/authorize?scope=user%3Aother&state=z';
    expect(widenScopes(url)).toBe(url);
  });
});

describe('codex normalization', () => {
  it('normalizes the camelCase RPC response into short-first windows', () => {
    // Shape verified live 2026-07-06 against `account/rateLimits/read`.
    const rateLimits = {
      limitId: 'codex',
      planType: 'pro',
      primary: { usedPercent: 2, windowDurationMins: 300, resetsAt: 1783309206 },
      secondary: { usedPercent: 19, windowDurationMins: 10080, resetsAt: 1783390950 },
    };
    const snap = normalizeCodexRpc(rateLimits);
    expect(snap.planType).toBe('pro');
    const windows = codexWindows(snap);
    expect(windows.map((w) => w.id)).toEqual(['primary', 'secondary']);
    expect(windows[0]).toMatchObject({ id: 'primary', label: '5-hour', usedPercent: 2, windowMinutes: 300, status: null });
    expect(windows[1]).toMatchObject({ id: 'secondary', label: 'Weekly', usedPercent: 19, windowMinutes: 10080 });
    expect(windows[1]!.resetsAt).toBe(new Date(1783390950 * 1000).toISOString());
  });

  it('normalizes the snake_case session-file fallback (and rounds float percents)', () => {
    const rateLimits = {
      plan_type: 'pro',
      primary: { used_percent: 0.0, window_minutes: 300, resets_at: 1783309204 },
      secondary: { used_percent: 19.0, window_minutes: 10080, resets_at: 1783390950 },
    };
    const snap = normalizeCodexSession(rateLimits);
    expect(snap.planType).toBe('pro');
    const windows = codexWindows(snap);
    expect(windows[0]).toMatchObject({ id: 'primary', usedPercent: 0, windowMinutes: 300 });
    expect(windows[1]).toMatchObject({ id: 'secondary', usedPercent: 19, windowMinutes: 10080 });
  });

  it('drops absent buckets (only primary present)', () => {
    const snap = normalizeCodexRpc({ planType: 'pro', primary: { usedPercent: 5, windowDurationMins: 300, resetsAt: 1 } });
    expect(codexWindows(snap).map((w) => w.id)).toEqual(['primary']);
  });
});

describe('codex session-file fallback scan', () => {
  it('finds the newest token_count rate_limits across nested session files', () => {
    const dir = tmpDir();
    const nested = path.join(dir, '2026', '07', '06');
    fs.mkdirSync(nested, { recursive: true });
    const rl = { plan_type: 'pro', primary: { used_percent: 7.0, window_minutes: 300, resets_at: 123 }, secondary: null };
    const lines = [
      JSON.stringify({ payload: { type: 'response_item' } }),
      JSON.stringify({ payload: { type: 'token_count', rate_limits: rl } }),
      JSON.stringify({ payload: { type: 'event_msg' } }),
    ];
    fs.writeFileSync(path.join(nested, 'session.jsonl'), lines.join('\n'));

    const found = readNewestSessionRateLimits(dir) as Record<string, unknown> | null;
    expect(found).not.toBeNull();
    expect(normalizeCodexSession(found).primary?.usedPercent).toBe(7);
  });

  it('returns null when there is no session telemetry', () => {
    expect(readNewestSessionRateLimits(tmpDir())).toBeNull();
  });
});
