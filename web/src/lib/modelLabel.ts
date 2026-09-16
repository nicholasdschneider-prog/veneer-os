const PROVIDER_LABEL: Record<string, string> = {
  claude: 'Claude',
  openrouter: 'OpenRouter',
  codex: 'Codex',
  grok: 'Grok',
};

export const PROVIDERS = ['claude', 'openrouter', 'codex', 'grok'] as const;
export type Provider = (typeof PROVIDERS)[number];

export function isProvider(value: string): value is Provider {
  return (PROVIDERS as readonly string[]).includes(value);
}

// Reasoning-effort vocabulary differs per CLI (Claude's `--effort`, Codex's
// `-c model_reasoning_effort`) — never unified, just passed straight through.
// Since GPT-5.6 the vocabulary also differs per MODEL within Codex (Sol/Terra
// add 'max'+'ultra' and drop 'minimal'; Luna has 'max' but not 'ultra'), so
// these static lists are only the fallback when a model doesn't report its own
// set — prefer effortOptionsFor() with the model's live metadata.
export const EFFORT_OPTIONS: Record<Provider, string[]> = {
  claude: ['low', 'medium', 'high', 'xhigh', 'max'],
  openrouter: ['low', 'medium', 'high'],
  codex: ['minimal', 'low', 'medium', 'high', 'xhigh'],
  // Fallback if initialize is empty. Prefer the model's own ACP list
  // (grok-4.6 adds xhigh; grok-4.5 does not) via effortOptionsFor().
  grok: ['low', 'medium', 'high', 'xhigh'],
};

/** Effort levels for one concrete model: its own reported set when the
    provider supplies one (Codex `model/list`), else the provider fallback. */
export function effortOptionsFor(provider: Provider, efforts?: string[] | null): string[] {
  return efforts && efforts.length > 0 ? efforts : EFFORT_OPTIONS[provider];
}

/** Key used in ModelPrefs.hiddenModels ("provider:modelId"). */
export function modelKey(provider: string, model: string): string {
  return `${provider}:${model}`;
}

/** Apply the user's saved drag order (ModelPrefs.modelOrder) to a provider's
    models. Ranked models come first in the saved order; anything not yet ranked
    (e.g. a newly released model) keeps its original position at the end. Stable,
    non-mutating. */
export function orderModels<T extends { id: string }>(
  provider: string,
  models: T[],
  modelOrder: Record<string, string[]> | undefined,
): T[] {
  const order = modelOrder?.[provider];
  if (!order || order.length === 0) return models;
  const rank = new Map(order.map((id, i) => [id, i]));
  return models
    .map((m, i) => ({ m, i }))
    .sort((a, b) => {
      const ra = rank.get(a.m.id) ?? Infinity;
      const rb = rank.get(b.m.id) ?? Infinity;
      return ra === rb ? a.i - b.i : ra - rb;
    })
    .map((x) => x.m);
}

export function providerLabel(provider: string): string {
  return PROVIDER_LABEL[provider] ?? provider;
}

// e.g. 'claude-sonnet-5' -> 'Sonnet 5', 'claude-haiku-4-5-20251001' -> 'Haiku 4.5',
// 'gpt-5.6-sol' -> 'GPT-5.6 Sol'.
export function modelLabel(model: string | null): string | null {
  if (!model) return null;
  if (model === 'gpt-daybreak-blue-latest') return 'Daybreak Blue';
  if (model === 'z-ai/glm-5.2') return 'GLM 5.2';
  if (model === 'moonshotai/kimi-k3') return 'Kimi K3';
  const gpt = /^gpt-(\d[\d.]*)(?:-(.+))?$/.exec(model);
  if (gpt) {
    const suffix = gpt[2] ? ` ${gpt[2].split('-').map(capitalizeWord).join(' ')}` : '';
    return `GPT-${gpt[1]}${suffix}`;
  }
  const m = /^claude-(opus|sonnet|haiku|fable)-(.+)$/.exec(model);
  if (!m) return model;
  const familyRaw = m[1]!;
  const family = familyRaw[0]!.toUpperCase() + familyRaw.slice(1);
  const version = m[2]!
    .replace(/-\d{8,}$/, '') // drop a trailing snapshot date, if any
    .split('-')
    .filter(Boolean)
    .join('.');
  return `${family} ${version}`;
}

/** Drop a redundant leading provider name from an API model label
    (Anthropic's display_name is e.g. "Claude Opus 4.8"). */
export function stripProviderPrefix(label: string, provider: string): string {
  const p = providerLabel(provider) + ' ';
  const stripped = label.toLowerCase().startsWith(p.toLowerCase()) ? label.slice(p.length) : label;
  return stripped || label;
}

// Best-effort context-window sizes (in tokens) per provider/model, for the
// composer's "context used / available" readout. These are the models'
// documented context windows — the running CLI (Claude Code / Codex) may
// auto-compact before the window is full, so the gauge can read "used" well
// below the total. Update as models change; an unknown model returns null and
// the composer shows only the used count.
export function contextWindowFor(provider: string | null, model: string | null): number | null {
  if (provider === 'claude') {
    // Haiku is 200K; every current Opus/Sonnet/Fable/Mythos (4.6+ and 5-family) is 1M.
    if (model && /haiku/i.test(model)) return 200_000;
    return 1_000_000;
  }
  if (provider === 'codex') {
    // GPT-5.6 family (Sol/Terra/Luna) is 1.05M; earlier GPT-5 generations 400K.
    if (model === 'gpt-daybreak-blue-latest' || (model && /^gpt-5\.6/.test(model))) return 1_050_000;
    return 400_000;
  }
  if (provider === 'openrouter') return 200_000;
  // Conservative floor for the Grok 4.x family until we track per-model windows.
  if (provider === 'grok') return 256_000;
  return null;
}

function capitalizeWord(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}

/** Compact token count for the composer: 950 → "950", 47_200 → "47k", 1_000_000 → "1M". */
export function formatTokens(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  const millions = n / 1_000_000;
  return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`;
}

/** Small "Claude · Sonnet 5" badge text, or just the provider if the model isn't known yet. */
export function agentBadge(provider: string | null, model: string | null): string | null {
  if (!provider) return null;
  const label = modelLabel(model);
  return label ? `${providerLabel(provider)} · ${label}` : providerLabel(provider);
}
