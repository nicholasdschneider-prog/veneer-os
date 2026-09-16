import { useEffect, useMemo, useState } from 'react';
import { AppWindow, Check, ChevronLeft, CircleAlert, Cloud, Copy, ExternalLink, PanelLeft, Server, ShieldCheck, Trash2 } from 'lucide-react';
import { api } from '../lib/api';
import type { MiniApp, MiniAppNavigationIcon, WorkspaceNavigation } from '../lib/types';
import { MINI_APP_NAVIGATION_ICONS, setMiniAppNavigation } from '../lib/navigation';
import { formatBytes } from '../lib/format';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { EmbeddedPreviewFrame } from '@/components/ui/embedded-preview-frame';
import { Switch } from '@/components/ui/switch';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { SplitPlaceholder, SplitView } from '../components/layout/SplitView';
import { DESKTOP_QUERY, useMediaQuery } from '../hooks/useMediaQuery';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

function parseDbDate(value: string): Date {
  return new Date(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`);
}

function timeAgo(value: string): string {
  const minutes = Math.max(0, Math.round((Date.now() - parseDbDate(value).getTime()) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function StatusIcon({ app }: { app: MiniApp }) {
  if (app.status === 'error' || app.runtimeStatus?.status === 'error' || app.runtimeStatus?.status === 'unavailable') {
    return <CircleAlert className="size-4 shrink-0 text-destructive" />;
  }
  if (app.status === 'deployed' && (app.runtime === 'cloudflare' || app.runtimeStatus?.status === 'running')) {
    return <ShieldCheck className="size-4 shrink-0 text-primary" />;
  }
  return <span className="size-3 shrink-0 animate-pulse rounded-full bg-muted-foreground" />;
}

function runtimeLabel(app: MiniApp): string {
  return app.runtime === 'local' ? 'This Veneer' : 'Cloudflare';
}

function statusLabel(app: MiniApp): string {
  if (app.status === 'error') return 'Deploy failed';
  if (app.status === 'deploying') return 'Deploying';
  if (app.runtime === 'cloudflare') return 'Protected';
  switch (app.runtimeStatus?.status) {
    case 'running':
      return 'Running';
    case 'starting':
      return 'Starting';
    case 'restarting':
      return 'Restarting';
    case 'error':
      return 'Failed';
    case 'unavailable':
      return 'Runner unavailable';
    default:
      return 'Stopped';
  }
}

function isStandalonePwa(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (window.navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

/** Private Cloudflare- or host-backed tools published through publish_app. */
export function Apps({
  onToast,
  onNavigate,
  selectedAppId,
  canManage,
  navigation,
  onNavigationChange,
}: {
  onToast: (message: string) => void;
  onNavigate: (hash: string) => void;
  selectedAppId: string | null;
  canManage: boolean;
  navigation: WorkspaceNavigation;
  onNavigationChange: (navigation: WorkspaceNavigation) => Promise<WorkspaceNavigation>;
}) {
  const isDesktop = useMediaQuery(DESKTOP_QUERY);
  const [apps, setApps] = useState<MiniApp[] | null>(null);
  const [configured, setConfigured] = useState(true);
  const [copied, setCopied] = useState(false);
  const [confirmApp, setConfirmApp] = useState<MiniApp | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [sidebarSaving, setSidebarSaving] = useState(false);
  const selectedId = selectedAppId;
  const appLinkTarget = isStandalonePwa() ? undefined : '_blank';

  useEffect(() => {
    let stopped = false;
    const load = () => {
      void api
        .apps()
        .then((result) => {
          if (!stopped) {
            setApps(result.apps);
            setConfigured(result.configured);
          }
        })
        .catch(() => {
          if (!stopped) setApps((current) => current ?? []);
        });
    };
    load();
    const timer = window.setInterval(load, 10_000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, []);

  const selected = useMemo(
    () => (selectedId ? (apps ?? []).find((app) => app.id === selectedId) ?? null : null),
    [apps, selectedId],
  );

  useEffect(() => {
    if (selectedId && apps && !apps.some((app) => app.id === selectedId)) onNavigate('#/apps');
  }, [apps, onNavigate, selectedId]);
  useEffect(() => setCopied(false), [selectedId]);

  const copyLink = (url: string) => {
    void navigator.clipboard
      .writeText(url)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => onToast('Could not copy link'));
  };

  const deleteApp = async (app: MiniApp) => {
    setDeleting(true);
    try {
      await api.deleteApp(app.id);
      setApps((current) => current?.filter((item) => item.id !== app.id) ?? current);
      await onNavigationChange({
        items: navigation.items.filter((item) => item.kind !== 'app' || item.appId !== app.id),
      });
      if (selectedId === app.id) onNavigate('#/apps');
      onToast(`Deleted "${app.title}"`);
    } catch (error) {
      onToast(error instanceof Error ? error.message : 'Delete failed');
    } finally {
      setDeleting(false);
      setConfirmApp(null);
    }
  };

  const sidebarItem = selected
    ? navigation.items.find((item) => item.kind === 'app' && item.appId === selected.id) ?? null
    : null;
  const showInSidebar = sidebarItem?.visible === true;
  const SidebarIcon =
    sidebarItem?.kind === 'app' ? MINI_APP_NAVIGATION_ICONS[sidebarItem.icon].icon : MINI_APP_NAVIGATION_ICONS.app.icon;

  const updateSidebar = async (visible: boolean, icon?: MiniAppNavigationIcon) => {
    if (!selected || sidebarSaving) return;
    const currentIcon = sidebarItem?.kind === 'app' ? sidebarItem.icon : 'app';
    const next = setMiniAppNavigation(navigation, selected, visible, icon ?? currentIcon);
    setSidebarSaving(true);
    try {
      await onNavigationChange(next);
    } catch (error) {
      onToast(error instanceof Error ? error.message : 'Could not update the sidebar.');
    } finally {
      setSidebarSaving(false);
    }
  };

  const sidebar = (
    <div className="mx-auto flex h-full max-w-2xl flex-col pt-[env(safe-area-inset-top)]">
      <header className="flex items-center justify-between px-5 pb-3 pt-6">
        <div>
          <h1 className="text-2xl font-semibold">Apps</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">Private tools on Cloudflare or this Veneer</p>
        </div>
      </header>
      <div className="flex-1 overflow-y-auto px-3 pb-[calc(env(safe-area-inset-bottom)+1rem)]">
        {apps === null ? (
          <p className="px-2 py-8 text-center text-muted-foreground">Loading…</p>
        ) : !configured ? (
          <div className="mx-2 mt-6 rounded-xl border border-border bg-card p-5 text-center">
            <CircleAlert className="mx-auto size-8 text-muted-foreground" />
            <p className="mt-3 font-medium">App hosting isn’t configured</p>
            <p className="mt-1 text-sm text-muted-foreground">Set the public app origin for this Veneer installation.</p>
          </div>
        ) : apps.length === 0 ? (
          <div className="px-2 py-16 text-center">
            <AppWindow className="mx-auto size-10 text-muted-foreground" />
            <p className="mt-3 text-lg font-medium">No apps yet</p>
            <p className="mt-1 text-muted-foreground">
              Ask a chat to build a small dashboard or tool and publish it with <span className="font-medium">publish_app</span>.
            </p>
          </div>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {apps.map((app) => (
              <li key={app.id}>
                <button
                  type="button"
                  onPointerUp={() => onNavigate(`#/apps/${encodeURIComponent(app.id)}`)}
                  className={cn(
                    'flex w-full min-w-0 items-center gap-3 rounded-xl px-3 py-3 text-left transition-colors',
                    app.id === selectedId ? 'bg-accent' : 'active:bg-accent',
                  )}
                >
                  {app.runtime === 'local' ? (
                    <Server className="size-5 shrink-0 text-muted-foreground" />
                  ) : (
                    <Cloud className="size-5 shrink-0 text-muted-foreground" />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{app.title || app.slug}</p>
                    <p className="mt-0.5 flex items-center gap-1.5 truncate text-sm text-muted-foreground">
                      <StatusIcon app={app} />
                      <span className="truncate">
                        {runtimeLabel(app)} · {statusLabel(app)}
                        {app.projectName ? ` · ${app.projectName}` : ''} · {timeAgo(app.updatedAt)}
                      </span>
                    </p>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );

  const detail = selected ? (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-1 border-b border-border px-2 py-2 pt-[calc(env(safe-area-inset-top)+0.5rem)] md:pt-2">
        {!isDesktop ? (
          <Button variant="ghost" size="icon-lg" className="h-11 w-11 shrink-0 rounded-full" onPointerUp={() => onNavigate('#/apps')} aria-label="Back">
            <ChevronLeft className="size-5" />
          </Button>
        ) : null}
        <div className="min-w-0 flex-1 px-2">
          <p className="truncate font-medium">{selected.title || selected.slug}</p>
          <p className="flex items-center gap-1.5 truncate text-xs text-muted-foreground">
            <StatusIcon app={selected} />
            {runtimeLabel(selected)} · {statusLabel(selected)} · {formatBytes(selected.sourceSizeBytes)} · updated{' '}
            {timeAgo(selected.updatedAt)}
          </p>
        </div>
        <Button asChild variant="ghost" size="icon-lg" className="h-11 w-11 shrink-0 rounded-full text-muted-foreground">
          <a
            href={selected.url}
            target={appLinkTarget}
            rel={appLinkTarget ? 'noopener' : undefined}
            aria-label={appLinkTarget ? 'Open in new tab' : 'Open app'}
          >
            <ExternalLink className="size-5" />
          </a>
        </Button>
        <Button
          variant="ghost"
          size="icon-lg"
          className="h-11 w-11 shrink-0 rounded-full text-muted-foreground"
          onPointerUp={() => copyLink(selected.url)}
          aria-label={copied ? 'Link copied' : 'Copy link'}
        >
          {copied ? <Check className="size-5 text-primary" /> : <Copy className="size-5" />}
        </Button>
        {canManage ? (
          <Button
            variant="ghost"
            size="icon-lg"
            className="h-11 w-11 shrink-0 rounded-full text-muted-foreground"
            onPointerUp={() => setConfirmApp(selected)}
            aria-label="Delete app"
          >
            <Trash2 className="size-5" />
          </Button>
        ) : null}
      </header>
      {canManage ? (
        <div className="flex min-h-14 items-center gap-3 border-b px-4 py-2">
          <PanelLeft className="size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <p className="font-medium">Show in sidebar</p>
            <p className="text-pretty text-base/7 text-muted-foreground sm:text-sm/6">Add a direct icon for this Mini App.</p>
          </div>
          {showInSidebar && sidebarItem?.kind === 'app' ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button type="button" variant="ghost" size="icon" aria-label="Choose sidebar icon" disabled={sidebarSaving}>
                  <SidebarIcon className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="bottom" align="end">
                {(Object.entries(MINI_APP_NAVIGATION_ICONS) as Array<
                  [MiniAppNavigationIcon, (typeof MINI_APP_NAVIGATION_ICONS)[MiniAppNavigationIcon]]
                >).map(([key, option]) => {
                  const Icon = option.icon;
                  return (
                    <DropdownMenuItem key={key} onSelect={() => void updateSidebar(true, key)}>
                      <Icon className="size-4 shrink-0" />
                      <span className="min-w-0 flex-1">{option.label}</span>
                      {sidebarItem.icon === key ? <Check className="size-4 shrink-0" /> : null}
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
          <Switch
            checked={showInSidebar}
            onCheckedChange={() => void updateSidebar(!showInSidebar)}
            disabled={sidebarSaving}
            aria-label="Show this Mini App in the sidebar"
          />
        </div>
      ) : null}
      {selected.status === 'error' || selected.runtimeStatus?.status === 'error' || selected.runtimeStatus?.status === 'unavailable' ? (
        <div className="m-auto max-w-lg px-8 text-center">
          <CircleAlert className="mx-auto size-10 text-destructive" />
          <p className="mt-3 text-lg font-medium">
            {selected.runtimeStatus?.status === 'unavailable'
              ? 'Runner unavailable'
              : selected.runtimeStatus?.status === 'error'
                ? 'App failed'
                : 'Deployment failed'}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            {selected.lastError || selected.runtimeStatus?.error || 'Ask the publishing chat to try again.'}
          </p>
        </div>
      ) : selected.status === 'deploying' ? (
        <div className="m-auto max-w-lg px-8 text-center">
          <AppWindow className="mx-auto size-10 text-muted-foreground" />
          <p className="mt-3 text-lg font-medium">App is deploying…</p>
          <p className="mt-1 text-sm text-muted-foreground">The preview will load automatically when it’s ready.</p>
        </div>
      ) : (
        <EmbeddedPreviewFrame
          key={selected.id}
          src={selected.url}
          title={selected.title || selected.slug}
          preserveOrigin
          className="min-h-0 flex-1 border-0 bg-white"
        />
      )}
    </div>
  ) : (
    <SplitPlaceholder title="Select an app" hint="Agents publish private tools with publish_app." />
  );

  return (
    <>
      <SplitView storageKey="split:apps" mobileShows={selected ? 'detail' : 'sidebar'} sidebar={sidebar}>
        {detail}
      </SplitView>
      <Dialog open={confirmApp !== null} onOpenChange={(open) => !open && !deleting && setConfirmApp(null)}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle className="truncate pr-6">Delete {confirmApp?.title || confirmApp?.slug}?</DialogTitle>
            <DialogDescription>
              This removes its {confirmApp?.runtime === 'local' ? 'local process and files' : 'Worker'} and private address. The
              action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="outline" className="h-11 flex-1 rounded-xl" onPointerUp={() => setConfirmApp(null)} disabled={deleting}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              className="h-11 flex-1 rounded-xl"
              onPointerUp={() => confirmApp && void deleteApp(confirmApp)}
              disabled={deleting}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
