import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  Bot,
  Brain,
  BookOpen,
  ChevronLeft,
  ChevronRight,
  Cpu,
  FolderOpen,
  Gauge,
  KeyRound,
  LogOut,
  Monitor,
  Palette,
  PanelLeft,
  Plug,
  Search,
  SlidersHorizontal,
  Users,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { CLOUDFLARE_LOGOUT_PATH } from '@/lib/cloudflareAccess';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { RestartButton } from '@/components/RestartButton';
import { SplitView } from '@/components/layout/SplitView';
import { DESKTOP_QUERY, useMediaQuery } from '@/hooks/useMediaQuery';
import { SkillsScreen } from './Skills';
import { ConnectorsScreen } from './Connectors';
import { MemberProvidersPage } from './settings/MemberProvidersPage';
import { AccountsPage } from './settings/AccountsPage';
import { AgentsPage, FileLockSettings } from './settings/AgentsPage';
import { AppearancePage, VoiceWaveformCard } from './settings/AppearancePage';
import { ApiKeysPage } from './settings/ApiKeysPage';
import { BrowserSettingsPage } from './settings/BrowserSettingsPage';
import { ChatTitlesPage } from './settings/ChatTitlesPage';
import { ChatsPage, TodoPlanningPromptSettings } from './settings/ChatsPage';
import { ConnectionSettingsList } from './settings/ConnectionSettingsList';
import { DopplerPage } from './settings/DopplerPage';
import { MemoryPage } from './settings/MemoryPage';
import { NavigationPage } from './settings/NavigationPage';
import type { WorkspaceNavigation } from '@/lib/types';
import { SettingsPageHeader, SettingsSection, SettingsTabs } from './settings/SettingsPrimitives';
import { UsagePage } from './settings/UsagePage';
import { UsersPage } from './settings/UsersPage';
import { VoicePage } from './settings/VoicePage';

export type SettingsSection =
  | 'index'
  | 'appearance'
  | 'navigation'
  | 'browser'
  | 'providers'
  | 'usage'
  | 'agents'
  | 'memory'
  | 'skills'
  | 'connections'
  | 'people'
  | 'credentials'
  | 'advanced';

type Destination = {
  title: string;
  description: string;
  icon: LucideIcon;
  adminOnly?: boolean;
} & (
  | { section: Exclude<SettingsSection, 'index'>; hash?: never }
  | { section?: never; hash: string }
);

type DestinationGroup = {
  label: string;
  destinations: Destination[];
};

const GROUPS: DestinationGroup[] = [
  {
    label: 'For you',
    destinations: [
      {
        section: 'appearance',
        title: 'Appearance & branding',
        description: 'Theme, chat icons, and workspace identity',
        icon: Palette,
      },
    ],
  },
  {
    label: 'Intelligence',
    destinations: [
      {
        section: 'providers',
        title: 'Providers & models',
        description: 'AI defaults, accounts, models, chat, and voice',
        icon: Cpu,
      },
      {
        section: 'usage',
        title: 'Usage',
        description: 'Provider limits and API spend',
        icon: Gauge,
      },
      {
        section: 'agents',
        title: 'Agents',
        description: 'Agent instructions and defaults',
        icon: Bot,
      },
      {
        section: 'memory',
        title: 'Memory',
        description: 'Learning, suggestions, and saved context',
        icon: Brain,
      },
      {
        section: 'skills',
        title: 'Skills',
        description: 'Playbooks available to your agents',
        icon: BookOpen,
      },
    ],
  },
  {
    label: 'Workspace',
    destinations: [
      {
        section: 'navigation',
        title: 'Navigation',
        description: 'Sidebar items and order',
        icon: PanelLeft,
        adminOnly: true,
      },
      {
        section: 'browser',
        title: 'Browser',
        description: 'Resolution and quality',
        icon: Monitor,
        adminOnly: true,
      },
      {
        section: 'connections',
        title: 'Connections',
        description: 'Connected apps and custom MCP tools',
        icon: Plug,
      },
      {
        hash: '#/files',
        title: 'Files',
        description: 'Agent-created files from all chats',
        icon: FolderOpen,
      },
      {
        hash: '#/tools',
        title: 'Tools',
        description: 'File browser and terminal utilities',
        icon: Wrench,
        adminOnly: true,
      },
      {
        section: 'people',
        title: 'People & access',
        description: 'Members, roles, and access',
        icon: Users,
        adminOnly: true,
      },
    ],
  },
  {
    label: 'Administration',
    destinations: [
      {
        section: 'credentials',
        title: 'Credentials',
        description: 'Provider keys and secret vault',
        icon: KeyRound,
        adminOnly: true,
      },
      {
        section: 'advanced',
        title: 'Advanced',
        description: 'Runtime coordination and service controls',
        icon: SlidersHorizontal,
        adminOnly: true,
      },
    ],
  },
];

