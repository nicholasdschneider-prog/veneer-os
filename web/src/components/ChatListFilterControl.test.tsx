import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { ChatListFilterControl } from './ChatListFilterControl';

function render(filter: 'all' | 'unread', unreadCount: number) {
  return renderToStaticMarkup(
    <ChatListFilterControl filter={filter} unreadCount={unreadCount} onChange={vi.fn()} />,
  );
}

describe('ChatListFilterControl', () => {
  it('exposes both segments as a labelled pressed-state group', () => {
    const html = render('all', 0);

    expect(html).toContain('role="group"');
    expect(html).toContain('aria-label="Show"');
    expect(html).toContain('>All<');
    expect(html).toContain('Unread');
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
  });

  it('marks the selected segment and leaves the other muted', () => {
    const unread = render('unread', 3);

    expect(unread).toMatch(/aria-pressed="true"[^>]*bg-background text-foreground shadow-sm/);
    expect(unread).toMatch(/aria-pressed="false"[^>]*text-muted-foreground/);
  });

  it('badges the unread count, filled when the segment is selected', () => {
    expect(render('unread', 3)).toContain('bg-primary text-primary-foreground');
    expect(render('all', 3)).toContain('bg-primary/15 text-primary');
    expect(render('all', 3)).toContain('>3<');
  });

  it('hides the badge when nothing is unread', () => {
    const html = render('all', 0);

    expect(html).not.toContain('bg-primary/15');
    expect(html).not.toContain('>0<');
  });

  it('stays put in a narrow sidebar', () => {
    expect(render('all', 0)).toContain('shrink-0');
  });
});
