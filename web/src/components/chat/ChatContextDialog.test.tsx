import { renderToStaticMarkup } from 'react-dom/server';
import { DropdownMenu as DropdownMenuPrimitive } from 'radix-ui';
import { describe, expect, it } from 'vitest';
import { ChatContextDialog, ChatInfoMenuItem } from './ChatContextDialog';

describe('ChatContextDialog', () => {
  it('uses the chat title as the mobile context trigger', () => {
    const html = renderToStaticMarkup(
      <ChatContextDialog conversationId="chat-one" trigger="mobile-title" mobileTitle="Mobile chat" />,
    );

    expect(html).toContain('aria-label="View chat context for Mobile chat"');
    expect(html).toContain('md:hidden');
    expect(html).toContain('Mobile chat');
    expect(html).toContain('size-[max(100%,3rem)]');
    expect(html).not.toContain('lucide-braces');
  });

  it('renders Chat info as a menu item instead of a separate icon button', () => {
    const html = renderToStaticMarkup(
      <DropdownMenuPrimitive.Root open>
        <DropdownMenuPrimitive.Content forceMount>
          <ChatInfoMenuItem onSelect={() => undefined} />
        </DropdownMenuPrimitive.Content>
      </DropdownMenuPrimitive.Root>,
    );

    expect(html).toContain('role="menuitem"');
    expect(html).toContain('Chat info');
    expect(html).toContain('lucide-braces');
    expect(html).not.toContain('aria-label="View chat context"');
  });
});
