export type PromptCollapseItem = {
  key: string;
  kind: string;
  origin?: { kind: string };
};

// A narrow phone wraps roughly 840 prose characters into twelve or more lines.
// Explicitly multi-line prompts use the same twelve-line cutoff.
const LONG_PROMPT_MIN_CHARACTERS = 840;
const LONG_PROMPT_MIN_LINES = 12;

export function isLongPrompt(text: string): boolean {
  return (
    text.length >= LONG_PROMPT_MIN_CHARACTERS ||
    text.split('\n').length >= LONG_PROMPT_MIN_LINES
  );
}

/** Build-queue turns are authenticated automatic prompts, not user messages. */
export function isBuildQueuePrompt(item: PromptCollapseItem): boolean {
  return item.kind === 'user' && item.origin?.kind === 'build_queue';
}

export function firstUserPromptKey<T extends PromptCollapseItem>(
  items: readonly T[],
  isUserPrompt: (item: T) => boolean = (item) => item.kind === 'user',
): string | null {
  return items.find(isUserPrompt)?.key ?? null;
}

export function mostRecentUserPromptKey<T extends PromptCollapseItem>(
  items: readonly T[],
  isUserPrompt: (item: T) => boolean = (item) => item.kind === 'user',
): string | null {
  return items.findLast(isUserPrompt)?.key ?? null;
}

export function shouldCollapseUserPrompt(
  item: PromptCollapseItem,
  firstPromptKey: string | null,
  mostRecentPromptKey: string | null,
): boolean {
  return (
    item.kind === 'user' &&
    item.key !== firstPromptKey &&
    item.key !== mostRecentPromptKey
  );
}

export function shouldCollapsePrompt(
  item: PromptCollapseItem,
  visibleText: string,
  firstPromptKey: string | null,
  mostRecentPromptKey: string | null,
): boolean {
  if (isBuildQueuePrompt(item)) return true;
  return (
    isLongPrompt(visibleText) &&
    shouldCollapseUserPrompt(item, firstPromptKey, mostRecentPromptKey)
  );
}