const DESTINATIONS = GROUPS.flatMap((group) => group.destinations).filter(
  (destination): destination is Destination & { section: Exclude<SettingsSection, 'index'> } =>
    destination.section !== undefined,
);

function NavRow({
  destination,
  active,
  onOpen,
}: {
  destination: Destination;
  active: boolean;
  onOpen: () => void;
}) {
  const Icon = destination.icon;
  return (
    <button
      type="button"
      onPointerUp={onOpen}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'group flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-muted/60',
        active && 'bg-accent text-accent-foreground',
      )}
    >
      <Icon className="size-4.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{destination.title}</span>
        <span className="mt-0.5 block truncate text-xs text-muted-foreground md:hidden xl:block">
          {destination.description}
        </span>
      </span>
      <ChevronRight className="size-4 shrink-0 text-muted-foreground md:hidden" />
    </button>
  );
}

function NavGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="mt-5 first:mt-0">
      <h2 className="mb-1 px-3 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
        {label}
      </h2>
      <div className="space-y-0.5">{children}</div>
    </section>
  );
}

function currentTab<T extends string>(allowed: readonly T[], fallback: T): T {
  const value = new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('tab') as T | null;
  return value && allowed.includes(value) ? value : fallback;
}

function useSettingsTab<T extends string>(allowed: readonly T[], fallback: T): [T, (value: T) => void] {
  const routeTab = currentTab(allowed, fallback);
  const [tab, setTabState] = useState<T>(routeTab);
  useEffect(() => {
    setTabState(routeTab);
  }, [routeTab]);
  const setTab = useCallback((value: T) => {
    setTabState(value);
    const [path, query = ''] = window.location.hash.split('?');
    const params = new URLSearchParams(query);
    params.set('tab', value);
    window.history.replaceState(window.history.state, '', `${path}?${params.toString()}`);
  }, []);
  return [tab, setTab];
}

function ProviderModelSettings({
  role,
  onNavigate,
  onToast,
}: {
  role: string;
  onNavigate: (hash: string) => void;
  onToast: (message: string) => void;
}) {
  const admin = role !== 'member';
  const allowedTabs = admin ? (['providers', 'history', 'voice'] as const) : (['providers', 'history'] as const);
  const [tab, setTab] = useSettingsTab(allowedTabs, 'providers');

  return (
    <div className="space-y-5">
      <SettingsTabs
        value={tab}
        onChange={setTab}
        label="AI settings sections"
        items={
          admin
            ? [
                { value: 'providers', label: 'Providers' },
                { value: 'history', label: 'History' },
                { value: 'voice', label: 'Voice' },
              ]
            : [
                { value: 'providers', label: 'Providers' },
                { value: 'history', label: 'History' },
              ]
        }
      />
      {tab === 'providers' ? (admin ? <AccountsPage /> : <MemberProvidersPage />) : null}
      {tab === 'history' ? (
        <div className="space-y-4">
          <ChatsPage onToast={onToast} />
          {admin ? <ChatTitlesPage /> : null}
        </div>
      ) : null}
      {tab === 'voice' && admin ? (
        <div className="space-y-4">
          <VoicePage onNavigate={onNavigate} />
          <VoiceWaveformCard />
        </div>
      ) : null}
    </div>
  );
}

function ConnectionsSettings({
  role,
  onToast,
}: {
  role: string;
  onToast: (message: string) => void;
}) {
  const admin = role !== 'member';
  const allowedTabs = admin ? (['apps', 'mcp'] as const) : (['apps'] as const);
  const [tab, setTab] = useSettingsTab(allowedTabs, 'apps');
  return (
    <div className="space-y-5">
      {admin ? (
        <SettingsTabs
          value={tab}
          onChange={setTab}
          label="Connection sections"
          items={[
            { value: 'apps', label: 'Connected apps' },
            { value: 'mcp', label: 'MCP connections' },
          ]}
        />
      ) : null}
      {tab === 'apps' ? <ConnectorsScreen role={role} onToast={onToast} /> : null}
      {tab === 'mcp' && admin ? <ConnectionSettingsList role={role} /> : null}
    </div>
  );
}

