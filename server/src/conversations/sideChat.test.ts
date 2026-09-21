import { describe, expect, it } from 'vitest';
import type { ConversationEvent } from '../runtime/events.js';
import { recentExchangeExcerpt, sideChatOpeningMessage } from './sideChat.js';

const events: ConversationEvent[] = [
  { type: 'turn_started', turnId: 't1', role: 'user', text: 'Refund order 123?', at: 'a', via: 'web' },
  { type: 'text_final', turnId: 't1', markdown: 'Checking the order now.', at: 'b' },
  { type: 'tool_started', turnId: 't1', toolId: 'x', name: 'Bash', input: {} } as unknown as ConversationEvent,
];

describe('recentExchangeExcerpt', () => {
  it('keeps user and agent text in order and skips tool events', () => {
    expect(recentExchangeExcerpt(events, 'Henry')).toBe('User: Refund order 123?\nHenry: Checking the order now.');
  });
  it('clips long lines', () => {
    const long: ConversationEvent[] = [{ type: 'text_final', turnId: 't', markdown: 'x'.repeat(2000), at: 'b' }];
    expect(recentExchangeExcerpt(long, 'H').length).toBeLessThan(620);
  });
});

describe('sideChatOpeningMessage', () => {
  it('names the parent, forbids interrupting it, and ends with the question', () => {
    const text = sideChatOpeningMessage({
      parentId: 'abc', parentTitle: 'Refunds', agentName: 'Henry', status: 'working', events, question: 'Why the delay?',
    });
    expect(text).toContain('"Refunds" (id abc)');
    expect(text).toContain('working on a turn');
    expect(text).toContain('read_conversation');
    expect(text.endsWith('---\nWhy the delay?')).toBe(true);
  });
});
