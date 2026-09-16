import { describe, expect, it } from 'vitest';
import {
  appendChatMentionFooter,
  chatMentionsInText,
  segmentMentions,
  splitChatMentionFooter,
} from './mentions';

describe('segmentMentions', () => {
  it('splits a catalog mention out of surrounding text', () => {
    expect(segmentMentions('use @gmail please')).toEqual([
      { kind: 'text', text: 'use ' },
      { kind: 'mention', text: '@gmail', mention: 'gmail', slug: 'gmail' },
      { kind: 'text', text: ' please' },
    ]);
  });

  it('recognizes the Outlook connector mention', () => {
    expect(segmentMentions('check @outlook now')[1]).toMatchObject({
      kind: 'mention',
      mention: 'outlook',
      slug: 'outlook',
    });
  });

  it('recognizes the Google Drive connector mention', () => {
    expect(segmentMentions('check @googledrive now')[1]).toMatchObject({
      kind: 'mention',
      mention: 'googledrive',
      slug: 'googledrive',
    });
  });

  it.each([
    ['googledocs', 'googledocs'],
    ['googlesheets', 'googlesheets'],
    ['googleads', 'googleads'],
    ['google_analytics', 'google_analytics'],
    ['quickbooks', 'quickbooks'],
    ['ringcentral', 'ringcentral'],
    ['hubspot', 'hubspot'],
  ])('recognizes the @%s connector mention', (mention, slug) => {
    expect(segmentMentions(`check @${mention} now`)[1]).toMatchObject({
      kind: 'mention',
      mention,
      slug,
    });
  });

  it('matches at the start of the text and at the end', () => {
    expect(segmentMentions('@gmail go')[0]).toMatchObject({ kind: 'mention', slug: 'gmail' });
    expect(segmentMentions('go @gmail').at(-1)).toMatchObject({ kind: 'mention', slug: 'gmail' });
  });

  it('resolves labeled and shared install tokens to the catalog slug', () => {
    expect(segmentMentions('check @gmail-work now')[1]).toMatchObject({
      kind: 'mention',
      mention: 'gmail-work',
      slug: 'gmail',
    });
    expect(segmentMentions('check @gmail-team-2 now')[1]).toMatchObject({
      kind: 'mention',
      mention: 'gmail-team-2',
      slug: 'gmail',
    });
  });

  it('keeps unknown @words plain', () => {
    expect(segmentMentions('hi @everyone and @slack')).toEqual([
      { kind: 'text', text: 'hi @everyone and @slack' },
    ]);
  });

  it('keeps email addresses plain', () => {
    expect(segmentMentions('mail user@gmail.com today')).toEqual([
      { kind: 'text', text: 'mail user@gmail.com today' },
    ]);
  });

  it('stops the token at punctuation', () => {
    expect(segmentMentions('use @gmail.')).toEqual([
      { kind: 'text', text: 'use ' },
      { kind: 'mention', text: '@gmail', mention: 'gmail', slug: 'gmail' },
      { kind: 'text', text: '.' },
    ]);
  });

  it('handles multi-line drafts and repeated mentions', () => {
    const segments = segmentMentions('first @gmail\nthen @googledrive\n');
    expect(segments.filter((s) => s.kind === 'mention').map((s) => s.text)).toEqual([
      '@gmail',
      '@googledrive',
    ]);
    expect(segments.at(-1)).toEqual({ kind: 'text', text: '\n' });
  });

  it('restricts to the allowed set when one is given', () => {
    const allowed = new Set(['gmail-work']);
    expect(segmentMentions('use @gmail or @gmail-work', allowed)).toEqual([
      { kind: 'text', text: 'use @gmail or ' },
      { kind: 'mention', text: '@gmail-work', mention: 'gmail-work', slug: 'gmail' },
    ]);
  });

  it('matches case-insensitively', () => {
    expect(segmentMentions('use @Gmail')[1]).toMatchObject({ mention: 'gmail', slug: 'gmail' });
  });

  it('falls back to the token as slug for allowed non-catalog installs', () => {
    expect(segmentMentions('use @notion', new Set(['notion']))[1]).toMatchObject({
      kind: 'mention',
      slug: 'notion',
    });
  });

  it('matches literal chat tokens with spaces alongside connector mentions', () => {
    const chats = new Map([['@Crew Seating', 'id-1']]);
    expect(segmentMentions('ask @Crew Seating via @gmail now', undefined, chats)).toEqual([
      { kind: 'text', text: 'ask ' },
      { kind: 'chat', text: '@Crew Seating', id: 'id-1' },
      { kind: 'text', text: ' via ' },
      { kind: 'mention', text: '@gmail', mention: 'gmail', slug: 'gmail' },
      { kind: 'text', text: ' now' },
    ]);
  });

  it('prefers the longest chat token and respects word edges', () => {
    const chats = new Map([
      ['@Crew', 'short'],
      ['@Crew Seating', 'long'],
    ]);
    expect(segmentMentions('ping @Crew Seating', undefined, chats)[1]).toMatchObject({ id: 'long' });
    expect(segmentMentions('ping @Crews', undefined, chats)).toEqual([
      { kind: 'text', text: 'ping @Crews' },
    ]);
  });
});

describe('chat mention footer', () => {
  const map = new Map([
    ['@Crew Seating', 'aaa-111'],
    ['@Daily Brief', 'bbb-222'],
  ]);

  it('collects only tokens still present in the draft', () => {
    expect(chatMentionsInText('ask @Crew Seating about seats', map)).toEqual([
      { token: '@Crew Seating', id: 'aaa-111' },
    ]);
    expect(chatMentionsInText('nothing mentioned', map)).toEqual([]);
  });

  it('round-trips append and split', () => {
    const sent = appendChatMentionFooter('ask @Crew Seating and @Daily Brief', [
      { token: '@Crew Seating', id: 'aaa-111' },
      { token: '@Daily Brief', id: 'bbb-222' },
    ]);
    expect(sent).toContain('(chat id: aaa-111)');
    const { visible, chatTokens } = splitChatMentionFooter(sent);
    expect(visible).toBe('ask @Crew Seating and @Daily Brief');
    expect(chatTokens.get('@Crew Seating')).toBe('aaa-111');
    expect(chatTokens.get('@Daily Brief')).toBe('bbb-222');
  });

  it('appends nothing for an empty mention list', () => {
    expect(appendChatMentionFooter('plain', [])).toBe('plain');
  });

  it('leaves messages without a well-formed footer untouched', () => {
    const malformed = 'text\n\nMentioned chats (ids appended by the app):\n- broken line';
    expect(splitChatMentionFooter(malformed).visible).toBe(malformed);
    expect(splitChatMentionFooter('no footer here').visible).toBe('no footer here');
  });
});
