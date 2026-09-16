import { renderToStaticMarkup } from 'react-dom/server';
import { DropdownMenu as DropdownMenuPrimitive } from 'radix-ui';
import { describe, expect, it, vi } from 'vitest';
import { chatHeaderMenuLabels } from '../../lib/chatDeletion';
import { ChatHeaderMenuItems } from './ChatHeaderMenuItems';

function renderMenu(canManage: boolean) {
  return renderToStaticMarkup(
    <DropdownMenuPrimitive.Root open>
      <DropdownMenuPrimitive.Content forceMount>
        <ChatHeaderMenuItems
          labels={chatHeaderMenuLabels(canManage, false)}
          pinned={false}
          compaction={{ supported: true, disabled: false, busy: false }}
          onInfo={vi.fn()}
          onCopyLink={vi.fn()}
          onOpenBrowser={vi.fn()}
          onCompact={vi.fn()}
          onTogglePin={vi.fn()}
          onDelete={vi.fn()}
        />
      </DropdownMenuPrimitive.Content>
    </DropdownMenuPrimitive.Root>,
  );
}

describe('ChatHeaderMenuItems', () => {
  it('puts Compact context near Pin and uses one separator directly above Delete chat', () => {
    const html = renderMenu(true);
    const info = html.indexOf('Chat info');
    const copy = html.indexOf('Copy link');
    const openBrowser = html.indexOf('Open browser');
    const compact = html.indexOf('Compact context');
    const pin = html.indexOf('Pin chat');
    const separator = html.indexOf('data-slot="dropdown-menu-separator"');
    const deleteChat = html.indexOf('Delete chat…');

    expect(info).toBeGreaterThan(-1);
    expect(info).toBeLessThan(copy);
    expect(copy).toBeLessThan(openBrowser);
    expect(openBrowser).toBeLessThan(compact);
    expect(compact).toBeLessThan(pin);
    expect(pin).toBeLessThan(separator);
    expect(separator).toBeLessThan(deleteChat);
    expect(html.match(/data-slot="dropdown-menu-separator"/g)).toHaveLength(1);
  });

  it('keeps Copy link available to viewers without management actions', () => {
    const html = renderMenu(false);

    expect(html).toContain('Chat info');
    expect(html).toContain('Copy link');
    expect(html).toContain('Open browser');
    expect(html).not.toContain('Pin chat');
    expect(html).not.toContain('Compact context');
    expect(html).not.toContain('Delete chat…');
    expect(html).not.toContain('data-slot="dropdown-menu-separator"');
  });

  it('hides Open browser when the chat has no browser action', () => {
    const html = renderToStaticMarkup(
      <DropdownMenuPrimitive.Root open>
        <DropdownMenuPrimitive.Content forceMount>
          <ChatHeaderMenuItems
            labels={chatHeaderMenuLabels(false, false)}
            pinned={false}
            compaction={{ supported: true, disabled: false, busy: false }}
            onInfo={vi.fn()}
            onCopyLink={vi.fn()}
            onCompact={vi.fn()}
            onTogglePin={vi.fn()}
            onDelete={vi.fn()}
          />
        </DropdownMenuPrimitive.Content>
      </DropdownMenuPrimitive.Root>,
    );

    expect(html).not.toContain('Open browser');
  });

  it('keeps unavailable providers explicit and disabled', () => {
    const html = renderToStaticMarkup(
      <DropdownMenuPrimitive.Root open>
        <DropdownMenuPrimitive.Content forceMount>
          <ChatHeaderMenuItems
            labels={chatHeaderMenuLabels(true, false)}
            pinned={false}
            compaction={{ supported: false, disabled: true, busy: false }}
            onInfo={vi.fn()}
            onCopyLink={vi.fn()}
            onOpenBrowser={vi.fn()}
            onCompact={vi.fn()}
            onTogglePin={vi.fn()}
            onDelete={vi.fn()}
          />
        </DropdownMenuPrimitive.Content>
      </DropdownMenuPrimitive.Root>,
    );

    expect(html).toContain('Context compaction unavailable');
    expect(html).toContain('data-disabled');
  });
});
