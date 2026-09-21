/** Only fixed categories cross IPC. Never return provider messages or request bodies. */
export function voiceFailureCode(value: unknown, depth = 0): string {
  if (!value || typeof value !== 'object' || depth > 5) return 'connection';
  const row = value as Record<string, unknown>;
  const code = row.code ?? row.type;
  if (typeof code === 'string') {
    if (['context_length_exceeded', 'session_instructions_too_long', 'string_above_max_length'].includes(code)) return 'context_limit';
    if (['invalid_api_key', 'account_deactivated'].includes(code)) return 'authentication';
    if (['insufficient_quota', 'billing_hard_limit_reached'].includes(code)) return 'quota';
    if (['rate_limit_exceeded'].includes(code)) return 'rate_limit';
  }
  // SDKs sometimes retain only the provider's message. Match fixed signatures
  // locally, but never emit the message or any substring of it.
  if (typeof row.message === 'string' &&
      /maximum context length|context length exceeded|instructions.{0,40}(too long|maximum length)|input.{0,20}exceeds.{0,20}token/i.test(row.message)) return 'context_limit';
  for (const key of ['error', 'body', 'cause']) {
    const found = voiceFailureCode(row[key], depth + 1);
    if (found !== 'connection') return found;
  }
  return 'connection';
}
export function voiceFailureMessage(code: unknown): string {
  switch (code) {
    case 'context_limit': return 'The voice provider could not fit this conversation context. End this call and reconnect; if it repeats, report a voice context error.';
    case 'authentication': return 'The voice provider rejected authentication. Ask an administrator to check voice service access.';
    case 'quota': return 'The voice provider account has reached its credit limit. Ask an administrator to check billing.';
    case 'rate_limit': return 'The voice provider is busy. End this call and reconnect shortly.';
    default: return 'The live voice connection failed. End this call and reconnect. Your saved conversation and decisions are retained.';
  }
}
