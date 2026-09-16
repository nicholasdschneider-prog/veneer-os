import { renderToStaticMarkup } from 'react-dom/server';
import { BrowserStartingState } from './BrowserStartingState';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VeneerBrowserProfile, VeneerBrowserSession } from '../../lib/types';
import {
  ADVANCED_CAPTURE_CONFIRM,
  ConversationBrowserPanel,
  avatarRingVisible,
  browserMenuModel,
  conversationBrowserViewerPath,
  fetchConversationCaptureGrant,
  parseViewerMessage,
  VIEWER_OVERLAY_FADE_MS,
  VIEWER_FIRST_FRAME_DEADLINE_MS,
  savedProfileUpdatePresentation,
  shouldShowConversationBrowserViewer,
  tabListModel,
  toggleConversationCaptureGrant,
} from './ConversationBrowserPanel';
import type { BrowserMenuItem } from './ConversationBrowserPanel';

const baseSession: VeneerBrowserSession = {
  configured: true,
  active: false,
  projectId: 'project-1',
  profileId: 'profile-1',
  profileName: 'Sam Personal',
  status: 'stopped',
  inUseByAnotherChat: false,
  temporaryClone: false,
  fresh: false,
  canUpdateProfile: false,
  startedAt: null,
  lastUsedAt: null,
  error: null,
};

const runningClone: VeneerBrowserSession = {
  ...baseSession,
  active: true,
  status: 'active',
  temporaryClone: true,
};

const samProfile: VeneerBrowserProfile = {
  id: 'profile-1',
  projectId: 'project-1',
  name: 'Sam Personal',
  active: false,
  status: 'stopped',
  activeConversationId: null,
  activeConversationTitle: null,
  activeCloneCount: 0,
  lastUsedAt: null,
  createdAt: '2026-08-01T00:00:00.000Z',
};

const viewerTabs = [
  { targetId: 'tab-a', title: 'Mail', url: 'https://mail.example.com/inbox' },
  { targetId: 'tab-b', title: 'Docs', url: 'https://docs.example.com/spec' },
];

const CAPTURE_URL = '/api/veneer-browser/conversations/chat-one/capture';

const MENU_DEFAULTS = { capture: false, updateState: 'idle' as const, profiles: [], tabCount: null };

function menuIds(items: BrowserMenuItem[]): string[] {
  return items.filter((item) => item.kind !== 'separator' && item.kind !== 'label').map((item) => item.id);
}

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as Response;
}

/**
 * `useMediaQuery` reads `window.matchMedia` while rendering, and these tests
 * render on the server with no window at all — which reads as mobile. Stub one
 * so either layout can be rendered.
 */
