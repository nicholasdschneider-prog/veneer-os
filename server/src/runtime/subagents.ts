import crypto from 'node:crypto';

/**
 * Provider-native child/thread ids are useful for correlation but must not
 * cross the normalized event boundary. Hash them into an opaque presentation
 * key that is stable for transcript reloads without revealing the source id.
 */
export function subagentEventKey(provider: string, nativeId: string): string {
  return crypto.createHash('sha256').update(`${provider}\0${nativeId}`).digest('hex').slice(0, 20);
}

export function subagentLabel(value: unknown, fallback = 'Delegated task'): string {
  if (typeof value !== 'string') return fallback;
  const label = value.replace(/\s+/g, ' ').trim();
  if (!label) return fallback;
  return label.length > 120 ? `${label.slice(0, 119)}…` : label;
}

export function labelFromAgentPath(value: unknown): string {
  if (typeof value !== 'string') return 'Delegated task';
  const leaf = value.split('/').filter(Boolean).pop() ?? '';
  const words = leaf.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!words) return 'Delegated task';
  return subagentLabel(words[0]!.toUpperCase() + words.slice(1));
}
