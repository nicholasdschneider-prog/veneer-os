import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { VeneerBrowserOtherProfile, VeneerBrowserProfile } from '../../lib/types';
import {
  ActiveBrowserSessions,
  browserChatHref,
  OtherPeoplesProfiles,
  ProjectBrowserPanel,
} from './ProjectBrowserPanel';

describe('ProjectBrowserPanel', () => {
  it('renders project profile management without a project-level live viewer', () => {
    const html = renderToStaticMarkup(
      <ProjectBrowserPanel projectId="project-1" onClose={vi.fn()} onToast={vi.fn()} />,
    );
    expect(html).toContain('Veneer Browser');
    expect(html).toContain('Browser profile');
    expect(html).toContain('Create profile');
    expect(html).toContain('Your browser profiles');
    expect(html).not.toContain('Other people’s profiles');
    expect(html).toContain('aria-label="Close browser"');
    expect(html).not.toContain('<iframe');
    expect(html).not.toContain('no-sandbox');
  });

  it('links every owned active profile to its authenticated chat browser view', () => {
    const profiles: VeneerBrowserProfile[] = [
      {
        id: 'profile-one', projectId: 'project-1', name: 'Sam Personal', active: true, status: 'active',
        activeConversationId: 'chat-one', activeConversationTitle: 'Research chat', activeCloneCount: 1,
        lastUsedAt: null, createdAt: '2026-01-01',
      },
      {
        id: 'legacy-profile', projectId: 'project-1', name: 'Older browser', active: true, status: 'active',
        activeConversationId: null, activeConversationTitle: null, activeCloneCount: 0,
        lastUsedAt: null, createdAt: '2026-01-01',
      },
      {
        id: 'stopped-profile', projectId: 'project-1', name: 'Stopped browser', active: false, status: 'stopped',
        activeConversationId: null, activeConversationTitle: null, activeCloneCount: 0,
        lastUsedAt: null, createdAt: '2026-01-01',
      },
    ];
    const html = renderToStaticMarkup(<ActiveBrowserSessions projectId="project-1" profiles={profiles} />);
    expect(html).toContain('Active chat browsers');
    expect(html).toContain('Research chat');
    expect(html).toContain('1 temporary copy');
    expect(html).toContain('Active browser');
    expect(html).not.toContain('Stopped browser');
    expect(html).toContain('href="#/chat/chat-one?project=project-1&amp;browser=project-1"');
    expect(html).not.toContain('browser.veneer.app');
  });

  it('offers owners a delete-only view of other people’s profiles', () => {
    const others: VeneerBrowserOtherProfile[] = [
      {
        id: 'other-one', projectId: 'project-1', name: 'Sales login', active: false, status: 'stopped',
        activeConversationId: null, activeConversationTitle: null, activeCloneCount: 0,
        lastUsedAt: null, createdAt: '2026-01-01', ownerUserId: 7, ownerName: 'Dana Lee',
      },
      {
        id: 'other-two', projectId: 'project-1', name: 'Live login', active: true, status: 'active',
        activeConversationId: null, activeConversationTitle: null, activeCloneCount: 0,
        lastUsedAt: null, createdAt: '2026-01-01', ownerUserId: 9, ownerName: 'Sam Ito',
      },
    ];
    const html = renderToStaticMarkup(
      <OtherPeoplesProfiles profiles={others} busy={false} onDelete={vi.fn()} />,
    );
    expect(html).toContain('Other people’s profiles');
    expect(html).toContain('Sales login');
    expect(html).toContain('Dana Lee');
    expect(html).toContain('Delete');
    expect(html).toContain('aria-label="Delete Sales login from Dana Lee"');
    // Delete is the only action; a profile in use cannot be deleted yet.
    expect(html).not.toContain('Rename');
    expect(html).not.toContain('default');
    expect(html.match(/disabled=""/g)).toHaveLength(1);
  });

  it('renders nothing for other people when there are none', () => {
    expect(renderToStaticMarkup(<OtherPeoplesProfiles profiles={[]} busy={false} onDelete={vi.fn()} />)).toBe('');
  });

  it('encodes chat and project values in the browser navigation link', () => {
    expect(browserChatHref('project one', 'chat/one')).toBe(
      '#/chat/chat%2Fone?project=project+one&browser=project+one',
    );
  });
});
