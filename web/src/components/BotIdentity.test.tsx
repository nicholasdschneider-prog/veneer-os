import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { BotAvatar, BotName, botJobTitle, replyActivity } from './BotIdentity';

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


describe('native bot job titles', () => {
  it.each([
    ['Henry', 'Henry · ERVP Business Leadership', 'ERVP Business Leadership'],
    ['Grant', 'Grant · Customer Service Lead', 'Customer Service Lead'],
    ['Piper', 'Piper Content', 'Content'],
    ['Sage', 'Sage · Vendor Operations/Orders', 'Vendor Operations/Orders'],
    ['Nora', 'Nora — Customer Service', 'Customer Service'],
    ['Miles', 'Miles: Customer Service', 'Customer Service'],
    ['Tess', 'Tess|Customer Service', 'Customer Service'],
    ['Owen', 'Owen-Customer Service', 'Customer Service'],
    ['Avery', '  avery · New Ticket Triage  ', 'New Ticket Triage'],
    ['Clara', 'Accounting', 'Accounting'],
    ['Ann', 'Annette Support', 'Annette Support'],
    ['Solo', 'Solo', ''],
    ['Solo', 'Solo · ', ''],
    ['Solo', null, ''],
    ['Solo', undefined, ''],
  ])('derives %s from %s without changing metadata', (name, title, expected) => {
    expect(botJobTitle(name, title)).toBe(expected);
  });
  it('renders the description beside the name and omits absent descriptions', () => {
    const markup = renderToStaticMarkup(<BotName name="Piper" title="Piper Content" />);
    expect(markup.match(/Piper/g)).toHaveLength(1);
    expect(markup).toContain('Content');
    expect(renderToStaticMarkup(<BotName name="Solo" title="Solo" />)).not.toContain('text-muted-foreground');
  });
});
