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
