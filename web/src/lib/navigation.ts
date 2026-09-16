import type { LucideIcon } from 'lucide-react';
import {
  AppWindow,
  CalendarClock,
  ChartNoAxesCombined,
  LayoutTemplate,
  List,
  ListTodo,
  Star,
  SquareTerminal,
  Table2,
} from 'lucide-react';
import type {
  BuiltinNavigationKey,
  MiniAppNavigationIcon,
  WorkspaceNavigation,
  WorkspaceNavigationItem,
} from './types';

export const DEFAULT_WORKSPACE_NAVIGATION: WorkspaceNavigation = {
  items: [
    { kind: 'builtin', key: 'automations', visible: true },
    { kind: 'builtin', key: 'todos', visible: true },
    { kind: 'builtin', key: 'pages', visible: true },
    { kind: 'builtin', key: 'apps', visible: true },
    { kind: 'builtin', key: 'terminal', visible: false },
  ],
};

export const BUILTIN_NAVIGATION: Record<
  BuiltinNavigationKey,
  { label: string; description: string; hash: string; icon: LucideIcon; adminOnly?: boolean }
> = {
  automations: {
    label: 'Automations',
    description: 'Scheduled and repeated work.',
    hash: '#/automations',
    icon: CalendarClock,
  },
  todos: {
    label: 'Todos',
    description: 'The workspace task board.',
    hash: '#/todos',
    icon: ListTodo,
    adminOnly: true,
  },
  pages: {
    label: 'Pages',
    description: 'Published reports and pages.',
    hash: '#/pages',
    icon: AppWindow,
  },
  apps: {
    label: 'Apps',
    description: 'The complete Mini App library.',
    hash: '#/apps',
    icon: LayoutTemplate,
  },
  terminal: {
    label: 'Terminal',
    description: 'The Veneer host terminal.',
    hash: '#/terminal',
    icon: SquareTerminal,
    adminOnly: true,
  },
};

export const MINI_APP_NAVIGATION_ICONS: Record<MiniAppNavigationIcon, { label: string; icon: LucideIcon }> = {
  app: { label: 'App', icon: AppWindow },
  chart: { label: 'Chart', icon: ChartNoAxesCombined },
  table: { label: 'Table', icon: Table2 },
  calendar: { label: 'Calendar', icon: CalendarClock },
  list: { label: 'List', icon: List },
  star: { label: 'Star', icon: Star },
};

export function itemIdentity(item: WorkspaceNavigationItem): string {
  return item.kind === 'builtin' ? `builtin:${item.key}` : `app:${item.appId}`;
}

export function isNavigationItemAllowed(item: WorkspaceNavigationItem, canManage: boolean): boolean {
  return item.kind === 'app' || !BUILTIN_NAVIGATION[item.key].adminOnly || canManage;
}

export function moveVisibleNavigationItem(
  navigation: WorkspaceNavigation,
  id: string,
  direction: -1 | 1,
): WorkspaceNavigation {
  const visible = navigation.items.filter((item) => item.visible);
  const visibleIndex = visible.findIndex((item) => itemIdentity(item) === id);
  const other = visible[visibleIndex + direction];
  if (visibleIndex < 0 || !other) return navigation;
  const from = navigation.items.findIndex((item) => itemIdentity(item) === id);
  const to = navigation.items.findIndex((item) => itemIdentity(item) === itemIdentity(other));
  const items = [...navigation.items];
  [items[from], items[to]] = [items[to]!, items[from]!];
  return { items };
}

export function setMiniAppNavigation(
  navigation: WorkspaceNavigation,
  app: { id: string; title: string },
  visible: boolean,
  icon: MiniAppNavigationIcon = 'app',
): WorkspaceNavigation {
  const existing = navigation.items.find((item) => item.kind === 'app' && item.appId === app.id);
  if (!existing) {
    return {
      items: [
        ...navigation.items,
        { kind: 'app', appId: app.id, visible, icon, label: null, title: app.title },
      ],
    };
  }
  return {
    items: navigation.items.map((item) =>
      item.kind === 'app' && item.appId === app.id ? { ...item, visible, icon } : item,
    ),
  };
}

export function miniAppIdFromPath(path: string): string | null {
  return path.match(/^#\/apps\/([^/]+)$/)?.[1] ?? null;
}
