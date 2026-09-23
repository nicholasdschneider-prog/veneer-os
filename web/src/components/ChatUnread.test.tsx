import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChatUnread } from './ChatUnread';
import { isPeopleConversation } from '@/lib/teamRooms';
const human = { key: 'user:1', name: 'Human', kind: 'human' as const };
const bot = { key: 'bot:one', name: 'Bot', kind: 'bot' as const };
describe('People and Bots unread indicators', () => {
  it('keeps mixed groups with People and solo bot groups with Bots', () => {
    expect(isPeopleConversation({ members: [human, { ...human, key: 'user:2' }] })).toBe(true);
    expect(isPeopleConversation({ members: [human, { ...human, key: 'user:2' }, bot] })).toBe(true);
    expect(isPeopleConversation({ members: [human, bot] })).toBe(false);
  });
  it('labels both counts without relying on color and hides empty badges', () => {
    const html = renderToStaticMarkup(<ChatUnread people={2} bots={3} />);
    expect(html).toContain('2 unread people conversations, 3 unread bot conversations');
    expect(html).toContain('lucide-users');
    expect(html).toContain('lucide-bot');
    expect(renderToStaticMarkup(<ChatUnread people={0} bots={0} />)).not.toContain('<svg');
  });
});
