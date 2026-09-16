import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createSecretStore, type SecretsFile } from '../src/secrets/store.js';
import { createUsageStore } from '../src/usage/store.js';
import { createClaudeProbe } from '../src/usage/claudeProbe.js';

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const FUTURE_RESET = Math.floor(Date.now() / 1000) + 3600;

describe('secret store — multiple Claude accounts', () => {
  it('migrates a pre-multi-account token into account "primary" without losing it', () => {
    const dir = tmpDir('vp-accounts-');
    fs.writeFileSync(
      path.join(dir, 'secrets.json'),
      JSON.stringify({ claudeOauthToken: 'sk-ant-oat01-OLD', connectedAt: '2026-01-01T00:00:00.000Z' }),
    );
    const store = createSecretStore(dir, {});

    expect(store.getClaudeToken()).toBe('sk-ant-oat01-OLD');
    const accounts = store.listClaudeAccounts();
    expect(accounts).toHaveLength(1);
    // 'primary' is the id usage/store.ts migrates its legacy snapshots to —
    // the existing login must keep both its token AND its meters.
    expect(accounts[0]).toMatchObject({ id: 'primary', active: true, connectedAt: '2026-01-01T00:00:00.000Z' });
    expect(store.status()).toMatchObject({ connected: true, source: 'app' });
    // Never leak the token through the API-facing shape.
    expect(JSON.stringify(accounts)).not.toContain('sk-ant-oat01-OLD');
  });

  it('retires the legacy fields once a second account is added', () => {
    const dir = tmpDir('vp-accounts-');
    const file = path.join(dir, 'secrets.json');
    fs.writeFileSync(file, JSON.stringify({ claudeOauthToken: 'sk-ant-oat01-OLD' }));
    const store = createSecretStore(dir, {});

    store.addClaudeAccount({ token: 'sk-ant-oat01-NEW', email: 'second@example.com' });
    const persisted = JSON.parse(fs.readFileSync(file, 'utf8')) as SecretsFile;
    expect(persisted.claudeOauthToken).toBeUndefined();
    expect(persisted.claudeAccounts).toHaveLength(2);
    // Reloading must not resurrect the legacy token as a third account.
    expect(createSecretStore(dir, {}).listClaudeAccounts()).toHaveLength(2);
  });

  it('activates a newly connected account and switches back on demand', () => {
    const dir = tmpDir('vp-accounts-');
    const store = createSecretStore(dir, {});
    const first = store.addClaudeAccount({ token: 'sk-ant-oat01-A', email: 'a@example.com' });
    const second = store.addClaudeAccount({ token: 'sk-ant-oat01-B', email: 'b@example.com' });

    expect(store.getClaudeToken()).toBe('sk-ant-oat01-B');
    expect(store.activeClaudeAccountId()).toBe(second.id);

    expect(store.setActiveClaudeAccount(first.id)).toBe(true);
    expect(store.getClaudeToken()).toBe('sk-ant-oat01-A');
    expect(store.setActiveClaudeAccount('nope')).toBe(false);
    // Labels default to the account email so two rows are tellable apart.
    expect(store.listClaudeAccounts().map((a) => a.label)).toEqual(['a@example.com', 'b@example.com']);
  });

  it('treats a re-login with the same email as a token refresh, not a duplicate', () => {
    const dir = tmpDir('vp-accounts-');
    const store = createSecretStore(dir, {});
    const first = store.addClaudeAccount({ token: 'sk-ant-oat01-A1', email: 'a@example.com' });
    store.renameClaudeAccount(first.id, 'Work');
    const again = store.addClaudeAccount({ token: 'sk-ant-oat01-A2', email: 'a@example.com' });

    expect(again.id).toBe(first.id);
    expect(store.listClaudeAccounts()).toHaveLength(1);
    expect(store.getClaudeToken()).toBe('sk-ant-oat01-A2');
    // A name the user chose survives the re-login.
    expect(store.listClaudeAccounts()[0]!.label).toBe('Work');
  });

  it('promotes the next account when the active one is removed', () => {
    const dir = tmpDir('vp-accounts-');
    const store = createSecretStore(dir, {});
    const first = store.addClaudeAccount({ token: 'sk-ant-oat01-A', email: 'a@example.com' });
    const second = store.addClaudeAccount({ token: 'sk-ant-oat01-B', email: 'b@example.com' });

    expect(store.removeClaudeAccount(second.id)).toBe(true);
    expect(store.activeClaudeAccountId()).toBe(first.id);
    expect(store.getClaudeToken()).toBe('sk-ant-oat01-A');
    expect(store.removeClaudeAccount(first.id)).toBe(true);
    expect(store.status()).toMatchObject({ connected: false, source: null });
  });

  it('offers the env token as a single pseudo-account when nothing is connected', () => {
    const dir = tmpDir('vp-accounts-');
    const store = createSecretStore(dir, { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-ENV' });
    expect(store.claudeAccountCredentials()).toEqual([{ id: 'env', token: 'sk-ant-oat01-ENV' }]);
    expect(store.activeClaudeAccountId()).toBe('env');

    const added = store.addClaudeAccount({ token: 'sk-ant-oat01-APP' });
    expect(store.claudeAccountCredentials()).toEqual([{ id: added.id, token: 'sk-ant-oat01-APP' }]);
  });
});

describe('usage store — per-account meters', () => {
  it('keeps two accounts’ identical windows apart', () => {
    const dir = tmpDir('vp-usage-');
    let active = 'a';
    const store = createUsageStore(dir, { activeAccountId: () => active });

    store.recordClaude({ rateLimitType: 'five_hour', utilization: 0.94, resetsAt: FUTURE_RESET }, 'probe');
    active = 'b';
    store.recordClaude({ rateLimitType: 'five_hour', utilization: 0.12, resetsAt: FUTURE_RESET }, 'probe');

    expect(store.claudeSnapshotsFor('a')[0]?.utilization).toBe(0.94);
    expect(store.claudeSnapshotsFor('b')[0]?.utilization).toBe(0.12);
    // The unsuffixed read follows the active account.
    expect(store.claudeSnapshots()[0]?.utilization).toBe(0.12);

    const reloaded = createUsageStore(dir, { activeAccountId: () => 'a' });
    expect(reloaded.claudeSnapshots()[0]?.utilization).toBe(0.94);
    expect(reloaded.allClaudeAccounts().map((entry) => entry.accountId).sort()).toEqual(['a', 'b']);
  });

  it('migrates a pre-multi-account usage file into the "primary" account', () => {
    const dir = tmpDir('vp-usage-');
    fs.writeFileSync(
      path.join(dir, 'usage.json'),
      JSON.stringify({
        claude: {
          snapshots: {
            five_hour: {
              rateLimitType: 'five_hour',
              utilization: 0.4,
              resetsAt: FUTURE_RESET,
              status: null,
              source: 'probe',
              capturedAt: new Date().toISOString(),
            },
          },
          planType: 'Max 20x',
          accountEmail: 'owner@example.com',
        },
      }),
    );

    const store = createUsageStore(dir, { activeAccountId: () => 'primary' });
    expect(store.claudeSnapshots()[0]?.utilization).toBe(0.4);
    expect(store.claudePlanType()).toBe('Max 20x');
    expect(store.claudeAccountEmail()).toBe('owner@example.com');
  });

  it('drops meters for accounts that are no longer connected', () => {
    const store = createUsageStore(tmpDir('vp-usage-'), { activeAccountId: () => 'a' });
    store.recordClaudeFor('a', { rateLimitType: 'five_hour', utilization: 0.1, resetsAt: FUTURE_RESET }, 'probe');
    store.recordClaudeFor('gone', { rateLimitType: 'five_hour', utilization: 0.9, resetsAt: FUTURE_RESET }, 'probe');

    store.forgetClaudeAccountsExcept(['a']);
    expect(store.allClaudeAccounts().map((entry) => entry.accountId)).toEqual(['a']);
  });

  it('keeps the weekly reset offer with its own account and persists the cooldown', () => {
    const dir = tmpDir('vp-usage-');
    const store = createUsageStore(dir, { activeAccountId: () => 'a' });
    store.setClaudeLimitResetFor('b', {
      available: false,
      nextAvailableAt: '2026-09-10T17:00:00Z',
      weeklyResetsAt: '2026-09-08T12:00:00Z',
      resetsPerWeek: 1,
      capturedAt: '2026-09-03T17:00:00Z',
    });

    expect(store.claudeLimitReset()).toBeNull();
    expect(store.claudeLimitResetFor('b')?.available).toBe(false);
    expect(createUsageStore(dir, { activeAccountId: () => 'b' }).claudeLimitReset()).toMatchObject({
      available: false,
      nextAvailableAt: '2026-09-10T17:00:00Z',
    });
  });
});

describe('claude probe — every connected account', () => {
  it('meters each account separately and labels them from their profiles', async () => {
    const store = createUsageStore(tmpDir('vp-usage-'), { activeAccountId: () => 'a' });
    const seen: Record<string, string> = {};
    const probe = createClaudeProbe({
      store,
      getAccounts: () => [
        { id: 'a', token: 'tok-a' },
        { id: 'b', token: 'tok-b' },
      ],
      oauthProfile: (token) =>
        Promise.resolve({ email: token === 'tok-a' ? 'a@example.com' : 'b@example.com', planType: 'Max 20x' }),
      oauthUsage: (token) =>
        Promise.resolve({
          infos: [{ rateLimitType: 'five_hour', utilization: token === 'tok-a' ? 0.94 : 0.12, resetsAt: FUTURE_RESET }],
          planType: 'max',
        }),
      probe: () => Promise.resolve([]),
      onProfile: (accountId, profile) => {
        seen[accountId] = profile.email ?? '';
      },
    });

    const result = await probe.refreshIfStale(0);
    expect(result).toEqual({ probed: true, captured: 2, error: null });
    expect(store.claudeSnapshotsFor('a')[0]?.utilization).toBe(0.94);
    expect(store.claudeSnapshotsFor('b')[0]?.utilization).toBe(0.12);
    expect(store.claudeAccountEmailFor('b')).toBe('b@example.com');
    expect(seen).toEqual({ a: 'a@example.com', b: 'b@example.com' });
  });

  it('re-probes a stale account even when the other one is fresh', async () => {
    const store = createUsageStore(tmpDir('vp-usage-'), { activeAccountId: () => 'a' });
    store.recordClaudeFor('a', { rateLimitType: 'five_hour', utilization: 0.5, resetsAt: FUTURE_RESET }, 'probe');
    const probed: string[] = [];
    const probe = createClaudeProbe({
      store,
      getAccounts: () => [
        { id: 'a', token: 'tok-a' },
        { id: 'b', token: 'tok-b' },
      ],
      oauthProfile: () => Promise.resolve(null),
      oauthUsage: () => Promise.resolve(null),
      probe: (token) => {
        probed.push(token);
        return Promise.resolve([{ rateLimitType: 'five_hour', utilization: 0.2, resetsAt: FUTURE_RESET }]);
      },
    });

    // 'a' was just metered; only the never-metered 'b' should hit the network.
    await probe.refreshIfStale(60_000);
    expect(probed).toEqual(['tok-b']);
  });
});
