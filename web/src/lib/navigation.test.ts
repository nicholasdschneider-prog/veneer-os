import { AppWindow, LayoutTemplate } from 'lucide-react';
import { describe, expect, it } from 'vitest';
import {
  BUILTIN_NAVIGATION,
  DEFAULT_WORKSPACE_NAVIGATION,
  miniAppIdFromPath,
  moveVisibleNavigationItem,
  setMiniAppNavigation,
} from './navigation';

describe('workspace navigation helpers', () => {
  it('uses the app-shaped icon for Pages and the page-shaped icon for Apps', () => {
    expect(BUILTIN_NAVIGATION.pages.icon).toBe(AppWindow);
    expect(BUILTIN_NAVIGATION.apps.icon).toBe(LayoutTemplate);
  });

  it('moves visible items across hidden entries', () => {
    const moved = moveVisibleNavigationItem(DEFAULT_WORKSPACE_NAVIGATION, 'builtin:apps', -1);
    expect(moved.items.map((item) => (item.kind === 'builtin' ? item.key : item.appId))).toEqual([
      'automations',
      'todos',
      'apps',
      'pages',
      'terminal',
    ]);
  });

  it('adds and updates a Mini App pin without losing its place', () => {
    const added = setMiniAppNavigation(DEFAULT_WORKSPACE_NAVIGATION, { id: 'sales', title: 'Sales Pulse' }, true, 'chart');
    const hidden = setMiniAppNavigation(added, { id: 'sales', title: 'Sales Pulse' }, false, 'table');
    expect(hidden.items.at(-1)).toEqual({
      kind: 'app',
      appId: 'sales',
      visible: false,
      icon: 'table',
      label: null,
      title: 'Sales Pulse',
    });
  });

  it('recognizes only direct Mini App paths', () => {
    expect(miniAppIdFromPath('#/apps/abc-123')).toBe('abc-123');
    expect(miniAppIdFromPath('#/apps')).toBeNull();
    expect(miniAppIdFromPath('#/apps/abc/extra')).toBeNull();
  });
});
