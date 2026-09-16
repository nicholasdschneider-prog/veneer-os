import { describe, expect, it } from 'vitest';

import {
  firstUserPromptKey,
  isBuildQueuePrompt,
  isLongPrompt,
  mostRecentUserPromptKey,
  shouldCollapsePrompt,
  shouldCollapseUserPrompt,
  type PromptCollapseItem,
} from './promptCollapse';

describe('long prompt detection', () => {
  it('does not condense a short prompt', () => {
    expect(isLongPrompt('All of it')).toBe(false);
  });

  it('condenses prompts that cross the character or line limit', () => {
    expect(isLongPrompt('x'.repeat(839))).toBe(false);
    expect(isLongPrompt('x'.repeat(840))).toBe(true);
    expect(isLongPrompt(Array.from({ length: 12 }, () => 'x').join('\n'))).toBe(true);
  });
});

describe('user prompt collapsing', () => {
  it('always collapses build queue prompts from authenticated origin metadata', () => {
    const automatic = { kind: 'user', key: 'queue', origin: { kind: 'build_queue' } };
    const sameVisibleTextFromUser = { kind: 'user', key: 'human' };

    expect(isBuildQueuePrompt(automatic)).toBe(true);
    expect(isBuildQueuePrompt(sameVisibleTextFromUser)).toBe(false);
    expect(shouldCollapsePrompt(automatic, 'Short automatic prompt', 'queue', 'queue')).toBe(true);
    expect(shouldCollapsePrompt(sameVisibleTextFromUser, 'Short automatic prompt', 'human', 'human')).toBe(false);
  });

  it('keeps the first and most recent user prompts open', () => {
    const items: PromptCollapseItem[] = [
      { kind: 'user', key: 'user-1' },
      { kind: 'assistant', key: 'assistant-1' },
      { kind: 'user', key: 'user-2' },
      { kind: 'assistant', key: 'assistant-2' },
      { kind: 'user', key: 'user-3' },
    ];
    const first = firstUserPromptKey(items);
    const mostRecent = mostRecentUserPromptKey(items);

    expect(items.filter((item) => shouldCollapseUserPrompt(item, first, mostRecent)).map((item) => item.key))
      .toEqual(['user-2']);
    expect(shouldCollapseUserPrompt(items[0]!, first, mostRecent)).toBe(false);
    expect(shouldCollapseUserPrompt(items.at(-1)!, first, mostRecent)).toBe(false);
  });

  it('collapses a prompt only after a newer prompt follows it', () => {
    const items: PromptCollapseItem[] = [
      { kind: 'user', key: 'user-1' },
      { kind: 'assistant', key: 'assistant-1' },
    ];
    items.push({ kind: 'user', key: 'user-2' });

    const first = firstUserPromptKey(items);
    expect(shouldCollapseUserPrompt(items[0]!, first, mostRecentUserPromptKey(items))).toBe(false);
    expect(shouldCollapseUserPrompt(items[2]!, first, mostRecentUserPromptKey(items))).toBe(false);

    items.push({ kind: 'user', key: 'user-3' });
    expect(shouldCollapseUserPrompt(items[2]!, first, mostRecentUserPromptKey(items))).toBe(true);
    expect(shouldCollapseUserPrompt(items[3]!, first, mostRecentUserPromptKey(items))).toBe(false);
  });

  it('can ignore synthetic user rows when selecting the first and latest real prompts', () => {
    const items = [
      { kind: 'user', key: 'user-1', synthetic: false },
      { kind: 'user', key: 'user-2', synthetic: false },
      { kind: 'user', key: 'task-update', synthetic: true },
    ];
    const isRealPrompt = (item: (typeof items)[number]) => item.kind === 'user' && !item.synthetic;

    expect(firstUserPromptKey(items, isRealPrompt)).toBe('user-1');
    expect(mostRecentUserPromptKey(items, isRealPrompt)).toBe('user-2');
  });

  it('keeps the first confirmed prompt open while a newer prompt is pending', () => {
    const first = { kind: 'user', key: 'user-1' };
    const middle = { kind: 'user', key: 'user-2' };

    expect(shouldCollapseUserPrompt(first, first.key, null)).toBe(false);
    expect(shouldCollapseUserPrompt(middle, first.key, null)).toBe(true);
  });
});
