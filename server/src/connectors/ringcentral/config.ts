const DEFAULT_RINGCENTRAL_SERVER_URL = 'https://platform.ringcentral.com';
const ALLOWED_RINGCENTRAL_ORIGINS = new Set([
  DEFAULT_RINGCENTRAL_SERVER_URL,
  'https://platform.devtest.ringcentral.com',
]);

export function normalizeRingCentralServerUrl(value?: string): string {
  const input = value?.trim() || DEFAULT_RINGCENTRAL_SERVER_URL;
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error('RingCentral server URL must be the production or sandbox HTTPS origin.');
  }
  if (
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash ||
    !ALLOWED_RINGCENTRAL_ORIGINS.has(parsed.origin)
  ) {
    throw new Error('RingCentral server URL must be https://platform.ringcentral.com or https://platform.devtest.ringcentral.com.');
  }
  return parsed.origin;
}

export function validateRingCentralSettings(settings: Record<string, string>): string | null {
  const allowedKeys = new Set(['serverUrl', 'clientId', 'clientSecret', 'jwt']);
  if (Object.keys(settings).some((key) => !allowedKeys.has(key))) {
    return 'RingCentral settings contain an unsupported field.';
  }
  try {
    normalizeRingCentralServerUrl(settings.serverUrl);
  } catch (err) {
    return (err as Error).message;
  }
  for (const key of ['clientId', 'clientSecret', 'jwt'] as const) {
    const value = settings[key] ?? '';
    if (!value.trim()) return `RingCentral ${key === 'jwt' ? 'JWT' : key === 'clientId' ? 'client ID' : 'client secret'} is required.`;
    if (/\0|\r|\n/.test(value)) return 'RingCentral credentials contain unsupported control characters.';
  }
  return null;
}
