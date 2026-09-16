import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { NewChatPlaceholderRow } from './NewChatPlaceholderRow';

describe('NewChatPlaceholderRow', () => {
  it('shows an accessible starting state with three animated dots', () => {
    const html = renderToStaticMarkup(
      <NewChatPlaceholderRow status="starting" selected onOpen={vi.fn()} />,
    );

    expect(html).toContain('aria-label="New chat, starting"');
    expect(html).toContain('aria-current="true"');
    expect(html).toContain('vp-starting-ellipsis');
    expect(html.match(/<span>\.<\/span>/g)).toHaveLength(3);
  });

  it('shows a clear failure state', () => {
    const html = renderToStaticMarkup(
      <NewChatPlaceholderRow status="failed" onOpen={vi.fn()} />,
    );

    expect(html).toContain('aria-label="New chat, could not start"');
    expect(html).toContain('Could not start');
  });
});