function CredentialsSettings({ role, onToast }: { role: string; onToast: (message: string) => void }) {
  const [tab, setTab] = useSettingsTab(['keys', 'vault'] as const, 'keys');
  return (
    <div className="space-y-5">
      <SettingsTabs
        value={tab}
        onChange={setTab}
        label="Credential sections"
        items={[
          { value: 'keys', label: 'API keys' },
          { value: 'vault', label: 'Doppler' },
        ]}
      />
      {tab === 'keys' ? (
        <ApiKeysPage />
      ) : (
        <DopplerPage onToast={onToast} canEditGuidance={role === 'owner'} />
      )}
    </div>
  );
}

function AdvancedSettings({ role, onToast }: { role: string; onToast: (message: string) => void }) {
  const [tab, setTab] = useSettingsTab(['runtime', 'service'] as const, 'runtime');
  return (
    <div className="space-y-5">
      <SettingsTabs
        value={tab}
        onChange={setTab}
        label="Advanced sections"
        items={[
          { value: 'runtime', label: 'Agent runtime' },
          { value: 'service', label: 'Service controls' },
        ]}
      />
      {tab === 'runtime' ? (
        <div className="space-y-4">
          <FileLockSettings />
          <TodoPlanningPromptSettings onToast={onToast} />
        </div>
      ) : null}
      {tab === 'service' ? (
        <SettingsSection
          title="Restart Veneer Pro"
          description="Use this only to recover a stuck service. The app reconnects automatically, but any reply in progress will stop."
        >
          {role === 'owner' || role === 'consultant' ? <RestartButton /> : null}
        </SettingsSection>
      ) : null}
    </div>
  );
}

function SettingsContent({
  section,
  role,
  onNavigate,
  onToast,
  navigation,
  onNavigationChange,
}: {
  section: Exclude<SettingsSection, 'index'>;
  role: string;
  onNavigate: (hash: string) => void;
  onToast: (message: string) => void;
  navigation: WorkspaceNavigation;
  onNavigationChange: (navigation: WorkspaceNavigation) => Promise<WorkspaceNavigation>;
}) {
  if (section === 'appearance') return <AppearancePage role={role} />;
  if (section === 'navigation') {
    return <NavigationPage navigation={navigation} onChange={onNavigationChange} onToast={onToast} />;
  }
  if (section === 'browser') return <BrowserSettingsPage onToast={onToast} />;
  if (section === 'providers') {
    return <ProviderModelSettings role={role} onNavigate={onNavigate} onToast={onToast} />;
  }
  if (section === 'usage') return <UsagePage canManage={role !== 'member'} />;
  if (section === 'agents') return <AgentsPage />;
  if (section === 'memory') return <MemoryPage onToast={onToast} />;
  if (section === 'skills') {
    return (
      <SkillsScreen
        embedded
        role={role}
        onBack={() => onNavigate('#/settings')}
        onNavigate={onNavigate}
        onToast={onToast}
      />
    );
  }
  if (section === 'connections') return <ConnectionsSettings role={role} onToast={onToast} />;
  if (section === 'people') return <UsersPage />;
  if (section === 'credentials') return <CredentialsSettings role={role} onToast={onToast} />;
  return <AdvancedSettings role={role} onToast={onToast} />;
}

