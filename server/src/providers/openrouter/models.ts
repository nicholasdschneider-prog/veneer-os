import type Database from 'better-sqlite3';
import type { ModelOption } from '../types.js';

export const DEFAULT_OPENROUTER_MODEL_IDS = [
  'z-ai/glm-5.2',
  'moonshotai/kimi-k3',
  '~deepseek/deepseek-v4-flash-latest',
  'thinkingmachines/inkling',
] as const;

const LABEL_OVERRIDES: Record<string, string> = {
  '~deepseek/deepseek-v4-flash-latest': 'Deepseek V4 Flash',
};

const FRIENDLY_NAMES: Record<string, string> = {
  'z-ai/glm-5.2': 'GLM 5.2',
  'moonshotai/kimi-k3': 'Kimi K3',
};

/** Read the exact user-managed OpenRouter allowlist from shared settings. */
export function readOpenRouterModelIds(db: Database.Database): string[] {
  try {
    const row = db.prepare("SELECT value_json FROM settings WHERE key = 'model_prefs'").get() as
      | { value_json: string }
      | undefined;
    const parsed = row ? (JSON.parse(row.value_json) as { openrouterModels?: unknown }) : null;
    if (Array.isArray(parsed?.openrouterModels)) {
      const ids = parsed.openrouterModels
        .filter((id): id is string => typeof id === 'string')
        .map((id) => id.trim())
        .filter(Boolean);
      if (ids.length) return [...new Set(ids)];
    }
  } catch {
    /* corrupt/missing settings → safe seeded list */
  }
  return [...DEFAULT_OPENROUTER_MODEL_IDS];
}

interface OpenRouterCatalogModel {
  id?: string;
  name?: string;
}

/** Fetch labels for only the configured models; never expose the full catalog. */
export async function loadOpenRouterModels(
  ids: string[],
  apiKey: string | null,
  fetchImpl: typeof fetch = fetch,
): Promise<ModelOption[]> {
  let catalog = new Map<string, OpenRouterCatalogModel>();
  try {
    const res = await fetchImpl('https://openrouter.ai/api/v1/models', {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
    });
    if (res.ok) {
      const body = (await res.json()) as { data?: OpenRouterCatalogModel[] };
      catalog = new Map((body.data ?? []).filter((m) => m.id).map((m) => [m.id!, m]));
    }
  } catch {
    /* The configured ids remain usable when catalog metadata is unavailable. */
  }
  return ids.map((id, index) => ({
    id,
    label: LABEL_OVERRIDES[id] ?? catalog.get(id)?.name ?? FRIENDLY_NAMES[id] ?? id,
    efforts: ['low', 'medium', 'high'],
    isDefault: index === 0,
  }));
}
