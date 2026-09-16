import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ChatArchiveButton } from './ChatArchiveButton';

function renderButton(archived: boolean, canManage = true, busy = false) {
  return renderToStaticMarkup(
    <ChatArchiveButton
      archived={archived}
      canManage={canManage}
      busy={busy}
      onArchive={vi.fn()}
    />,
  );
}

describe('ChatArchiveButton', () => {
  it('renders a direct accessible Archive action for an active manageable chat', () => {
    const html = renderButton(false);

    expect(html).toContain('aria-label="Archive chat"');
    expect(html).toContain('title="Archive chat"');
    expect(html).toContain('lucide-archive');
    expect(html).not.toContain('lucide-archive-restore');
    expect(html).toContain('pointer-fine:hidden absolute top-1/2 left-1/2 size-[max(100%,3rem)]');
  });

  it('renders Move to Chats for an archived manageable chat', () => {
    const html = renderButton(true);

    expect(html).toContain('aria-label="Move to Chats"');
    expect(html).toContain('title="Move to Chats"');
    expect(html).toContain('lucide-archive-restore');
  });

  it('does not render for a viewer without management permission', () => {
    expect(renderButton(false, false)).toBe('');
  });

  it('disables the action while another chat management action is running', () => {
    expect(renderButton(false, true, true)).toContain('disabled=""');
  });
});