export function Settings({
  section,
  role,
  onNavigate,
  onToast,
  navigation,
  onNavigationChange,
}: {
  section: SettingsSection;
  role: string;
  onNavigate: (hash: string) => void;
  onToast: (message: string) => void;
  navigation: WorkspaceNavigation;
  onNavigationChange: (navigation: WorkspaceNavigation) => Promise<WorkspaceNavigation>;
}) {
  const isDesktop = useMediaQuery(DESKTOP_QUERY);
  const admin = role !== 'member';
  const [query, setQuery] = useState('');
  const visibleGroups = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return GROUPS.map((group) => ({
      ...group,
      destinations: group.destinations.filter(
        (destination) =>
          (!destination.adminOnly || admin) &&
          (!normalized ||
            `${destination.title} ${destination.description} ${group.label}`
              .toLocaleLowerCase()
              .includes(normalized)),
      ),
    })).filter((group) => group.destinations.length > 0);
  }, [admin, query]);

  const requested = section === 'index' ? 'providers' : section;
  const requestedDestination = DESTINATIONS.find((destination) => destination.section === requested);
  const activeSection =
    requestedDestination?.adminOnly && !admin
      ? 'providers'
      : requested;
  const activeDestination = DESTINATIONS.find((destination) => destination.section === activeSection)!;

  useEffect(() => {
    if (requestedDestination?.adminOnly && !admin) onNavigate('#/settings/providers');
  }, [admin, onNavigate, requestedDestination?.adminOnly]);

  const sidebar = (
    <div className="mx-auto flex h-full max-w-2xl flex-col pt-[env(safe-area-inset-top)]">
      <header className="border-b px-4 py-4 md:px-5">
        <div className="flex items-center gap-2">
          {!isDesktop ? (
            <Button
              variant="ghost"
              size="icon-lg"
              className="-ml-2 rounded-full"
              onPointerUp={() => onNavigate('#/')}
              aria-label="Back"
            >
              <ChevronLeft className="size-5" />
            </Button>
          ) : null}
          <div className="min-w-0 flex-1">
            <h1 className="text-lg font-semibold">Settings</h1>
            {isDesktop ? <p className="text-xs text-muted-foreground">Configure Veneer for you and your workspace.</p> : null}
          </div>
        </div>
        <div className="relative mt-3">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search settings"
            aria-label="Search settings"
            className="h-9 rounded-xl pl-9 text-base md:text-sm"
          />
        </div>
      </header>
      <nav
        aria-label="Settings"
        className="flex-1 overflow-y-auto px-3 py-4 pb-[calc(env(safe-area-inset-bottom)+2rem)]"
      >
        {visibleGroups.map((group) => (
          <NavGroup key={group.label} label={group.label}>
            {group.destinations.map((destination) => (
              <NavRow
                key={destination.section ?? destination.hash}
                destination={destination}
                active={destination.section !== undefined && activeSection === destination.section}
                onOpen={() =>
                  onNavigate(destination.section !== undefined ? `#/settings/${destination.section}` : destination.hash)
                }
              />
            ))}
          </NavGroup>
        ))}
        {visibleGroups.length === 0 ? (
          <p className="px-3 py-8 text-center text-sm text-muted-foreground">No settings match “{query}”.</p>
        ) : null}
        <div className="mt-6 border-t pt-3">
          <a
            href={CLOUDFLARE_LOGOUT_PATH}
            className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium text-destructive hover:bg-muted"
          >
            <LogOut className="size-4" />
            Log out
          </a>
        </div>
      </nav>
    </div>
  );

  const detail = (
    <div className="flex h-full min-w-0 flex-col pt-[env(safe-area-inset-top)]">
      {!isDesktop ? (
        <header className="flex min-h-14 items-center border-b px-3">
          <Button
            variant="ghost"
            size="icon-lg"
            className="rounded-full"
            onPointerUp={() => onNavigate('#/settings')}
            aria-label="Back to settings"
          >
            <ChevronLeft className="size-5" />
          </Button>
          <span className="ml-1 truncate font-medium">{activeDestination.title}</span>
        </header>
      ) : null}
      <div className="flex-1 overflow-y-auto px-4 py-6 pb-[calc(env(safe-area-inset-bottom)+3rem)] sm:px-6 md:px-8 md:py-8">
        <main className="mx-auto w-full max-w-3xl">
          {/* Usage renders its own header: the title shares one row with the
              refresh control, whose state lives down in UsagePage. */}
          {activeSection === 'usage' ? null : (
            <SettingsPageHeader
              title={activeDestination.title}
              description={
                activeSection === 'browser'
                  ? 'These settings control the live Veneer Browser viewer. Higher resolution and quality look sharper and use more bandwidth.'
                  : activeDestination.description
              }
            />
          )}
          <SettingsContent
            section={activeSection}
            role={role}
            onNavigate={onNavigate}
            onToast={onToast}
            navigation={navigation}
            onNavigationChange={onNavigationChange}
          />
        </main>
      </div>
    </div>
  );

  return (
    <SplitView
      storageKey="split:settings:v2"
      mobileShows={section === 'index' ? 'sidebar' : 'detail'}
      sidebar={sidebar}
      defaultWidth={320}
      minWidth={260}
      maxWidth={400}
    >
      {detail}
    </SplitView>
  );
}
