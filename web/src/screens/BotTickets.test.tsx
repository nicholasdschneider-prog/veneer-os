import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { BotTickets, ticketHref, ticketStatusLabel } from './BotTickets';

vi.mock('@/lib/bots', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/bots')>()), csTicketsApi: { list: () => new Promise(() => {}), detail: () => new Promise(() => {}), note: vi.fn() } }));

describe('bot tickets (Miles pilot)', () => {
  it('labels a ticket by what the human has to do next', () => {
    expect(ticketStatusLabel({ status: 'open', open_decision: { id: 'd', version: 1, question: 'Q', recommended: null } })).toBe('Needs you');
    expect(ticketStatusLabel({ status: 'waiting_human', open_decision: null })).toBe('Needs you');
    expect(ticketStatusLabel({ status: 'waiting_customer', open_decision: null })).toBe('Waiting on customer');
    expect(ticketStatusLabel({ status: 'open', open_decision: null })).toBe('Bot is working');
    expect(ticketStatusLabel({ status: 'done', open_decision: null })).toBe('Done');
  });
  it('links to the bot list and to one ticket', () => {
    expect(ticketHref('bot 1')).toBe('#/bots/tickets/bot%201');
    expect(ticketHref('bot', 't/1')).toBe('#/bots/tickets/bot/t%2F1');
  });
  it('renders the Tickets tab with its filters, search and empty detail pane', () => {
    const html = renderToStaticMarkup(<BotTickets botId="bot" onNavigate={() => {}} />);
    for (const label of ['Needs you', 'Waiting', 'Done', 'All']) expect(html).toContain(`>${label}<`);
    expect(html).toContain('aria-label="Search tickets"');
    expect(html).toContain('Choose a ticket to read the whole thread');
    const detail = renderToStaticMarkup(<BotTickets botId="bot" ticketId="t1" onNavigate={() => {}} />);
    expect(detail).toContain('Loading ticket…');
    expect(detail).toContain('hidden md:flex');
  });
});

import { latestOpenChoiceNote } from './BotTickets';
import { splitAttachmentFooter } from '@/lib/botComposer';
import type { CsTicketMessage } from '@/lib/bots';

describe('ticket notes with tappable choices and attachments', () => {
  const note = (over: Partial<CsTicketMessage>): CsTicketMessage => ({ id: 'n', direction: 'note', channel: '', external_id: null, author: 'bot', author_label: 'Miles', body: 'x', attachments: [], remember: false, at: '2026-10-16T20:00:00Z', ...over });
  it('keeps only the newest bot choices live until a human writes', () => {
    const choices = [{ label: 'Refund', note: 'Refund the line.' }, { label: 'Wait', note: 'Wait for the carrier.' }];
    expect(latestOpenChoiceNote([note({ id: 'a', choices })])).toBe('a');
    expect(latestOpenChoiceNote([note({ id: 'a', choices }), note({ id: 'b', choices })])).toBe('b');
    expect(latestOpenChoiceNote([note({ id: 'a', choices }), note({ id: 'h', author: 'human', author_label: 'Nick' })])).toBeNull();
    expect(latestOpenChoiceNote([note({ id: 'h', author: 'human' }), note({ id: 'c', choices })])).toBe('c');
    expect(latestOpenChoiceNote([note({ id: 'a' })])).toBeNull();
  });
  it('splits the composer attachment footer back into text and paths', () => {
    expect(splitAttachmentFooter('Look at this\n\nAttached files (saved on this server — read them from these paths):\n- /data/uploads/ab/claim.pdf\n- /data/uploads/cd/photo.jpg'))
      .toEqual({ body: 'Look at this', paths: ['/data/uploads/ab/claim.pdf', '/data/uploads/cd/photo.jpg'] });
    expect(splitAttachmentFooter('  just text  ')).toEqual({ body: 'just text', paths: [] });
  });
});
