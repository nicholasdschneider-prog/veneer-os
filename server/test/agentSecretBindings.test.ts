import { describe, expect, it } from 'vitest';
import {
  AGENT_SECRET_BINDINGS_NAME,
  addBoundAgentSecrets,
} from '../src/secrets/agentSecretBindings.js';

function reader(values: Record<string, string>) {
  return { get: (name: string) => values[name] ?? null };
}

describe('agent Doppler secret bindings', () => {
  it('adds only explicitly bound credentials and keeps unrelated secrets private', () => {
    const env = addBoundAgentSecrets(
      { HOME: '/home/agent' },
      reader({
        [AGENT_SECRET_BINDINGS_NAME]: 'SEARCH_API_TOKEN=ACME_CF_API_TOKEN',
        ACME_CF_API_TOKEN: 'search-only',
        OPENROUTER_API_KEY: 'must-stay-private',
      }),
    );

    expect(env).toMatchObject({ HOME: '/home/agent', SEARCH_API_TOKEN: 'search-only' });
    expect(env.OPENROUTER_API_KEY).toBeUndefined();
    expect(env.ACME_CF_API_TOKEN).toBeUndefined();
    expect(env.DOPPLER_TOKEN).toBeUndefined();
  });

  it('does not replace an existing environment value', () => {
    const env = addBoundAgentSecrets(
      { SEARCH_API_TOKEN: 'operator-value' },
      reader({
        [AGENT_SECRET_BINDINGS_NAME]: 'SEARCH_API_TOKEN=ACME_CF_API_TOKEN',
        ACME_CF_API_TOKEN: 'doppler-value',
      }),
    );

    expect(env.SEARCH_API_TOKEN).toBe('operator-value');
  });

  it('fails closed for malformed, control, metadata, and missing bindings', () => {
    const env = addBoundAgentSecrets(
      { PATH: '/usr/bin' },
      reader({
        [AGENT_SECRET_BINDINGS_NAME]: [
          'PATH=ACME_CF_API_TOKEN',
          'NODE_OPTIONS=ACME_CF_API_TOKEN',
          'SAFE_API_TOKEN=DOPPLER_TOKEN',
          `LOOP_API_TOKEN=${AGENT_SECRET_BINDINGS_NAME}`,
          'MISSING_API_TOKEN=NOT_PRESENT',
          'BROKEN',
        ].join(','),
        ACME_CF_API_TOKEN: 'must-stay-private',
        DOPPLER_TOKEN: 'must-stay-private',
      }),
    );

    expect(env).toEqual({ PATH: '/usr/bin' });
  });
});
