import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Bot } from '@/lib/bots';
import { BotDockList, dockTime, parseServerTime, popOutHash, sortDockBots } from './BotDock';

const bot = (over: Partial<Bot>): Bot => ({
  conversation_id: over.name?.toLowerCase() ?? 'x', name: 'X', state: 'available', questions: 0,
  can_manage: false, archived: false, provider: 'claude', project_id: null, ...over,
});

describe('bot dock', () => {
  it('reads ISO and SQLite UTC timestamps alike', () => {
    expect(parseServerTime('2026-11-10 14:00:00')).toBe(Date.parse('2026-11-10T14:00:00Z'));
    expect(parseServerTime('2026-11-10T14:00:00.000Z')).toBe(Date.parse('2026-11-10T14:00:00Z'));
    expect(parseServerTime(null)).toBe(0);
    expect(parseServerTime('garbage')).toBe(0);
  });

  it('puts whoever replied most recently on top, ignoring pins and archived bots', () => {
    const sorted = sortDockBots([
      bot({ name: 'Tess', pinned: true, last_reply: { text: 'a', at: '2026-11-10 09:00:00' } }),
      bot({ name: 'Clara', last_reply: { text: 'b', at: '2026-11-10 14:00:00' } }),
      bot({ name: 'Finn', updated_at: '2026-11-10 12:00:00' }),
      bot({ name: 'Old', archived: true, last_reply: { text: 'c', at: '2026-11-10 15:00:00' } }),
    ]);
    expect(sorted.map((b) => b.name)).toEqual(['Clara', 'Finn', 'Tess']);
  });

  it('shows short list times', () => {
    const now = new Date(2026, 10, 10, 15, 0).getTime();
    expect(dockTime(0, now)).toBe('');
    expect(dockTime(now - 20_000, now)).toBe('now');
    expect(dockTime(now - 5 * 60_000, now)).toBe('5m');
    expect(dockTime(now - 3 * 3_600_000, now)).toBe('3h');
    expect(dockTime(new Date(2026, 10, 9, 20, 0).getTime(), now)).toBe('Yesterday');
  });

  it('marks unread bots and waiting questions in the list', () => {
    const html = renderToStaticMarkup(
      <BotDockList
        loaded
        error=""
        selectedId={null}
        onOpen={() => undefined}
        bots={[bot({ name: 'Clara', unread: true, questions: 2, last_reply: { text: 'Invoice posted', at: '2026-11-10 14:00:00' } }), bot({ name: 'Finn' })]}
      />,
    );
    expect(html).toContain('aria-label="Clara, unread, 2 waiting questions"');
    expect(html).toContain('Invoice posted');
    expect(html).toContain('aria-label="Finn"');
    expect(html.match(/data-unread-dot/g)).toHaveLength(1);
    expect(html.indexOf('Clara')).toBeLessThan(html.indexOf('Finn'));
  });

  it('pops a bot out to its own route', () => {
    expect(popOutHash('abc-123')).toBe('#/popout/abc-123');
  });
});
