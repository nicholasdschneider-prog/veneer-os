import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BotCallRing, BotCallSettings, answerCallTarget } from './BotCalls';

describe('bot calls', () => {
  it('reads the decision from a tapped call notification and nothing else', () => {
    expect(answerCallTarget('#/answer-call/abc-123')).toBe('abc-123');
    expect(answerCallTarget('#/answer-call/a%20b')).toBe('a b');
    expect(answerCallTarget('#/answer-call/')).toBeNull();
    expect(answerCallTarget('#/answer-call/abc/extra')).toBeNull();
    expect(answerCallTarget('#/answer-call/%E0%A4%A')).toBeNull();
    expect(answerCallTarget('#/bots/abc-123')).toBeNull();
  });

  it('shows nothing until a bot rings, and loads settings before offering switches', () => {
    expect(renderToStaticMarkup(<BotCallRing enabled />)).toBe('');
    const settings = renderToStaticMarkup(<BotCallSettings />);
    expect(settings).toContain('Loading call settings');
    expect(settings).not.toContain('role="switch"');
  });
});
