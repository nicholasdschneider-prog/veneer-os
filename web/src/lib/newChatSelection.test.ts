import { describe, expect, it } from 'vitest';
import type { ModelPrefs } from './api';
import {
  loadModelCatalogsProgressively,
  refineAgentPickAfterCatalog,
  resolveAgentPick,
  resolveAgentPickWithCatalogs,
} from './newChatSelection';

function prefs(overrides: Partial<ModelPrefs> = {}): ModelPrefs {
  return {
    defaultProvider: 'claude',
    providerDefaults: { claude: 'claude-fable-5', openrouter: null, codex: null, grok: null },
    openrouterModels: [],
    hiddenModels: [],
    modelOrder: {},
    defaultEffort: 'medium',
    defaultAgent: 'platform-dev',
    agents: {
      'platform-dev': { provider: 'codex', model: 'gpt-5.6', effort: 'high' },
    },
    autoTitle: { enabled: true, model: 'z-ai/glm-5.2' },
    ...overrides,
  };
}

const choices = [
  { provider: 'claude' as const, model: '', efforts: ['low', 'medium', 'high'] },
  { provider: 'codex' as const, model: 'gpt-5.6', efforts: ['low', 'medium', 'high', 'xhigh'] },
];

describe('new chat model selection', () => {
  it('does not carry an agent thinking override across providers', () => {
    expect(resolveAgentPick('platform-dev', prefs(), choices, true)).toEqual({
      provider: 'claude',
      model: '',
      effort: 'medium',
    });
  });

  it('keeps the agent model and thinking defaults when its provider is selected', () => {
    expect(resolveAgentPick('platform-dev', prefs(), choices)).toEqual({
      provider: 'codex',
      model: 'gpt-5.6',
      effort: 'high',
    });
  });

  it('keeps an unscoped agent thinking override on the global provider', () => {
    const inheritedProviderPrefs = prefs({
      agents: { 'platform-dev': { provider: null, model: null, effort: 'high' } },
    });

    expect(resolveAgentPick('platform-dev', inheritedProviderPrefs, choices, true).effort).toBe('high');
  });

  it('preserves a saved model and its model-specific effort before the catalog arrives', () => {
    const saved = prefs({
      defaultProvider: 'codex',
      defaultEffort: 'ultra',
      agents: { 'platform-dev': { provider: 'codex', model: 'gpt-5.6-sol', effort: 'ultra' } },
    });

    expect(resolveAgentPickWithCatalogs('platform-dev', saved, null, new Set(), true)).toEqual({
      provider: 'codex',
      model: 'gpt-5.6-sol',
      effort: 'ultra',
    });
  });

  it('reconciles a saved default after that provider catalog arrives', () => {
    const saved = prefs({
      defaultProvider: 'codex',
      agents: { 'platform-dev': { provider: 'codex', model: 'retired-model', effort: 'high' } },
    });

    expect(resolveAgentPickWithCatalogs('platform-dev', saved, choices, new Set(['codex']), true)).toEqual({
      provider: 'codex',
      model: '',
      effort: 'high',
    });
  });

  it('does not let a late catalog replace a choice the user already made', () => {
    const refined = refineAgentPickAfterCatalog(
      'platform-dev',
      prefs({ defaultProvider: 'codex' }),
      choices,
      new Set(['codex']),
      'codex',
      true,
      true,
    );

    expect(refined).toBeNull();
  });
});

describe('progressive new chat model loading', () => {
  it('publishes an immediately usable fallback without waiting for providers', () => {
    const never = new Promise<never>(() => undefined);
    const updates: Array<{ provider: string | null; codex: number }> = [];

    loadModelCatalogsProgressively(
      () => never,
      (catalogs, provider) => updates.push({ provider, codex: catalogs.codex.length }),
    );

    expect(updates).toEqual([{ provider: null, codex: 0 }]);
  });

  it('adds late catalogs independently while another provider remains hung', async () => {
    let resolveCodex!: (models: Array<{ id: string; label: string }>) => void;
    const codex = new Promise<Array<{ id: string; label: string }>>((resolve) => {
      resolveCodex = resolve;
    });
    const never = new Promise<never>(() => undefined);
    const updates: Array<{ provider: string | null; codex: string[] }> = [];

    loadModelCatalogsProgressively(
      (provider) => provider === 'codex' ? codex : never,
      (catalogs, provider) => updates.push({
        provider,
        codex: catalogs.codex.map((model) => model.id),
      }),
    );
    resolveCodex([{ id: 'gpt-5.6', label: 'GPT-5.6' }]);
    await codex;
    await Promise.resolve();

    expect(updates).toEqual([
      { provider: null, codex: [] },
      { provider: 'codex', codex: ['gpt-5.6'] },
    ]);
  });

  it('stops late provider responses from updating an abandoned screen', async () => {
    let resolveCodex!: (models: Array<{ id: string; label: string }>) => void;
    const codex = new Promise<Array<{ id: string; label: string }>>((resolve) => {
      resolveCodex = resolve;
    });
    const updates: Array<string | null> = [];
    const stop = loadModelCatalogsProgressively(
      (provider) => provider === 'codex' ? codex : new Promise<never>(() => undefined),
      (_catalogs, provider) => updates.push(provider),
    );

    stop();
    resolveCodex([{ id: 'gpt-5.6', label: 'GPT-5.6' }]);
    await codex;
    await Promise.resolve();

    expect(updates).toEqual([null]);
  });
});