function stubLayout(desktop: boolean) {
  const mql = { matches: desktop, media: '', addEventListener() {}, removeEventListener() {} };
  vi.stubGlobal('window', { matchMedia: () => mql });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ConversationBrowserPanel', () => {
  it('changes the authenticated viewer address when the active chat changes', () => {
    expect(conversationBrowserViewerPath('chat-one', 'desktop')).toBe(
      '/veneer-browser?conversation=chat-one&chrome=off&tabs=off&host=desktop',
    );
    expect(conversationBrowserViewerPath('chat-two', 'desktop')).toBe(
      '/veneer-browser?conversation=chat-two&chrome=off&tabs=off&host=desktop',
    );
    expect(conversationBrowserViewerPath('chat/unsafe', 'desktop')).toContain('chat%2Funsafe');
    expect(conversationBrowserViewerPath('chat-one', 'desktop')).not.toContain('project=');
    expect(conversationBrowserViewerPath('chat-one', 'desktop')).not.toContain('profile=');
  });

  it('tells the viewer which host chrome to reserve room for', () => {
    expect(conversationBrowserViewerPath('chat-one', 'mobile')).toBe(
      '/veneer-browser?conversation=chat-one&chrome=off&tabs=off&host=mobile',
    );

    // The layout is baked into the frame's src, so switching sizes has to
    // remount the frame rather than leave a viewer reserving the wrong gutters.
    stubLayout(true);
    const desktop = renderToStaticMarkup(
      <ConversationBrowserPanel
        conversationId="chat-one"
        onClose={vi.fn()}
        onToast={vi.fn()}
        initialSession={runningClone}
      />,
    );
    expect(desktop).toContain('host=desktop');
    vi.unstubAllGlobals();

    stubLayout(false);
    const mobile = renderToStaticMarkup(
      <ConversationBrowserPanel
        conversationId="chat-one"
        onClose={vi.fn()}
        onToast={vi.fn()}
        initialSession={runningClone}
      />,
    );
    expect(mobile).toContain('host=mobile');
  });

  it('closes the viewer before a browser action changes the working copy', () => {
    const active = { ...baseSession, active: true, status: 'active' as const, temporaryClone: true };
    expect(shouldShowConversationBrowserViewer(active, false)).toBe(true);
    expect(shouldShowConversationBrowserViewer(active, true)).toBe(false);
  });

  it('renders a chat-owned browser column', () => {
    const html = renderToStaticMarkup(
      <ConversationBrowserPanel conversationId="chat-one" onClose={vi.fn()} onToast={vi.fn()} />,
    );
    expect(html).toContain('aria-label="Chat Veneer Browser"');
    expect(html).toContain('aria-label="Close browser"');
    expect(html).not.toContain('Browser for this chat');
  });

  it('shows the orb, not a globe, on the ready-to-open empty state', () => {
    const html = renderToStaticMarkup(
      <ConversationBrowserPanel
        conversationId="chat-one"
        onClose={vi.fn()}
        onToast={vi.fn()}
        initialSession={baseSession}
        initialProfiles={[samProfile]}
      />,
    );
    // The large brand globe is gone; the empty state carries the orb canvas.
    expect(html).toContain('Open browser');
    expect(html).toContain('<canvas');
    expect(html).not.toContain('size-18 shrink-0 text-brand');
  });

  it('opens a saved login without working-copy language', () => {
    const html = renderToStaticMarkup(
      <ConversationBrowserPanel
        conversationId="chat-one"
        onClose={vi.fn()}
        onToast={vi.fn()}
        initialSession={baseSession}
        initialProfiles={[samProfile]}
      />,
    );
    expect(html).toContain('Open browser');
    expect(html).toContain('Open signed-out');
    expect(html).toContain('Sam Personal');
    expect(html).not.toContain('Open working copy');
    expect(html).not.toContain('working copy');
    expect(html).not.toContain('isolated working copy');
    expect(html).not.toContain('>Veneer Browser<');
    expect(html).not.toContain('Browser for this chat');
  });

  it('shows the large searching orb while the browser starts', () => {
    const html = renderToStaticMarkup(
      <ConversationBrowserPanel
        conversationId="chat-one"
        onClose={vi.fn()}
        onToast={vi.fn()}
        initialSession={{ ...baseSession, status: 'starting', active: false }}
        initialProfiles={[samProfile]}
      />,
    );
    expect(html).toContain('data-testid="browser-starting"');
    expect(html).toContain('<canvas');
    expect(html).toContain('data-orb-state="searching"');
    expect(html).toContain('Starting your browser');
    expect(html).toContain('Warming up Chrome');
    expect(html).not.toContain('Open browser');
  });

  it('gives the loading screen its own close X when onClose is provided (mobile), and none otherwise', () => {
    // The panel passes onClose only on mobile; the close itself lives on the
    // start-up component, so assert it there.
    const withClose = renderToStaticMarkup(<BrowserStartingState onClose={vi.fn()} />);
    expect(withClose).toContain('data-testid="browser-starting"');
    expect(withClose).toContain('aria-label="Close browser"');
    const withoutClose = renderToStaticMarkup(<BrowserStartingState />);
    expect(withoutClose).not.toContain('aria-label="Close browser"');
  });

  it('renders the loading orb as a crisp sized canvas', () => {
    const html = renderToStaticMarkup(<BrowserStartingState />);
    expect(html).toContain('<canvas');
    expect(html).toContain('data-testid="browser-starting"');
  });

  it('covers the iframe with the orb from mount, so there is no black flash', () => {
    expect(VIEWER_OVERLAY_FADE_MS).toBeGreaterThan(0);
    const html = renderToStaticMarkup(
      <ConversationBrowserPanel
        conversationId="chat-one"
        onClose={vi.fn()}
        onToast={vi.fn()}
        initialSession={{ ...baseSession, status: 'active', active: true }}
        initialProfiles={[samProfile]}
      />,
    );
    // The iframe is mounted, but the opaque orb overlay sits over it right away.
    expect(html).toContain('<iframe');
    expect(html).toContain('data-testid="browser-starting"');
    expect(html).toContain('vp-browser-overlay');
  });

  it('clears the start-up screen on the first frame or tab list, and caps the wait at 6s', () => {
    expect(VIEWER_FIRST_FRAME_DEADLINE_MS).toBe(6000);
    expect(parseViewerMessage({ source: 'veneer-browser-viewer', t: 'frame' })).toEqual({
      source: 'veneer-browser-viewer',
      t: 'frame',
    });
    // Tabs are parsed but do not by themselves clear the loading orb.
    expect(parseViewerMessage({ source: 'veneer-browser-viewer', t: 'targets', list: [], activeId: null })).toMatchObject({
      t: 'targets',
    });
  });

  it('reopens a stopped browser without copy jargon', () => {
    const html = renderToStaticMarkup(
      <ConversationBrowserPanel
        conversationId="chat-one"
        onClose={vi.fn()}
        onToast={vi.fn()}
        initialSession={{ ...baseSession, temporaryClone: true }}
        initialProfiles={[samProfile]}
      />,
    );
    expect(html).toContain('Reopen browser');
    expect(html).toContain('This browser is stopped.');
    expect(html).not.toContain('Reopen copy');
    expect(html).not.toContain('temporary copy');
  });

  it('offers a signed-out browser when no login is selected', () => {
    const html = renderToStaticMarkup(
      <ConversationBrowserPanel
        conversationId="chat-one"
        onClose={vi.fn()}
        onToast={vi.fn()}
        initialSession={{ ...baseSession, profileId: null, profileName: null }}
      />,
    );
    expect(html).toContain('No saved login');
    expect(html).toContain('Open signed-out browser');
    expect(html).toContain('Opens signed out.');
  });

  it('separates update, save-as, and discard actions for a saved-profile copy', () => {
    const session = { ...runningClone, canUpdateProfile: true };
    const menu = browserMenuModel(session, MENU_DEFAULTS);
    const labels = menu.items.map((item) => ('label' in item ? item.label : ''));

    expect(menuIds(menu.items)).toEqual(['update-profile', 'save-as', 'capture', 'stop']);
    expect(labels).toContain('Update saved profile');
    expect(labels).toContain('Save as new profile…');
    expect(labels).toContain('Stop and discard');
    expect(menu.items.find((item) => item.id === 'stop')).toMatchObject({ kind: 'action', destructive: true });
    expect(menu.subtitle).not.toContain('Working copy');
    expect(menu.subtitle).not.toContain('working copy');
    expect(labels).not.toContain('Signed-out copy');
    expect(labels).not.toContain('Stop and Save Session');

    // The chip still names the profile the menu acts on.
    const html = renderToStaticMarkup(
      <ConversationBrowserPanel conversationId="chat-one" onClose={vi.fn()} onToast={vi.fn()} initialSession={session} />,
    );
    expect(html).toContain('Sam Personal');
    expect(html).not.toContain('Working copy');
    expect(html).not.toContain('working copy');
  });

  it('shows Updated after a saved profile update succeeds', () => {
    expect(savedProfileUpdatePresentation('idle')).toEqual({
      label: 'Update saved profile',
      showCheck: false,
      showSpinner: false,
    });
    expect(savedProfileUpdatePresentation('saving')).toEqual({
      label: 'Update saved profile',
      showCheck: false,
      showSpinner: true,
    });
    expect(savedProfileUpdatePresentation('updated')).toEqual({
      label: 'Updated',
      showCheck: true,
      showSpinner: false,
    });
  });

  it('does not offer to update a saved base from a signed-out copy', () => {
    const menu = browserMenuModel(
      {
        ...baseSession,
        profileId: null,
        profileName: 'Signed-out browser',
        temporaryClone: true,
        fresh: true,
      },
      MENU_DEFAULTS,
    );
    expect(menuIds(menu.items)).toEqual(['save-as', 'stop']);
    expect(menu.items.some((item) => item.id === 'update-profile')).toBe(false);
  });

  it('offers advanced capture only while the working copy is running', () => {
    const stopped = browserMenuModel({ ...baseSession, temporaryClone: true }, MENU_DEFAULTS);
    expect(menuIds(stopped.items)).toContain('stop');
    expect(menuIds(stopped.items)).not.toContain('capture');
    expect(stopped.subtitle).toBe('Browser stopped');

    const running = browserMenuModel(runningClone, MENU_DEFAULTS);
    expect(running.items).toContainEqual({
      id: 'capture',
      kind: 'toggle',
      label: 'Advanced capture',
      checked: false,
    });
    expect(running.subtitle).toBe('Browser open');
  });

  // `profiles` here is what the per-chat endpoint returned: the signed-in
  // user's own saved profiles, never anyone else's.
  it('lists the saved profiles to switch to, but only outside a working copy', () => {
    const menu = browserMenuModel(baseSession, { ...MENU_DEFAULTS, profiles: [samProfile], tabCount: 2 });
    expect(menuIds(menu.items)).toEqual(['profile:profile-1', 'profile:none']);
    expect(menu.items).toContainEqual({
      id: 'profile:profile-1',
      kind: 'profile',
      label: 'Sam Personal',
      profileId: 'profile-1',
      selected: true,
    });
    expect(menu.items.some((item) => item.kind === 'label' && item.label === 'Switch profile')).toBe(true);
    expect(menu.subtitle).toBe('Not open · 2 tabs');

    const clone = browserMenuModel(runningClone, { ...MENU_DEFAULTS, profiles: [samProfile] });
    expect(menuIds(clone.items).some((id) => id.startsWith('profile:'))).toBe(false);
  });

  it('shows the saved-profile update progress in the menu label', () => {
    const saving = browserMenuModel(
      { ...runningClone, canUpdateProfile: true },
      { ...MENU_DEFAULTS, updateState: 'saving' },
    );
    expect(saving.items[0]).toMatchObject({ id: 'update-profile', label: 'Update saved profile', showSpinner: true });

    const updated = browserMenuModel(
      { ...runningClone, canUpdateProfile: true },
      { ...MENU_DEFAULTS, updateState: 'updated' },
    );
    expect(updated.items[0]).toMatchObject({ id: 'update-profile', label: 'Updated', showCheck: true });
  });

  it('reflects the granted capture state read from the server', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({ ok: true, capture: { active: true } }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchConversationCaptureGrant('chat-one')).resolves.toEqual({ active: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(CAPTURE_URL);
    expect(init?.method).toBeUndefined();

    const menu = browserMenuModel(runningClone, { ...MENU_DEFAULTS, capture: true });
    expect(menu.items).toContainEqual({
      id: 'capture',
      kind: 'toggle',
      label: 'Advanced capture',
      checked: true,
    });
  });

  it('warns about credentialed traffic before granting capture', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({ ok: true, capture: { active: true } }));
    vi.stubGlobal('fetch', fetchMock);
    const confirm = vi.fn(() => true);

    await expect(toggleConversationCaptureGrant('chat-one', true, confirm)).resolves.toEqual({ active: true });
    expect(confirm).toHaveBeenCalledWith(ADVANCED_CAPTURE_CONFIRM);
    expect(ADVANCED_CAPTURE_CONFIRM).toContain('login tokens');
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(CAPTURE_URL);
    expect(init?.method).toBe('PUT');
    expect(init?.body).toBe(JSON.stringify({ active: true }));
  });

  it('grants nothing when the user declines the warning', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({ ok: true, capture: { active: true } }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(toggleConversationCaptureGrant('chat-one', true, () => false)).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('revokes capture without asking', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({ ok: true, capture: { active: false } }));
    vi.stubGlobal('fetch', fetchMock);
    const confirm = vi.fn(() => true);

    await expect(toggleConversationCaptureGrant('chat-one', false, confirm)).resolves.toEqual({ active: false });
    expect(confirm).not.toHaveBeenCalled();
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(CAPTURE_URL);
    expect(init?.method).toBe('PUT');
    expect(init?.body).toBe(JSON.stringify({ active: false }));
  });

  it('gives the desktop viewer a joined tab strip and no chip in the tab row', () => {
    stubLayout(true);
    const running = renderToStaticMarkup(
      <ConversationBrowserPanel
        conversationId="chat-one"
        onClose={vi.fn()}
        onToast={vi.fn()}
        initialSession={runningClone}
        initialTabs={viewerTabs}
        initialActiveTabId="tab-b"
      />,
    );
    expect(running).toContain('role="tablist"');
    expect(running).toContain('aria-label="Open tabs"');
    expect(running).toContain('aria-label="New tab"');
    expect(running).toContain('Mail');
    expect(running).toContain('aria-selected="true"');
    // Edge controls bookend the flexible tab strip, so neither one moves as
    // tabs are added or the panel narrows.
    expect(running.indexOf('aria-label="New tab"')).toBeLessThan(running.indexOf('role="tablist"'));
    expect(running.indexOf('aria-label="Close browser"')).toBeGreaterThan(running.indexOf('role="tablist"'));
    // The active tab merges into the address row with its inverted feet.
    expect(running).toContain('bg-background text-foreground before:absolute');
    expect(running).toContain('radial-gradient(circle_at_0_0,transparent_8px,var(--background)_8.5px)');
    // The tab row is only tabs: the profile lives in the overlay, not here.
    expect(running).not.toContain('bg-shell-sidebar');
    expect(running).toContain('bg-shell-rail');
    expect(running).not.toContain('Sam Personal</span>');

    // Close is now the right bookend; only the profile rides on the address row.
    expect(running).toContain('aria-label="Close browser"');
    expect(running).toContain('aria-label="Browser profile"');
  });

  it('keeps the plain chip toolbar whenever the viewer is not showing', () => {
    for (const desktop of [true, false]) {
      vi.unstubAllGlobals();
      stubLayout(desktop);
      const stopped = renderToStaticMarkup(
        <ConversationBrowserPanel
          conversationId="chat-one"
          onClose={vi.fn()}
          onToast={vi.fn()}
          initialSession={baseSession}
          initialProfiles={[samProfile]}
        />,
      );
      expect(stopped).toContain('Sam Personal');
      expect(stopped).toContain('bg-shell-sidebar');
      expect(stopped).toContain('aria-label="Close browser"');
      expect(stopped).not.toContain('role="tablist"');
      expect(stopped).not.toContain('aria-label="New tab"');
      expect(stopped).not.toContain('open tabs');
    }
  });

  it('trades the mobile toolbar for a tab-count button on the address row', () => {
    stubLayout(false);
    const running = renderToStaticMarkup(
      <ConversationBrowserPanel
        conversationId="chat-one"
        onClose={vi.fn()}
        onToast={vi.fn()}
        initialSession={runningClone}
        initialTabs={viewerTabs}
        initialActiveTabId="tab-b"
      />,
    );
    expect(running).toContain('aria-label="2 open tabs"');
    expect(running).toContain('aria-label="Browser profile"');
    expect(running).toContain('aria-label="Close browser"');
    // No header row at all: the tabs are a menu, not a strip.
    expect(running).not.toContain('role="tablist"');
    expect(running).not.toContain('bg-shell-sidebar');
    expect(running).not.toContain('bg-shell-rail');
  });

  it('keeps the browser clear of the iOS status bar on small screens', () => {
    stubLayout(false);
    const running = renderToStaticMarkup(
      <ConversationBrowserPanel
        conversationId="chat-one"
        onClose={vi.fn()}
        onToast={vi.fn()}
        initialSession={runningClone}
      />,
    );
    expect(running).toContain('pt-[calc(env(safe-area-inset-top)+1.25rem)]');

    const stopped = renderToStaticMarkup(
      <ConversationBrowserPanel
        conversationId="chat-one"
        onClose={vi.fn()}
        onToast={vi.fn()}
        initialSession={baseSession}
      />,
    );
    expect(stopped).toContain('pt-[calc(env(safe-area-inset-top)+1.25rem)] md:pt-0');
    expect(stopped).toContain('min-h-11');

    const loading = renderToStaticMarkup(
      <ConversationBrowserPanel conversationId="chat-one" onClose={vi.fn()} onToast={vi.fn()} />,
    );
    expect(loading).toContain('top-[calc(env(safe-area-inset-top)+0.5rem)]');
    expect(loading).toContain('md:top-2');
  });

  it('names every tab the same way for the strip and the list', () => {
    expect(tabListModel(viewerTabs, 'tab-b')).toEqual([
      { targetId: 'tab-a', title: 'Mail', host: 'mail.example.com', active: false },
      { targetId: 'tab-b', title: 'Docs', host: 'docs.example.com', active: true },
    ]);

    // A blank tab reads as a new tab with no host at all.
    expect(tabListModel([{ targetId: 'tab-c', url: 'about:blank' }], null)).toEqual([
      { targetId: 'tab-c', title: 'New Tab', host: '', active: false },
    ]);
    expect(tabListModel([{ targetId: 'tab-c', title: 'about:blank' }], 'tab-c')).toEqual([
      { targetId: 'tab-c', title: 'New Tab', host: '', active: true },
    ]);

    // An untitled page falls back to its host, and an unparseable address to
    // the raw string rather than blowing up the strip.
    expect(tabListModel([{ targetId: 'tab-d', url: 'https://example.com/deep/path' }], null)).toEqual([
      { targetId: 'tab-d', title: 'example.com', host: 'example.com', active: false },
    ]);
    expect(tabListModel([{ targetId: 'tab-e', url: 'not a url' }], null)).toEqual([
      { targetId: 'tab-e', title: 'not a url', host: 'not a url', active: false },
    ]);
    expect(tabListModel([], 'tab-a')).toEqual([]);
  });

  it('rings the avatar only while a saved login is live', () => {
    expect(avatarRingVisible({ ...baseSession, active: true })).toBe(true);
    expect(avatarRingVisible(baseSession)).toBe(false);
    expect(avatarRingVisible({ ...baseSession, active: true, profileId: null })).toBe(false);
    expect(avatarRingVisible(null)).toBe(false);

    stubLayout(true);
    const live = renderToStaticMarkup(
      <ConversationBrowserPanel
        conversationId="chat-one"
        onClose={vi.fn()}
        onToast={vi.fn()}
        initialSession={runningClone}
      />,
    );
    expect(live).toContain('ring-emerald-500');

    vi.unstubAllGlobals();
    stubLayout(true);
    const signedOut = renderToStaticMarkup(
      <ConversationBrowserPanel
        conversationId="chat-one"
        onClose={vi.fn()}
        onToast={vi.fn()}
        initialSession={{ ...runningClone, profileId: null, profileName: null, fresh: true }}
      />,
    );
    expect(signedOut).not.toContain('ring-emerald-500');
  });

  it('reads tabs only from well-formed viewer messages', () => {
    expect(parseViewerMessage({ source: 'veneer-browser-viewer', t: 'frame' })).toEqual({
      source: 'veneer-browser-viewer',
      t: 'frame',
    });
    expect(parseViewerMessage({ source: 'veneer-browser-viewer', t: 'ready' })).toEqual({
      source: 'veneer-browser-viewer',
      t: 'ready',
    });
    expect(
      parseViewerMessage({
        source: 'veneer-browser-viewer',
        t: 'targets',
        list: [
          { targetId: 'a', title: 'Mail', url: 'https://mail.example' },
          { targetId: 'b' },
          { title: 'no id' },
          null,
        ],
        activeId: 'b',
      }),
    ).toEqual({
      source: 'veneer-browser-viewer',
      t: 'targets',
      list: [
        { targetId: 'a', title: 'Mail', url: 'https://mail.example' },
        { targetId: 'b', title: undefined, url: undefined },
      ],
      activeId: 'b',
    });
    expect(
      parseViewerMessage({ source: 'veneer-browser-viewer', t: 'targets', list: [], activeId: 7 }),
    ).toEqual({ source: 'veneer-browser-viewer', t: 'targets', list: [], activeId: null });

    expect(parseViewerMessage(null)).toBeNull();
    expect(parseViewerMessage('targets')).toBeNull();
    expect(parseViewerMessage({ source: 'other-embed', t: 'targets', list: [] })).toBeNull();
    expect(parseViewerMessage({ source: 'veneer-browser-viewer', t: 'nope' })).toBeNull();
    expect(parseViewerMessage({ source: 'veneer-browser-viewer', t: 'targets' })).toBeNull();
  });

  it('surfaces a rejected capture grant as an error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ ok: false, error: 'not allowed' }, 403)));
    await expect(fetchConversationCaptureGrant('chat-one')).rejects.toThrow('not allowed');
  });
});
