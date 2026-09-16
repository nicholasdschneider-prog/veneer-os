import type { Config } from '../config.js';
import type { SecretStore } from './store.js';
import type { DopplerRuntime } from './doppler.js';

/**
 * Managed third-party API keys surfaced in Settings → API Keys. Each has a
 * DEFAULT sourced from the service env file (Doppler-backed, so a reinstall
 * still has it) and an optional user OVERRIDE stored in DATA_DIR/secrets.json.
 * The override wins when present; otherwise the default is used.
 *
 * Adding a key here is all it takes to show it in Settings — map its env
 * default in `envDefault` below.
 */
export type ApiKeyId = 'openrouter' | 'soniox' | 'composio';

export interface ApiKeyDef {
  id: ApiKeyId;
  label: string;
  description: string;
}

export const API_KEY_DEFS: ApiKeyDef[] = [
  {
    id: 'openrouter',
    label: 'OpenRouter',
    description: 'Access many models through one key (openrouter.ai).',
  },
  {
    id: 'soniox',
    label: 'Soniox',
    description: 'Powers realtime voice dictation (soniox.com).',
  },
  {
    id: 'composio',
    label: 'Composio',
    description: 'Powers hosted connectors like Gmail on the Connectors page (composio.dev).',
  },
];

/** The env/Doppler default for a key id (null if the server has none). */
export function envDefault(id: ApiKeyId, config: Config): string | null {
  switch (id) {
    case 'openrouter':
      return config.openRouterApiKey;
    case 'soniox':
      return config.sonioxApiKey;
    case 'composio':
      return config.composioApiKey;
  }
}

export type ApiKeySource = 'override' | 'doppler' | 'default' | null;

const DOPPLER_NAMES: Record<ApiKeyId, string> = {
  openrouter: 'OPENROUTER_API_KEY',
  soniox: 'SONIOX_API_KEY',
  composio: 'COMPOSIO_API_KEY',
};

/** The key actually in effect: local override, client Doppler, then legacy env. */
export function effectiveApiKey(
  id: ApiKeyId,
  secrets: SecretStore,
  config: Config,
  doppler?: Pick<DopplerRuntime, 'get'>,
): { value: string | null; source: ApiKeySource } {
  const override = secrets.getApiKeyOverride(id);
  if (override) return { value: override, source: 'override' };
  const connected = doppler?.get(DOPPLER_NAMES[id]);
  if (connected) return { value: connected, source: 'doppler' };
  const fallback = envDefault(id, config);
  if (fallback && fallback.trim()) return { value: fallback.trim(), source: 'default' };
  return { value: null, source: null };
}

/**
 * A last-4 hint so the UI can confirm WHICH key is set without ever returning
 * the secret itself. Short/blank keys show no hint.
 */
export function keyHint(value: string | null): string | null {
  if (!value) return null;
  const v = value.trim();
  return v.length >= 8 ? `…${v.slice(-4)}` : null;
}

export interface ApiKeyStatus {
  id: ApiKeyId;
  label: string;
  description: string;
  /** True if any key (override or default) is in effect. */
  configured: boolean;
  source: ApiKeySource;
  /** Masked tail of the effective key, or null. Never the full value. */
  hint: string | null;
}

/** Non-secret status for every managed key — safe to return over the API. */
export function apiKeyStatuses(
  secrets: SecretStore,
  config: Config,
  doppler?: Pick<DopplerRuntime, 'get'>,
): ApiKeyStatus[] {
  return API_KEY_DEFS.map((def) => {
    const { value, source } = effectiveApiKey(def.id, secrets, config, doppler);
    return {
      id: def.id,
      label: def.label,
      description: def.description,
      configured: Boolean(value),
      source,
      hint: keyHint(value),
    };
  });
}
