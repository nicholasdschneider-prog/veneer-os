import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { EmployeeWorkspace } from './EmployeeWorkspace';

vi.mock('./Bots', () => ({ Bots: ({ restricted, decisionId }: { restricted: boolean; decisionId?: string }) => <div data-overview={restricted} data-decision={decisionId} /> }));
vi.mock('@/components/layout/SplitView', () => ({ SplitView: ({ sidebar, children }: { sidebar: React.ReactNode; children: React.ReactNode }) => <>{sidebar}{children}</> }));
vi.mock('@/components/BotConversationRail', () => ({ BotConversationRail: ({ selectedId, restricted }: { selectedId: string; restricted: boolean }) => <aside data-selected={selectedId} data-restricted={restricted} /> }));
vi.mock('@/components/chat/ChatWorkspace', () => ({ ChatWorkspace: (props: { conversationId: string; restricted: boolean; backHash: string; focusMessageId: string | null; projectBrowserId: string | null; projectFilesId: string | null }) => <section data-native-chat={props.conversationId} data-restricted={props.restricted} data-back={props.backHash} data-message={props.focusMessageId} data-browser={props.projectBrowserId} data-files={props.projectFilesId} /> }));

const render = (hash: string) => renderToStaticMarkup(<EmployeeWorkspace hash={hash} email="employee@example.com" onNavigate={vi.fn()} onToast={vi.fn()} />);

describe('employee bot navigation', () => {
  it('opens an existing bot in the native chat workspace with its bot sidebar and message deep link', () => {
    const html = render('#/chat/grant?from=bots&message=message-1');
    expect(html).toContain('data-native-chat="grant"');
    expect(html).toContain('data-selected="grant"');
    expect(html).toContain('data-restricted="true"');
    expect(html).toContain('data-back="#/bots"');
    expect(html).toContain('data-message="message-1"');
    expect(html).not.toContain('data-overview');
  });

  it.each(['#/bots', '#/messages', '#/chat/new', '#/settings', '#/chat/grant/extra'])('keeps %s in the restricted Chats list', hash => {
    const html = render(hash);
    expect(html).toContain('<aside data-restricted="true"');
    expect(html).not.toContain('data-overview');
    expect(html).not.toContain('data-native-chat');
  });

  it('keeps the bot work overview accessible', () => {
    expect(render('#/bots?view=work')).toContain('data-overview="true"');
  });

  it('preserves decision links and does not open platform panels from query parameters', () => {
    expect(render('#/bots/decision-1')).toContain('data-decision="decision-1"');
    const html = render('#/chat/grant?browser=project-1&files=project-1&side=another-chat');
    expect(html).toContain('data-native-chat="grant"');
    expect(html).not.toContain('data-browser=');
    expect(html).not.toContain('data-files=');
  });
});
