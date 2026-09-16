export const AGENT_SECRET_BINDINGS_NAME = 'VENEER_AGENT_SECRET_BINDINGS';

const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,199}$/;
const AGENT_CREDENTIAL_NAME =
  /^[A-Z][A-Z0-9_]{0,160}_(?:API_KEY|API_TOKEN|ACCESS_TOKEN|AUTH_TOKEN|PASSWORD|SECRET|JWT)$/;
const MAX_BINDINGS = 32;

interface SecretReader {
  get(name: string): string | null;
}

/**
 * Add only the Doppler credentials that an administrator explicitly binds.
 * The binding setting contains names, never values:
 *
 *   SEARCH_API_TOKEN=ACME_CF_API_TOKEN
 *
 * Invalid entries fail closed. Existing provider or machine environment values
 * always win, so a binding cannot replace auth or process-control settings.
 */
export function addBoundAgentSecrets(
  base: NodeJS.ProcessEnv,
  doppler: SecretReader,
): NodeJS.ProcessEnv {
  const env = { ...base };
  const raw = doppler.get(AGENT_SECRET_BINDINGS_NAME);
  if (!raw) return env;

  const entries = raw.split(/[\n,]+/).slice(0, MAX_BINDINGS);
  for (const entry of entries) {
    const [rawTarget, rawSource, extra] = entry.trim().split('=');
    const target = rawTarget?.trim();
    const source = rawSource?.trim();
    if (
      !target ||
      !source ||
      extra !== undefined ||
      !AGENT_CREDENTIAL_NAME.test(target) ||
      !SECRET_NAME.test(source) ||
      source === AGENT_SECRET_BINDINGS_NAME ||
      source.startsWith('DOPPLER_') ||
      env[target] !== undefined
    ) {
      continue;
    }
    const value = doppler.get(source);
    if (value) env[target] = value;
  }
  return env;
}
