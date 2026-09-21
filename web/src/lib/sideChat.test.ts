import { describe, expect, it } from 'vitest';
import { sideChatHash, withSideParam } from './sideChat';

describe('withSideParam', () => {
  it('adds, replaces, and removes the side param while keeping others', () => {
    expect(withSideParam('#/chat/abc', 'open')).toBe('#/chat/abc?side=open');
    expect(withSideParam('#/chat/abc?from=bots&side=open', 'xyz')).toBe('#/chat/abc?from=bots&side=xyz');
    expect(withSideParam('#/chat/abc?from=bots&side=xyz', null)).toBe('#/chat/abc?from=bots');
  });
});

describe('sideChatHash', () => {
  it('opens the side panel on the chat, keeping the bots back link', () => {
    expect(sideChatHash('abc', 'bots')).toBe('#/chat/abc?from=bots&side=open');
    expect(sideChatHash('abc')).toBe('#/chat/abc?side=open');
  });
});
