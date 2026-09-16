import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createSecretStore } from '../src/secrets/store.js';
import { effectiveApiKey, apiKeyStatuses, keyHint } from '../src/secrets/apiKeys.js';
import type { Config } from '../src/config.js';
import type { DopplerRuntime } from '../src/secrets/doppler.js';

const dirs: string[] = [];
function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-apikeys-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

// Only the fields the resolver reads matter here.
function cfg(over: Partial<Config> = {}): Config {
  return { openRouterApiKey: null, sonioxApiKey: null, ...over } as Config;
}

describe('API key override/default resolution', () => {
  it('uses the env/Doppler default when no override is stored', () => {
    const store = createSecretStore(tmpDir(), {});
    const r = effectiveApiKey('openrouter', store, cfg({ openRouterApiKey: 'sk-or-default' }));
    expect(r).toEqual({ value: 'sk-or-default', source: 'default' });
  });

  it('prefers a stored override over the default', () => {
    const store = createSecretStore(tmpDir(), {});
    store.setApiKeyOverride('openrouter', '  sk-or-custom  ');
    const r = effectiveApiKey('openrouter', store, cfg({ openRouterApiKey: 'sk-or-default' }));
    expect(r).toEqual({ value: 'sk-or-custom', source: 'override' });
  });

  it('uses client Doppler ahead of the legacy environment and below a local override', () => {
    const store = createSecretStore(tmpDir(), {});
    const doppler = {
      get: (name: string) => (name === 'OPENROUTER_API_KEY' ? 'sk-or-client-doppler' : null),
    } as DopplerRuntime;
    expect(effectiveApiKey('openrouter', store, cfg({ openRouterApiKey: 'sk-or-legacy' }), doppler)).toEqual({
      value: 'sk-or-client-doppler',
      source: 'doppler',
    });
    store.setApiKeyOverride('openrouter', 'sk-or-local');
    expect(effectiveApiKey('openrouter', store, cfg({ openRouterApiKey: 'sk-or-legacy' }), doppler)).toEqual({
      value: 'sk-or-local',
      source: 'override',
    });
  });

  it('reports no source when neither override nor default exists', () => {
    const store = createSecretStore(tmpDir(), {});
    expect(effectiveApiKey('openrouter', store, cfg())).toEqual({ value: null, source: null });
  });

  it('resolves the Soniox Doppler default and a saved override', () => {
    const store = createSecretStore(tmpDir(), {});
    expect(effectiveApiKey('soniox', store, cfg({ sonioxApiKey: 'soniox-default' }))).toEqual({
      value: 'soniox-default',
      source: 'default',
    });
    store.setApiKeyOverride('soniox', 'soniox-custom');
    expect(effectiveApiKey('soniox', store, cfg({ sonioxApiKey: 'soniox-default' }))).toEqual({
      value: 'soniox-custom',
      source: 'override',
    });
    store.setApiKeyOverride('soniox', '');
    expect(effectiveApiKey('soniox', store, cfg({ sonioxApiKey: 'soniox-default' }))).toEqual({
      value: 'soniox-default',
      source: 'default',
    });
  });

  it.each(['fishaudio', 'anthropic'])('ignores a stale override for retired key %s', (id) => {
    const dir = tmpDir();
    const store = createSecretStore(dir, {});
    store.setApiKeyOverride(id, 'retired-key-leftover');
    expect(store.getApiKeyOverride('soniox')).toBeNull();
    const statuses = apiKeyStatuses(store, cfg());
    expect(statuses.map((s) => s.id)).not.toContain(id);
    expect(JSON.stringify(statuses)).not.toContain('retired-key-leftover');
  });

  it('overrides persist to disk and survive a fresh store handle', () => {
    const dir = tmpDir();
    createSecretStore(dir, {}).setApiKeyOverride('openrouter', 'sk-or-custom');
    expect(createSecretStore(dir, {}).getApiKeyOverride('openrouter')).toBe('sk-or-custom');
  });

  it('setting one key does not disturb another or the Claude token', () => {
    const store = createSecretStore(tmpDir(), {});
    store.addClaudeAccount({ token: 'sk-ant-oat01-abc' });
    store.setApiKeyOverride('openrouter', 'sk-or-1');
    store.setApiKeyOverride('soniox', 'soniox-1');
    store.clearApiKeyOverride('openrouter');
    expect(store.getApiKeyOverride('openrouter')).toBeNull();
    expect(store.getApiKeyOverride('soniox')).toBe('soniox-1');
    expect(store.getClaudeToken()).toBe('sk-ant-oat01-abc');
  });

  it('status masks to a last-4 hint and never leaks the full key', () => {
    const store = createSecretStore(tmpDir(), {});
    store.setApiKeyOverride('openrouter', 'sk-or-supersecret9999');
    const statuses = apiKeyStatuses(store, cfg({ sonioxApiKey: 'soniox-default-1234' }));
    const or = statuses.find((s) => s.id === 'openrouter')!;
    expect(or).toMatchObject({ configured: true, source: 'override', hint: '…9999' });
    const serialized = JSON.stringify(statuses);
    expect(serialized).not.toContain('supersecret');
  });

  it('keyHint returns null for short/blank values', () => {
    expect(keyHint(null)).toBeNull();
    expect(keyHint('short')).toBeNull();
    expect(keyHint('longenoughkey')).toBe('…hkey');
  });
});
