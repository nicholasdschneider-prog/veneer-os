import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { BotAvatar, replyActivity } from './BotIdentity';

describe('bot reply activity', () => {
  it('distinguishes streamed replies from work and clears at execution boundaries', () => {
    expect(replyActivity({ type: 'tool_started' }, false)).toBe(false);
    expect(replyActivity({ type: 'text_delta', text: 'Hello' }, false)).toBe(true);
    for (const type of [
      'tool_started',
      'text_final',
      'turn_done',
      'error',
      'approval_requested',
      'question_asked',
    ]) {
      expect(replyActivity({ type }, true)).toBe(false);
    }
    expect(replyActivity({ type: 'text_delta', text: '  ' }, false)).toBe(false);
  });
  it('keeps identity stable across names and uses accessible vector artwork', () => {
    const a = renderToStaticMarkup(<BotAvatar id="atlas" name="Atlas" />);
    const b = renderToStaticMarkup(<BotAvatar id="atlas" name="Renamed" />);
    expect(a.replace('Atlas', 'Renamed')).toBe(b);
    expect(a).toContain('role="img"');
    expect(a).not.toBe(renderToStaticMarkup(<BotAvatar id="robin" name="Robin" />));
  });
});
