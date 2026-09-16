import type { DictationEndReason } from './stt';

export function joinTodoDictation(base: string, addition: string): string {
  if (!addition) return base;
  if (!base) return addition;
  return base.endsWith(' ') || base.endsWith('\n') ? base + addition : `${base} ${addition}`;
}

export function finalizedDictatedTodoTitle(
  reason: DictationEndReason,
  hasCommittedSpeech: boolean,
  draft: string,
): string | null {
  if (reason !== 'user' || !hasCommittedSpeech) return null;
  return draft.trim() || null;
}
