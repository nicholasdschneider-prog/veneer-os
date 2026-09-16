import type { ModelOption, ModelPrefs } from './api';
import { effortOptionsFor, isProvider, PROVIDERS, type Provider } from './modelLabel';

interface NewChatModelChoice {
  provider: Provider;
  model: string;
  efforts?: string[] | null;
}

export interface NewChatAgentPick {
  provider: Provider;
  model: string;
  effort: string;
}

export type ModelCatalogs = Record<Provider, ModelOption[]>;

export function emptyModelCatalogs(): ModelCatalogs {
  return { claude: [], openrouter: [], codex: [], grok: [] };
}

/**
 * Make the fallback catalog available synchronously, then fill providers in
 * independently. A provider that hangs can no longer hold the whole picker in
 * its loading state.
 */
export function loadModelCatalogsProgressively(
  load: (provider: Provider) => Promise<ModelOption[]>,
  onUpdate: (catalogs: ModelCatalogs, settledProvider: Provider | null) => void,
): () => void {
  let active = true;
  let catalogs = emptyModelCatalogs();
  onUpdate(catalogs, null);

  for (const provider of PROVIDERS) {
    void load(provider)
      .catch(() => [] as ModelOption[])
      .then((models) => {
        if (!active) return;
        catalogs = { ...catalogs, [provider]: models };
        onUpdate(catalogs, provider);
      });
  }

  return () => {
    active = false;
  };
}

// Agent model and thinking overrides belong to the provider saved with them.
// When New chat forces the global provider, do not carry incompatible agent
// defaults across providers just because both providers share an effort name.
export function resolveAgentPick(
  slug: string,
  prefs: ModelPrefs | null,
  choices: NewChatModelChoice[] | null,
  preferGlobalProvider = false,
): NewChatAgentPick {
  const override = prefs?.agents?.[slug];
  const globalProvider: Provider = prefs && isProvider(prefs.defaultProvider) ? prefs.defaultProvider : 'claude';
  const overrideProvider = override?.provider && isProvider(override.provider) ? override.provider : null;
  const provider = preferGlobalProvider ? globalProvider : (overrideProvider ?? globalProvider);
  const agentDefaultsApply = !overrideProvider || overrideProvider === provider;

  let model = agentDefaultsApply ? (override?.model ?? '') : '';
  if (model && choices && !choices.some((choice) => choice.provider === provider && choice.model === model)) model = '';

  const effortPref = (agentDefaultsApply ? override?.effort : null) ?? prefs?.defaultEffort ?? '';
  const picked = choices?.find((choice) => choice.provider === provider && choice.model === model);
  // Before this provider's catalog arrives, preserve the saved setting. The
  // progressive loader validates it once concrete model metadata is available.
  const effort = choices === null || effortOptionsFor(provider, picked?.efforts).includes(effortPref)
    ? effortPref
    : '';
  return { provider, model, effort };
}

export function resolveAgentPickWithCatalogs(
  slug: string,
  prefs: ModelPrefs | null,
  choices: NewChatModelChoice[] | null,
  loadedProviders: ReadonlySet<Provider>,
  preferGlobalProvider = false,
): NewChatAgentPick {
  const fallback = resolveAgentPick(slug, prefs, null, preferGlobalProvider);
  return loadedProviders.has(fallback.provider)
    ? resolveAgentPick(slug, prefs, choices, preferGlobalProvider)
    : fallback;
}

/** Return a validated saved pick only while the user has left it untouched. */
export function refineAgentPickAfterCatalog(
  slug: string,
  prefs: ModelPrefs | null,
  choices: NewChatModelChoice[],
  loadedProviders: ReadonlySet<Provider>,
  settledProvider: Provider,
  userTouched: boolean,
  preferGlobalProvider = false,
): NewChatAgentPick | null {
  if (userTouched) return null;
  const fallback = resolveAgentPick(slug, prefs, null, preferGlobalProvider);
  if (settledProvider !== fallback.provider) return null;
  return resolveAgentPickWithCatalogs(slug, prefs, choices, loadedProviders, preferGlobalProvider);
}
