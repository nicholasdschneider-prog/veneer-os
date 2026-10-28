import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MobileChatHeader } from './MobileChatHeader';
import { ChatTasksToggle } from './ChatTasksToggle';

describe('mobile chat header', () => {
  it('shows the Chat | Tasks toggle on phones as its own row under the title', () => {
    const html = renderToStaticMarkup(
      <MobileChatHeader id="tess" name="Tess" onBack={() => {}} toolbar={<ChatTasksToggle conversationId="tess" view="chat" onNavigate={() => {}} />}>
        <span />
      </MobileChatHeader>,
    );
    expect(html).toContain('md:hidden');
    expect(html).toContain('aria-label="Chat or tasks"');
    expect(html).toContain('col-span-3');
    expect(html).toContain('>Tasks<');
  });
  it('leaves the header unchanged for chats without the toggle', () => {
    const html = renderToStaticMarkup(<MobileChatHeader id="x" name="X" onBack={() => {}}><span /></MobileChatHeader>);
    expect(html).not.toContain('Chat or tasks');
  });
});
