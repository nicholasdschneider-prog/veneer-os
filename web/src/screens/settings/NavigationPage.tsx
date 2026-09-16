import { ArrowDown, ArrowUp } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import {
  BUILTIN_NAVIGATION,
  itemIdentity,
  MINI_APP_NAVIGATION_ICONS,
  moveVisibleNavigationItem,
} from '@/lib/navigation';
import type { WorkspaceNavigation, WorkspaceNavigationItem } from '@/lib/types';
import { SettingsSection } from './SettingsPrimitives';

function itemDetails(item: WorkspaceNavigationItem) {
  if (item.kind === 'builtin') return BUILTIN_NAVIGATION[item.key];
  return {
    label: item.label || item.title,
    description: 'Mini App.',
    icon: MINI_APP_NAVIGATION_ICONS[item.icon].icon,
  };
}

export function NavigationPage({
  navigation,
  onChange,
  onToast,
}: {
  navigation: WorkspaceNavigation;
  onChange: (navigation: WorkspaceNavigation) => Promise<WorkspaceNavigation>;
  onToast: (message: string) => void;
}) {
  const [saving, setSaving] = useState(false);
  const visible = navigation.items.filter((item) => item.visible);
  const hidden = navigation.items.filter((item) => !item.visible);

  const save = async (next: WorkspaceNavigation) => {
    if (saving) return;
    setSaving(true);
    try {
      await onChange(next);
    } catch (error) {
      onToast(error instanceof Error ? error.message : 'Could not update navigation.');
    } finally {
      setSaving(false);
    }
  };

  const setVisible = (id: string, nextVisible: boolean) => {
    if (saving) return;
    void save({
      items: navigation.items.map((item) =>
        itemIdentity(item) === id ? { ...item, visible: nextVisible } : item,
      ),
    });
  };

  const rows = (items: WorkspaceNavigationItem[], allowMove: boolean) => (
    <div className="divide-y divide-foreground/10 border-y border-foreground/10">
      {items.map((item) => {
        const id = itemIdentity(item);
        const details = itemDetails(item);
        const Icon = details.icon;
        const visibleIndex = visible.findIndex((candidate) => itemIdentity(candidate) === id);
        return (
          <div key={id} className="flex min-h-16 items-center gap-3 py-3">
            <Icon className="size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium">{details.label}</p>
              <p className="text-pretty text-base/7 text-muted-foreground sm:text-sm/6">{details.description}</p>
            </div>
            {allowMove ? (
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => void save(moveVisibleNavigationItem(navigation, id, -1))}
                  disabled={saving || visibleIndex <= 0}
                  aria-label={`Move ${details.label} up`}
                >
                  <ArrowUp className="size-4" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => void save(moveVisibleNavigationItem(navigation, id, 1))}
                  disabled={saving || visibleIndex < 0 || visibleIndex >= visible.length - 1}
                  aria-label={`Move ${details.label} down`}
                >
                  <ArrowDown className="size-4" />
                </Button>
              </div>
            ) : null}
            <Switch
              checked={item.visible}
              onCheckedChange={() => setVisible(id, !item.visible)}
              disabled={saving}
              aria-label={`${item.visible ? 'Hide' : 'Show'} ${details.label} in the sidebar`}
            />
          </div>
        );
      })}
    </div>
  );

  return (
    <div className="flex flex-col gap-7">
      <SettingsSection
        title="Sidebar items"
        description="Choose the items that appear after Chats. Chats and Settings always stay available."
      >
        {rows(visible, true)}
      </SettingsSection>
      {hidden.length ? (
        <SettingsSection title="Hidden items" description="Hidden items remain available by their normal links.">
          {rows(hidden, false)}
        </SettingsSection>
      ) : null}
    </div>
  );
}
