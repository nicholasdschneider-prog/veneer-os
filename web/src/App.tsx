import { lazy, Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { api } from './lib/api';
import type { Me, WorkspaceNavigation } from './lib/types';
import { Setup } from './screens/Setup';
import { PendingApproval } from './screens/PendingApproval';
import { ChatList } from './screens/ChatList';
import { Todos } from './screens/Todos';
import { Scheduled } from './screens/Scheduled';
import { ChatWorkspace } from './components/chat/ChatWorkspace';
import { ProjectView } from './screens/ProjectView';
import { Settings, type SettingsSection } from './screens/Settings';
import { Files } from './screens/Files';
import { Pages } from './screens/Pages';
import { Apps } from './screens/Apps';
import { FileBrowser } from './screens/FileBrowser';
import { Tools } from './screens/Tools';
import { TerminalScreen } from './screens/Terminal';
import { Button } from '@/components/ui/button';
import { Toast, type ToastAction } from '@/components/ui/toast';
import { useDismissTokenCards } from '@/hooks/useDismissTokenCards';
import { NavShell, type NavSelection } from './components/NavBar';
import { SplitView, SplitPlaceholder } from './components/layout/SplitView';
import { useMediaQuery } from './hooks/useMediaQuery';
import { applyPageTitle } from './lib/pageTitle';
import { setPagesPublicBase } from './lib/artifacts';
import {
  hashWithProjectFiles,
  projectFileLocationFromParams,
  type ProjectFileLocation,
} from './lib/projectFilesRoute';
import { clearLegacyTerminalPin, isLegacyTerminalPinned } from './lib/pinnedTerminal';
import { DEFAULT_WORKSPACE_NAVIGATION, miniAppIdFromPath } from './lib/navigation';
import { useFloatingDesktop } from './components/desktop/FloatingDesktop';
import { ProjectBrowserPanel } from './components/browser/ProjectBrowserPanel';

const THREE_PANE_QUERY = '(min-width: 1180px)';
const LiveVoice = lazy(() => import('./screens/LiveVoice').then(module => ({ default: module.LiveVoice })));

const SETTINGS_ALIASES: Record<string, { section: Exclude<SettingsSection, 'index'>; tab?: string }> = {
  accounts: { section: 'providers', tab: 'providers' },
  chat: { section: 'providers' },
  chats: { section: 'providers', tab: 'history' },
  chattitles: { section: 'providers', tab: 'history' },
  voice: { section: 'providers', tab: 'voice' },
  connectors: { section: 'connections', tab: 'apps' },
  apikeys: { section: 'credentials', tab: 'keys' },
  doppler: { section: 'credentials', tab: 'vault' },
  users: { section: 'people' },
  pages: { section: 'appearance' },
};

export function resolveSettingsRoute(hash: string): { section: SettingsSection; canonicalHash: string } | null {
  const [path, query = ''] = hash.split('?');
  let slug = '';
  let alias: { section: Exclude<SettingsSection, 'index'>; tab?: string } | undefined;
  if (path === '#/toolbox') alias = { section: 'connections', tab: 'mcp' };
  else if (path === '#/skills') alias = { section: 'skills' };
  else if (path === '#/connectors') alias = SETTINGS_ALIASES.connectors;
  else if (path === '#/settings' || path === '#/settings/') {
    return { section: 'index', canonicalHash: '#/settings' };
  } else if (path?.startsWith('#/settings/')) {
    slug = path.slice('#/settings/'.length);
    alias = SETTINGS_ALIASES[slug];
  } else {
    return null;
  }

  const valid = new Set<Exclude<SettingsSection, 'index'>>([
    'appearance',
    'navigation',
    'browser',
    'providers',
    'usage',
    'agents',
    'memory',
    'skills',
    'connections',
    'people',
    'credentials',
    'advanced',
  ]);
  let section = alias?.section ?? (valid.has(slug as Exclude<SettingsSection, 'index'>)
    ? (slug as Exclude<SettingsSection, 'index'>)
    : 'providers');
  const params = new URLSearchParams(query);
  if (section === 'providers' && params.get('tab') === 'usage') {
    section = 'usage';
    params.delete('tab');
  } else if (section === 'providers' && params.get('tab') === 'defaults') {
    params.set('tab', 'providers');
  }
  if (alias?.tab && !params.has('tab')) params.set('tab', alias.tab);
  const canonicalQuery = params.toString();
  return {
    section,
    canonicalHash: `#/settings/${section}${canonicalQuery ? `?${canonicalQuery}` : ''}`,
  };
}

function updateProjectFilesHash(hash: string, replace: boolean): void {
  const oldURL = window.location.href;
  if (replace) window.history.replaceState(window.history.state, '', hash);
  else window.history.pushState(window.history.state, '', hash);
  window.dispatchEvent(new HashChangeEvent('hashchange', { oldURL, newURL: window.location.href }));
}

function useHashRoute(): [string, (hash: string) => void] {
  const [hash, setHash] = useState(window.location.hash || '#/');
  useEffect(() => {
    const onChange = () => setHash(window.location.hash || '#/');
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  const navigate = useCallback((next: string) => {
    // Render the destination in the originating pointer/keyboard event rather
    // than waiting for hashchange's later task. New-chat autofocus then remains
    // part of the user's gesture, which lets iOS open the software keyboard.
    setHash(next);
    window.location.hash = next;
  }, []);
  return [hash, navigate];
}

export function App() {
  useDismissTokenCards();
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hash, navigate] = useHashRoute();
  const hasThreePaneRoom = useMediaQuery(THREE_PANE_QUERY);
  const { state: desktopState } = useFloatingDesktop();
  const [navigation, setNavigation] = useState<WorkspaceNavigation>(DEFAULT_WORKSPACE_NAVIGATION);
  const [toast, setToast] = useState<{ message: string; action?: ToastAction } | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  const dismissToast = useCallback(() => {
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    setToast(null);
  }, []);
  // Toasts with an action (e.g. "Undo") linger longer so there's time to tap.
  const showToast = useCallback((message: string, action?: ToastAction) => {
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    setToast({ message, action });
    toastTimerRef.current = window.setTimeout(() => setToast(null), action ? 5000 : 3000);
  }, []);

  // Composio adds its result fields before our hash route when it returns
  // from hosted OAuth. Consume them once, then replace the current history
  // entry so callback metadata does not follow the user around the hash app.
  useEffect(() => {
    const url = new URL(window.location.href);
    const [routePath, routeQuery = ''] = url.hash.split('?');
    const routeParams = new URLSearchParams(routeQuery);
    const isConnectorReturn =
      (routePath === '#/settings/connections' ||
        routePath === '#/settings/connectors' ||
        routePath === '#/connectors') &&
      routeParams.has('connected');
    if (!isConnectorReturn || url.searchParams.get('status') !== 'success') return;

    url.searchParams.delete('status');
    url.searchParams.delete('connected_account_id');
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
    showToast('Connector connected');
  }, [showToast]);

  // Tapping the action dismisses the toast as well as running its handler.
  const toastNode = toast ? (
    <Toast
      message={toast.message}
      action={
        toast.action
          ? {
              label: toast.action.label,
              onAction: () => {
                toast.action?.onAction();
                dismissToast();
              },
            }
          : undefined
      }
    />
  ) : null;

  const loadMe = useCallback(() => {
    api
      .me()
      .then((next) => {
        // Trusted published-page host comes from the server's configuration, so
        // page links are only recognized once /api/me has answered.
        setPagesPublicBase(next.pagesPublicBase ?? null);
        setMe(next);
      })
      .catch((err: Error) => setError(err.message));
  }, []);
  useEffect(loadMe, [loadMe]);
  useEffect(() => {
    applyPageTitle(me?.clientName);
  }, [me?.clientName]);

  // Once the signed-in user is active, probe the owner-only instance list once.
  // Clients get a 404 (→ null) and nothing renders. Kept before the early
  // returns below so hook order stays stable across the loading/pending states.
  const isActiveUser = Boolean(me && !me.setupRequired && !me.pending);
  const activeCanManage = me?.user?.role === 'owner' || me?.user?.role === 'consultant';
  useEffect(() => {
    if (!isActiveUser) return;
    let alive = true;
    void api
      .navigation()
      .then(async (result) => {
        let next = result.navigation;
        // Preserve the former per-device Terminal pin once. After a workspace
        // setting exists, the shared setting is authoritative on every device.
        if (!result.configured && activeCanManage && isLegacyTerminalPinned()) {
          next = {
            items: next.items.map((item) =>
              item.kind === 'builtin' && item.key === 'terminal' ? { ...item, visible: true } : item,
            ),
          };
          next = (await api.updateNavigation(next)).navigation;
        }
        clearLegacyTerminalPin();
        if (alive) setNavigation(next);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [activeCanManage, isActiveUser]);

  const updateNavigation = useCallback(async (next: WorkspaceNavigation) => {
    const result = await api.updateNavigation(next);
    setNavigation(result.navigation);
    return result.navigation;
  }, []);

  const updateTerminalPin = useCallback(
    async (visible: boolean) => {
      const next = {
        items: navigation.items.map((item) =>
          item.kind === 'builtin' && item.key === 'terminal' ? { ...item, visible } : item,
        ),
      };
      await updateNavigation(next);
    },
    [navigation, updateNavigation],
  );

  if (error) {
    return (
      <div className="flex h-full items-center justify-center px-8 text-center">
        <div>
          <p className="text-lg font-medium">Can't reach your assistant</p>
          <p className="mt-1 text-muted-foreground">{error}</p>
          <Button
            className="mt-5 h-11 rounded-xl px-5 text-base"
            onPointerUp={() => {
              setError(null);
              loadMe();
            }}
          >
            Try again
          </Button>
        </div>
      </div>
    );
  }
  if (!me) {
    return <div className="flex h-full items-center justify-center text-muted-foreground">Loading…</div>;
  }
  if (me.setupRequired) {
    return <Setup email={me.email ?? ''} onDone={loadMe} />;
  }
  if (me.pending) {
    return <PendingApproval email={me.email ?? ''} onRecheck={loadMe} />;
  }

  const role = me.user?.role ?? 'member';
  const canManage = role === 'owner' || role === 'consultant';
  const signedInEmail = me.user?.email ?? '';

  // Split the query off the hash (e.g. #/chat/new?project=<id>) so route
  // matching sees a clean path and screens can read params.
  const routePath = hash.split('?')[0] ?? hash;
  const params = new URLSearchParams(hash.split('?')[1] ?? '');

  // Which primary-nav item is active. Settings, plus the admin screens reached
  // from within it (terminal included), all count as "settings"; everything
  // else is a "chats" view.
  // A pinned Terminal or Mini App owns its rail item. Unpinned destinations
  // still open normally through Settings or the Apps library.
  const terminalPinned = navigation.items.some(
    (item) => item.kind === 'builtin' && item.key === 'terminal' && item.visible,
  );
  const appRouteId = miniAppIdFromPath(routePath);
  const appPinned = appRouteId
    ? navigation.items.some((item) => item.kind === 'app' && item.appId === appRouteId && item.visible)
    : false;
  const navCurrent: NavSelection = routePath.startsWith('#/terminal') && terminalPinned
    ? 'terminal'
    : routePath.startsWith('#/automations') || routePath.startsWith('#/scheduled')
    ? 'automations'
    : routePath.startsWith('#/todos')
      ? 'todos'
      : routePath.startsWith('#/pages')
        ? 'pages'
        : appRouteId && appPinned
          ? `app:${appRouteId}`
          : routePath.startsWith('#/apps')
            ? 'apps'
          : routePath.startsWith('#/files') ||
              routePath.startsWith('#/tools') ||
              routePath.startsWith('#/browse') ||
              routePath.startsWith('#/terminal')
            ? 'settings'
            : /^#\/(settings|connectors|toolbox|skills)/.test(routePath)
              ? 'settings'
              : 'chats';

  if (routePath === '#/terminal') {
    if (!canManage) {
      navigate('#/');
      return null;
    }
    const termProject = params.get('project');
    return (
      <>
        <NavShell
          current={navCurrent}
          canManage={canManage}
          signedInEmail={signedInEmail}
          onNavigate={navigate}
          navigation={navigation}
        >
          <TerminalScreen
            projectId={termProject}
            onBack={() => navigate(termProject ? `#/project/${termProject}` : '#/tools')}
            pinned={terminalPinned}
            onPinnedChange={updateTerminalPin}
            onToast={showToast}
          />
        </NavShell>
        {toastNode}
      </>
    );
  }

  let screen: ReactNode | null = null;
  if (hash.startsWith('#/voice')) {
    if (!canManage) { navigate('#/'); return null; }
    screen = <Suspense fallback={<p role="status" className="p-6">Opening voice…</p>}><LiveVoice onBack={() => navigate('#/tools')} /></Suspense>;
  } else if (hash.startsWith('#/tools')) {
    if (!canManage) {
      navigate('#/');
      return null;
    }
    screen = <Tools onNavigate={navigate} />;
  } else if (hash.startsWith('#/browse')) {
    if (role === 'member') {
      navigate('#/');
      return null;
    }
    screen = <FileBrowser onBack={() => navigate('#/tools')} onToast={showToast} />;
  } else if (hash.startsWith('#/automations') || hash.startsWith('#/scheduled')) {
    screen = <Scheduled onNavigate={navigate} onToast={showToast} focusTaskId={params.get('task')} />;
  } else if (hash.startsWith('#/todos')) {
    if (!canManage) {
      navigate('#/');
      return null;
    }
    screen = <Todos onToast={showToast} onNavigate={navigate} />;
  } else if (hash.startsWith('#/files')) {
    screen = <Files onToast={showToast} onOpenChat={(id) => navigate('#/chat/' + id)} />;
  } else if (hash.startsWith('#/pages')) {
    screen = <Pages onToast={showToast} />;
  } else if (hash.startsWith('#/apps')) {
    screen = (
      <Apps
        onToast={showToast}
        onNavigate={navigate}
        selectedAppId={appRouteId}
        canManage={canManage}
        navigation={navigation}
        onNavigationChange={updateNavigation}
      />
    );
  } else {
    const settingsRoute = resolveSettingsRoute(hash);
    if (settingsRoute) {
      if (settingsRoute.canonicalHash !== hash) {
        window.history.replaceState(window.history.state, '', settingsRoute.canonicalHash);
      }
      screen = (
        <Settings
          section={settingsRoute.section}
          role={role}
          onNavigate={navigate}
          onToast={showToast}
          navigation={navigation}
          onNavigationChange={updateNavigation}
        />
      );
    }
  }

  if (screen) {
    return (
      <>
        <NavShell
          current={navCurrent}
          canManage={canManage}
          signedInEmail={signedInEmail}
          onNavigate={navigate}
          navigation={navigation}
        >
          {screen}
        </NavShell>
        {toastNode}
      </>
    );
  }

  // Everything else is the chats family (#/, #/chat/:id, #/project/:id),
  // rendered as one split view: list sidebar + chat detail. On desktop both
  // panes show side by side (SplitView keeps the sidebar mounted across chat
  // switches, so it never flashes); on mobile SplitView renders only the pane
  // routing would have shown before — chat routes the chat, everything else
  // the list — so phones keep the screen-swapping flow.
  const chatMatch = routePath.match(/^#\/chat\/([^/]+)/);
  const projectFilesMatch = routePath.match(/^#\/project\/([^/]+)\/files$/);
  const projectMatch = routePath.match(/^#\/project\/([^/]+)$/);
  const chatId = chatMatch?.[1] ?? null;
  const projectFilesId = params.get('files') ?? projectFilesMatch?.[1] ?? null;
  const projectFile = projectFilesId
    ? projectFileLocationFromParams(new URLSearchParams(hash.split('?')[1] ?? ''))
    : null;
  const projectBrowserId = params.get('browser');
  if (projectFilesId && !canManage) {
    navigate('#/');
    return null;
  }
  const chatProjectId = chatId ? params.get('project') : null;
  const focusedChatId = chatId ? null : params.get('focusChat');
  // The project to reveal in the Chats list: the open chat's project, or a
  // ?project= on the bare list route (a chat's "back" lands on #/?project=<id>
  // so the list re-expands on the project you just left). Project files keep
  // that same expandable list visible in the first column.
  const listProjectId = projectFilesId ?? (chatId ? chatProjectId : projectBrowserId) ?? params.get('project');
  // A new chat fired off from a todo carries ?todo=<id>; Chat seeds its draft
  // from that todo and links it back once the conversation is created.
  const chatTodoId = chatId ? params.get('todo') : null;
  const chatBackHash = chatId && ['scheduled', 'automations'].includes(params.get('from') ?? '')
    ? '#/automations'
    : null;
  const chatFocusMessageId = chatId ? params.get('message') : null;
  const artifactParam = chatId ? params.get('artifact') : null;
  // Only an explicit #/project/:id route shows the standalone project view. A
  // chat opened from a project (?project=) keeps the expandable Chats list in
  // the sidebar — projects expand inline there, so there's no need to swap it
  // out (chatProjectId still flows to <Chat> so the new chat is filed right).
  const sidebarProjectId = projectMatch?.[1] ?? null;
  const openChat = (id: string, projectId?: string | null) => {
    const nextParams = new URLSearchParams();
    if (projectId) nextParams.set('project', projectId);
    if (projectFilesId) nextParams.set('files', projectFilesId);
    if (projectBrowserId) nextParams.set('browser', projectBrowserId);
    const query = nextParams.toString();
    navigate(`#/chat/${id}${query ? `?${query}` : ''}`);
  };
  const openNewChat = (projectId?: string | null, todoId?: string | null) => {
    const nextParams = new URLSearchParams();
    if (projectId) nextParams.set('project', projectId);
    if (todoId) nextParams.set('todo', todoId);
    const query = nextParams.toString();
    navigate(`#/chat/new${query ? `?${query}` : ''}`);
  };
  const openProjectFiles = (projectId: string, file: ProjectFileLocation | null = null) => {
    const baseHash = chatId ? hash : '#/';
    updateProjectFilesHash(hashWithProjectFiles(baseHash, projectId, file), projectFilesId !== null);
  };
  const clearProjectFile = () => {
    if (!projectFilesId) return;
    updateProjectFilesHash(hashWithProjectFiles(hash, projectFilesId), true);
  };
  const setProjectBrowser = (projectId: string | null) => {
    const [path, query = ''] = (hash || '#/').split('?');
    const next = new URLSearchParams(query);
    next.delete('artifact');
    next.delete('files');
    next.delete('file');
    next.delete('line');
    next.delete('column');
    next.delete('dir');
    if (projectId) next.set('browser', projectId);
    else next.delete('browser');
    if (!chatId && !projectId && projectBrowserId) next.set('project', projectBrowserId);
    const nextQuery = next.toString();
    updateProjectFilesHash(`${path}${nextQuery ? `?${nextQuery}` : ''}`, projectBrowserId !== null);
  };
  const openProjectBrowserManager = (projectId: string) => {
    navigate(`#/?browser=${encodeURIComponent(projectId)}`);
  };
  const closeProjectFiles = () => {
    if (chatId) {
      updateProjectFilesHash(hashWithProjectFiles(hash, null), true);
      return;
    }
    const nextParams = new URLSearchParams();
    if (projectFilesId) nextParams.set('project', projectFilesId);
    const query = nextParams.toString();
    updateProjectFilesHash(`#/${query ? `?${query}` : ''}`, true);
  };

  const sidebar = sidebarProjectId ? (
    <ProjectView
      projectId={sidebarProjectId}
      role={role}
      selectedId={chatId}
      onOpen={(id) => openChat(id, sidebarProjectId)}
      onNewChat={(pid) => openNewChat(pid)}
      onOpenTerminal={(pid) => navigate(`#/terminal?project=${pid}`)}
      onManageConnectors={(pid) => navigate(`#/settings/connections?tab=apps&project=${pid}`)}
      onBack={() => navigate('#/')}
      onDeleted={(name) => {
        showToast(`"${name}" deleted`);
        navigate('#/');
      }}
      onToast={showToast}
    />
  ) : (
    <ChatList
      displayName={me.user?.displayName ?? ''}
      role={role}
      selectedId={chatId}
      focusedId={focusedChatId}
      openProjectId={listProjectId}
      onOpen={openChat}
      onOpenProject={(id) => navigate(`#/project/${id}`)}
      onOpenProjectFiles={openProjectFiles}
      onOpenProjectBrowser={openProjectBrowserManager}
      onOpenAutomations={() => navigate('#/automations')}
      onNewChat={openNewChat}
      onToast={showToast}
    />
  );

  return (
    <>
      {/* mobileHidden on detail routes: the detail owns the mobile viewport
          (its header arrow goes back); the rail still shows on desktop. */}
      <NavShell
        current={navCurrent}
        canManage={canManage}
        signedInEmail={signedInEmail}
        onNavigate={navigate}
        mobileHidden={chatId !== null || projectFilesId !== null || projectBrowserId !== null}
        chatOpen={chatId !== null}
        navigation={navigation}
      >
        <SplitView
          storageKey="split:chats"
          mobileShows={chatId || projectFilesId || projectBrowserId ? 'detail' : 'sidebar'}
          sidebarHidden={Boolean(
            chatId && (desktopState === 'full' || artifactParam || projectFilesId || projectBrowserId) && !hasThreePaneRoom,
          )}
          sidebar={sidebar}
        >
          {chatId ? (
            <ChatWorkspace
              key={chatId === 'new' ? `${chatId}:${chatProjectId ?? ''}` : chatId}
              conversationId={chatId}
              projectId={chatProjectId}
              todoId={chatTodoId}
              backHash={chatBackHash}
              focusMessageId={chatFocusMessageId}
              artifactParam={artifactParam}
              projectFilesId={projectFilesId}
              projectFile={projectFile}
              projectBrowserId={projectBrowserId}
              onCloseProjectFiles={closeProjectFiles}
              onOpenProjectFile={openProjectFiles}
              onClearProjectFile={clearProjectFile}
              onOpenProjectBrowser={setProjectBrowser}
              onCloseProjectBrowser={() => setProjectBrowser(null)}
              onNavigate={navigate}
              onToast={showToast}
            />
          ) : projectFilesId ? (
            <FileBrowser
              title="Project files"
              fixedRoot={`project:${projectFilesId}`}
              initialFile={projectFile}
              backLabel="Close project files"
              onBack={closeProjectFiles}
              onInitialFileDeclined={clearProjectFile}
              onToast={showToast}
            />
          ) : projectBrowserId ? (
            <ProjectBrowserPanel
              projectId={projectBrowserId}
              isOwner={role === 'owner'}
              onClose={() => setProjectBrowser(null)}
              onToast={(message) => showToast(message)}
            />
          ) : (
            <SplitPlaceholder title="Select a chat" hint="Or open a project to start a new one." />
          )}
        </SplitView>
      </NavShell>
      {toastNode}
    </>
  );
}
