import type { ModelOption, ProviderAdapter, TurnSpec } from '../types.js';
import { createClaudeAdapter } from '../claude/adapter.js';
import { agentEnv } from '../../homes.js';
import { loadOpenRouterModels } from './models.js';

export interface OpenRouterAdapterOptions {
  claudeBin: string;
  turnTimeoutMs: number;
  turnInactivityMs?: number;
  configDir: string;
  getApiKey: () => string | null;
  getModelIds: () => string[];
  /** Base agent environment, optionally extended with approved runtime credentials. */
  buildEnv?: (fullAccess: boolean) => NodeJS.ProcessEnv;
  loadModels?: (ids: string[], apiKey: string | null) => Promise<ModelOption[]>;
  log?: Pick<Console, 'warn' | 'error'>;
}

/**
 * OpenRouter speaks Claude Code's native Anthropic protocol. Keep it as a
 * first-class provider while deliberately sharing the battle-tested Claude
 * process/wire harness. Every child gets a separate profile and a sanitized
 * auth environment, so a Claude subscription can stay logged in concurrently.
 */
export function createOpenRouterAdapter(opts: OpenRouterAdapterOptions): ProviderAdapter {
  const base = createClaudeAdapter({
    id: 'openrouter',
    claudeBin: opts.claudeBin,
    turnTimeoutMs: opts.turnTimeoutMs,
    turnInactivityMs: opts.turnInactivityMs,
    configDir: opts.configDir,
    loadModels: () => (opts.loadModels ?? loadOpenRouterModels)(opts.getModelIds(), opts.getApiKey()),
    modelsCacheKey: () => opts.getModelIds().join('\n'),
    missingCredentialMessage:
      "OpenRouter isn't connected — add an OpenRouter API key in Settings → API Keys.",
    prepareSpawnEnv: (spec) =>
      buildOpenRouterSpawnEnv(
        (opts.buildEnv ?? agentEnv)(spec.dangerous ?? false),
        opts.configDir,
        opts.getApiKey(),
        spec.model,
      ),
    log: opts.log,
  });

  return {
    ...base,
    runTurn(spec, onEvent, onSessionId) {
      // OpenRouter never gets an implicit Claude alias. Pin the exact selected
      // id, falling back to the first configured model for non-web callers.
      const model = spec.model ?? opts.getModelIds()[0] ?? null;
      const effort = spec.effort && ['low', 'medium', 'high'].includes(spec.effort) ? spec.effort : null;
      return base.runTurn({ ...spec, model, effort }, onEvent, onSessionId);
    },
  };
}

/** Exported for a no-secret regression test of the auth boundary. */
export function buildOpenRouterSpawnEnv(
  parent: NodeJS.ProcessEnv,
  configDir: string,
  apiKey: string | null,
  model: string | null | undefined,
): { env: NodeJS.ProcessEnv; hasCredential: boolean } {
  const env: NodeJS.ProcessEnv = { ...parent };
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  env.CLAUDE_CONFIG_DIR = configDir;
  env.ANTHROPIC_BASE_URL = 'https://openrouter.ai/api';
  env.ANTHROPIC_AUTH_TOKEN = apiKey ?? '';
  // OpenRouter requires an explicitly blank API key to prevent Claude Code
  // from preferring a cached/ambient Anthropic credential.
  env.ANTHROPIC_API_KEY = '';
  if (model) {
    env.ANTHROPIC_DEFAULT_OPUS_MODEL = model;
    env.ANTHROPIC_DEFAULT_SONNET_MODEL = model;
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL = model;
    env.CLAUDE_CODE_SUBAGENT_MODEL = model;
  }
  return { env, hasCredential: Boolean(apiKey?.trim()) };
}
