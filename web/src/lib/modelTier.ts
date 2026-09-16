import type { Provider } from './modelLabel';

/**
 * Hand-set capability tier per model, 1 (lightest) to 4 (frontier), shown as
 * four dots in the model picker so clients get a feel for "how smart" without
 * knowing model names. Model lists come live from each provider, so this is
 * the one place the ranking lives; keep it current when a generation ships.
 * Unknown models get null and render no dots rather than a guess.
 */
export const MODEL_TIER_MAX = 4;

type TierRule = { test: RegExp; tier: number };

const RULES: Record<Provider, TierRule[]> = {
  claude: [
    { test: /fable|mythos/i, tier: 4 },
    { test: /opus/i, tier: 3 },
    { test: /sonnet/i, tier: 2 },
    { test: /haiku/i, tier: 1 },
  ],
  codex: [
    { test: /mini|nano/i, tier: 1 },
    { test: /daybreak-blue/i, tier: 3 },
    { test: /gpt-5\.6-(sol|terra)/i, tier: 3 },
    { test: /gpt-5\.6-luna/i, tier: 2 },
    { test: /^gpt-5/i, tier: 2 },
  ],
  grok: [
    { test: /imagine/i, tier: 0 },
    { test: /fast|mini/i, tier: 2 },
    { test: /^grok-4/i, tier: 3 },
  ],
  openrouter: [
    { test: /glm-5|kimi-k3/i, tier: 3 },
    { test: /inkling/i, tier: 2 },
  ],
};

/** Tier for a model id, or null when the model is unknown or has no meaningful tier. */
export function modelTier(provider: Provider, modelId: string): number | null {
  if (!modelId) return null;
  const rule = RULES[provider]?.find((r) => r.test.test(modelId));
  if (!rule || rule.tier === 0) return null;
  return rule.tier;
}
