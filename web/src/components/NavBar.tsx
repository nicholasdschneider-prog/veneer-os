import { WorkspaceSearchButton } from './BotWorkflows';
import type { LucideIcon } from 'lucide-react';
import {
  Bot,
  Ellipsis,
  MessageSquare,
  Settings,
} from 'lucide-react';
import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { Tooltip as TooltipPrimitive } from 'radix-ui';
import { cn } from '@/lib/utils';
import { api, type SystemUsage } from '@/lib/api';
import { botsApi } from '@/lib/bots';
import { CLIENT_LOGO_CHANGED_EVENT } from '@/lib/clientLogo';
import {
  BUILTIN_NAVIGATION,
  DEFAULT_WORKSPACE_NAVIGATION,
  isNavigationItemAllowed,
  MINI_APP_NAVIGATION_ICONS,
} from '@/lib/navigation';
import type { WorkspaceNavigation } from '@/lib/types';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';
import { VeneerMark } from './VeneerMark';
import { AccountMenu } from './AccountMenuItems';
import { UsageRing } from './UsageRing';
import {
  claudeRingModel,
  codexRingModel,
  ringAriaLabel,
  useUsage,
  type UsageRingModel,
} from '@/lib/useUsage';
import { DESKTOP_QUERY, useMediaQuery } from '../hooks/useMediaQuery';
import { useDocumentScrollLock } from '../hooks/useDocumentScrollLock';

export type NavKey =
  | 'bots'
  | 'chats'
  | 'automations'
  | 'todos'
  | 'pages'
  | 'apps'
  | 'terminal'
  | 'settings';
export type NavSelection = NavKey | `app:${string}`;

type Item = { key: NavSelection; label: string; icon: LucideIcon; hash: string };

const CHATS: Item = { key: 'chats', label: 'Chats', icon: MessageSquare, hash: '#/' };
const BOTS: Item = { key: 'bots', label: 'VeneerBots', icon: Bot, hash: '#/bots' };
const SETTINGS: Item = { key: 'settings', label: 'Settings', icon: Settings, hash: '#/settings' };
const SYSTEM_USAGE_POLL_MS = 5_000;
const BOT_INPUT_POLL_MS = 30_000;
/** Where a usage ring goes when tapped (see resolveSettingsRoute in App.tsx). */
const USAGE_HASH = '#/settings/usage';

/**
 * How many bot decisions are waiting on the signed-in user, across every
 * business. Polled slowly; a route change or tab focus re-probes so the badge
 * clears right after an answer. Failures keep the last known count.
 */
export function useBotInputCount(current: NavSelection): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    let active = true;
    const refresh = () => {
      if (document.hidden) return;
      void botsApi
        .list('me')
        .then((result) => {
          if (!active) return;
          setCount(result.decisions.filter((d) => d.state === 'needs_input').length);
        })
        .catch(() => {
          // Keep the last count; the bots screen surfaces the error itself.
        });
    };
    refresh();
    const interval = window.setInterval(refresh, BOT_INPUT_POLL_MS);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      active = false;
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [current]);
  return count;
}

/** The small count pinned to the VeneerBots icon's corner. */
export function NavCountBadge({ count, label }: { count: number; label: string }) {
  if (count <= 0) return null;
  return (
    <span
      aria-label={label}
      data-testid="bots-input-badge"
      className="absolute top-1/2 left-1/2 flex h-4 min-w-4 -translate-y-[1.15rem] translate-x-[0.15rem] items-center justify-center rounded-full bg-amber-500 px-1 text-[0.625rem] leading-none font-semibold text-black tabular-nums shadow-[0_0_0_2px_var(--card)]"
    >
      {count > 99 ? '99+' : count}
    </span>
  );
}

function DesktopNavigationTooltip({ label, children }: { label: ReactNode; children: ReactElement }) {
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side="right"
          sideOffset={10}
          className="z-50 rounded-lg bg-popover px-2.5 py-1.5 text-xs font-medium text-popover-foreground shadow-lg ring-1 ring-foreground/10 animate-in fade-in-0 zoom-in-95 dark:shadow-none"
        >
          {label}
          <TooltipPrimitive.Arrow className="fill-popover" />
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

export function NavigationBrand({
  clientLogoUrl,
  onLogoError,
}: {
  clientLogoUrl: string | null;
  onLogoError?: () => void;
}) {
  return clientLogoUrl ? (
    <img
      src={clientLogoUrl}
      alt="Client logo"
      draggable={false}
      onError={onLogoError}
      className="size-7 shrink-0 object-contain"
    />
  ) : (
    <VeneerMark className="size-6" />
  );
}

function formatGigabytes(bytes: number): string {
  const gigabytes = bytes / 1024 ** 3;
  return gigabytes >= 10 ? Math.round(gigabytes).toString() : gigabytes.toFixed(1);
}

function SystemUsageMeter() {
  const [usage, setUsage] = useState<SystemUsage | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    const desktop = window.matchMedia('(min-width: 768px)');
    let interval: number | null = null;
    let active = true;

    const refresh = () => {
      if (document.hidden || !desktop.matches) return;
      void api
        .systemUsage()
        .then((result) => {
          if (!active) return;
          setUsage(result.usage);
          setUnavailable(false);
        })
        .catch(() => {
          if (active) setUnavailable(true);
        });
    };
    const syncPolling = () => {
      if (!desktop.matches) {
        if (interval !== null) window.clearInterval(interval);
        interval = null;
        return;
      }
      if (interval !== null) return;
      refresh();
      interval = window.setInterval(refresh, SYSTEM_USAGE_POLL_MS);
    };

    desktop.addEventListener('change', syncPolling);
    document.addEventListener('visibilitychange', refresh);
    syncPolling();
    return () => {
      active = false;
      desktop.removeEventListener('change', syncPolling);
      document.removeEventListener('visibilitychange', refresh);
      if (interval !== null) window.clearInterval(interval);
    };
  }, []);

  const cpu = usage?.cpuPercent == null ? '–' : `${Math.round(usage.cpuPercent)}%`;
  const memory =
    usage && usage.memoryTotalBytes > 0
      ? `${formatGigabytes(usage.memoryUsedBytes)} / ${formatGigabytes(usage.memoryTotalBytes)} GB`
      : '– / – GB';
  const compactMemory =
    usage && usage.memoryTotalBytes > 0
      ? `${formatGigabytes(usage.memoryUsedBytes)}/${formatGigabytes(usage.memoryTotalBytes)}G`
      : '–/–G';
  const label = usage
    ? `System usage: CPU ${cpu}, memory ${memory}${unavailable ? '. Latest update unavailable' : ''}`
    : 'System usage unavailable';

  return (
    <div
      aria-label={label}
      title={label}
      className="hidden w-full px-2 text-muted-foreground tabular-nums md:flex md:flex-col md:gap-0.5"
    >
      <div className="text-center text-[0.625rem]">{cpu}</div>
      <div className="text-center text-[0.5625rem] tracking-tight">{compactMemory}</div>
    </div>
  );
}

/**
 * The rail's subscription meters: Claude's five-hour window, and Codex's weekly
 * below it when that account is connected too. Nothing renders when neither is
 * connected. All workspace roles can view usage.
 */
function UsageRailRings({
  claude,
  codex,
  onNavigate,
}: {
  claude: UsageRingModel | null;
  codex: UsageRingModel | null;
  onNavigate: (hash: string) => void;
}) {
  if (!claude && !codex) return null;
  return (
    <div className="hidden w-full flex-col items-center gap-4 md:flex">
      {[claude, codex].map((model) =>
        model ? (
          <DesktopNavigationTooltip
            key={model.provider}
            label={
              <span className="block">
                {model.primaryText}
                {model.secondaryText ? (
                  <span className="mt-0.5 block font-normal opacity-70">{model.secondaryText}</span>
                ) : null}
              </span>
            }
          >
            <UsageRing
              provider={model.provider}
              percent={model.percent}
              label={model.label}
              unknown={model.unknown}
              showLabel={false}
              ariaLabel={ringAriaLabel(model)}
              onActivate={() => onNavigate(USAGE_HASH)}
            />
          </DesktopNavigationTooltip>
        ) : null,
      )}
    </div>
  );
}

/**
 * App shell with a persistent primary nav (icons only, no labels). On mobile
 * it's a bottom bar; on desktop (md+) it becomes a slim vertical rail on the
 * left. The bar height on mobile is exposed as `--vp-nav-h` (see styles.css)
 * so bottom-pinned overlays (toast) can clear it; that var is 0 on desktop.
 *
 * The mobile bar is deliberately thin: Chats · Claude usage ring · Settings ·
 * More, with every configured destination (Todo, Pages, Apps, Terminal, pinned
 * Mini Apps) behind the More menu. "New chat" is NOT here — it lives top-right
 * of the Chats screen on every size, so the bar can stay three targets wide.
 *
 * `mobileHidden` drops the bar on mobile for the chat screen, which owns the
 * full viewport (composer + safe area) — the rail still shows on desktop.
 */
export function NavShell({
  current,
  canManage,
  onNavigate,
  mobileHidden = false,
  chatOpen = false,
  navigation = DEFAULT_WORKSPACE_NAVIGATION,
  signedInEmail,
  children,
}: {
  current: NavSelection;
  canManage: boolean;
  onNavigate: (hash: string) => void;
  mobileHidden?: boolean;
  /** A conversation is on screen — the only state that earns a usage re-probe. */
  chatOpen?: boolean;
  navigation?: WorkspaceNavigation;
  signedInEmail: string;
  children: ReactNode;
}) {
  const isDesktop = useMediaQuery(DESKTOP_QUERY);
  // Keep the bottom bar pinned: iOS pans the document to reveal a focused
  // field and leaves it there once the keyboard closes.
  useDocumentScrollLock(!isDesktop);
  // One fetch feeds both the rail rings and the mobile bar ring.
  const { usage, now } = useUsage(chatOpen);
  const claudeRing = claudeRingModel(usage, now);
  const codexRing = codexRingModel(usage, now);
  const botInputCount = useBotInputCount(current);
  const [clientLogoUrl, setClientLogoUrl] = useState<string | null>(null);
  const clientLogoUrlRef = useRef<string | null>(null);

  useEffect(() => {
    let active = true;
    let requestId = 0;
    const refresh = () => {
      const currentRequest = ++requestId;
      void api
        .clientLogo()
        .then((logo) => {
          if (!active || currentRequest !== requestId) return;
          const previousUrl = clientLogoUrlRef.current;
          const nextUrl = logo ? URL.createObjectURL(logo) : null;
          clientLogoUrlRef.current = nextUrl;
          setClientLogoUrl(nextUrl);
          if (previousUrl) URL.revokeObjectURL(previousUrl);
        })
        .catch(() => {
          // The built-in mark is already rendered while the logo is unavailable.
        });
    };
    refresh();
    window.addEventListener(CLIENT_LOGO_CHANGED_EVENT, refresh);
    return () => {
      active = false;
      window.removeEventListener(CLIENT_LOGO_CHANGED_EVENT, refresh);
      const objectUrl = clientLogoUrlRef.current;
      clientLogoUrlRef.current = null;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, []);

  const handleClientLogoError = () => {
    const objectUrl = clientLogoUrlRef.current;
    clientLogoUrlRef.current = null;
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    setClientLogoUrl(null);
  };

  const configuredItems: Item[] = navigation.items
    .filter((item) => item.visible && isNavigationItemAllowed(item, canManage))
    .map((item) => {
      if (item.kind === 'builtin') {
        const meta = BUILTIN_NAVIGATION[item.key];
        return { key: item.key, label: meta.label, icon: meta.icon, hash: meta.hash };
      }
      return {
        key: `app:${item.appId}`,
        label: item.label || item.title,
        icon: MINI_APP_NAVIGATION_ICONS[item.icon].icon,
        hash: `#/apps/${encodeURIComponent(item.appId)}`,
      };
    });
  const desktopItems = [CHATS, BOTS, ...configuredItems];
  // Mobile bar, left to right: Chats · VeneerBots · More · Claude ring ·
  // Settings. Every configured item, including Automations and pinned Mini Apps,
  // sits behind More so the
  // bar has room for the usage ring and stays comfortable for thumbs.
  const mobileOverflow = configuredItems;
  const renderItem = (it: Item, desktop = false) => {
    const active = it.key === current;
    const Icon = it.icon;
    const button = (
      <button
        key={desktop ? undefined : it.key}
        type="button"
        onPointerUp={() => onNavigate(it.hash)}
        aria-label={it.label}
        title={desktop ? undefined : it.label}
        aria-current={active ? 'page' : undefined}
        className={cn(
          'relative flex items-center justify-center transition-colors',
          desktop ? 'flex-none py-2.5' : 'flex-1',
          active ? 'text-foreground' : 'text-muted-foreground active:text-foreground',
        )}
      >
        {/* Active indicator: a small bar hugging the nav's top border (right
            edge on the desktop rail, tucked against its right border). */}
        {active ? (
          <span
            className={cn(
              'absolute rounded-full bg-primary',
              desktop
                ? '-right-2 top-1/2 h-7 w-0.5 -translate-y-1/2'
                : 'left-1/2 top-0 h-0.5 w-8 -translate-x-1/2',
            )}
          />
        ) : null}
        <Icon className="size-5 shrink-0" />
        {it.key === 'bots' ? (
          <NavCountBadge
            count={botInputCount}
            label={`${botInputCount} ${botInputCount === 1 ? 'decision needs' : 'decisions need'} your input`}
          />
        ) : null}
      </button>
    );
    return desktop ? (
      <DesktopNavigationTooltip key={it.key} label={it.label}>
        {button}
      </DesktopNavigationTooltip>
    ) : button;
  };
  return (
    <div
      data-desktop-layout={isDesktop || undefined}
      className={cn(
        'flex h-full border-border pr-[env(safe-area-inset-right)] pl-[env(safe-area-inset-left)]',
        isDesktop ? 'flex-row border-t' : 'flex-col-reverse',
      )}
    >
      <nav
        className={cn(
          'shrink-0 items-stretch border-border',
          isDesktop
            ? 'flex h-auto w-[68px] flex-col justify-start gap-2 border-r bg-shell-rail pt-[calc(env(safe-area-inset-top)+0.75rem)] pb-4'
            : 'flex h-[var(--vp-nav-h)] border-t bg-card px-2 pb-[env(safe-area-inset-bottom)]',
          mobileHidden && !isDesktop && 'hidden',
        )}
      >
        <div className="flex shrink-0 items-center justify-center"><WorkspaceSearchButton /></div>
        {/* Desktop: the account menu at the top of the rail. */}
        <div className={cn('text-foreground', isDesktop ? 'order-[-2] mx-auto mb-1 flex h-8 w-12 items-center justify-center' : 'hidden')}>
          <AccountMenu
            email={signedInEmail}
            brand={
              <NavigationBrand
                clientLogoUrl={clientLogoUrl}
                onLogoError={handleClientLogoError}
              />
            }
          />
        </div>
        {/* Mobile: keep the same account affordance at the left edge of the
            bottom bar. Its popover opens upward so it stays inside the viewport. */}
        <div className={cn('relative w-11 shrink-0 items-center justify-center text-foreground', isDesktop ? 'hidden' : 'flex')}>
          <AccountMenu
            email={signedInEmail}
            placement="mobile"
            brand={
              <NavigationBrand
                clientLogoUrl={clientLogoUrl}
                onLogoError={handleClientLogoError}
              />
            }
          />
        </div>
        <div className={cn('flex min-w-0 flex-1 items-stretch', isDesktop && 'min-h-0 flex-col')}>
          <div className={cn('min-w-0 flex-1 items-stretch', isDesktop ? 'hidden' : 'flex')}>
            {renderItem(CHATS)}
            {renderItem(BOTS)}
            {mobileOverflow.length ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    aria-label="More navigation"
                    aria-current={mobileOverflow.some((item) => item.key === current) ? 'page' : undefined}
                    className={cn(
                      'relative flex flex-1 items-center justify-center',
                      mobileOverflow.some((item) => item.key === current)
                        ? 'text-foreground'
                        : 'text-muted-foreground active:text-foreground',
                    )}
                  >
                    {mobileOverflow.some((item) => item.key === current) ? (
                      <span className="absolute top-0 left-1/2 h-0.5 w-8 -translate-x-1/2 rounded-full bg-primary" />
                    ) : null}
                    <Ellipsis className="size-5 shrink-0" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent side="top" align="center" className="mb-1 min-w-52">
                  {mobileOverflow.map((item) => {
                    const Icon = item.icon;
                    return (
                      <DropdownMenuItem key={item.key} onSelect={() => onNavigate(item.hash)}>
                        <Icon className="size-4 shrink-0" />
                        {item.label}
                      </DropdownMenuItem>
                    );
                  })}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
            {/* Claude's 5hr window only: one glanceable meter, no Codex ring and
                no tooltip — the bar is 64px tall and a thumb, not a pointer. */}
            {claudeRing ? (
              <div className="flex flex-1 items-center justify-center">
                <UsageRing
                  provider={claudeRing.provider}
                  percent={claudeRing.percent}
                  label={claudeRing.label}
                  unknown={claudeRing.unknown}
                  size={38}
                  // The bar is only 3.5rem of content: a 38px ring plus a label
                  // fills it edge to edge, so the label goes and the aria-label
                  // (which names the window) carries the meaning instead.
                  showLabel={false}
                  ariaLabel={ringAriaLabel(claudeRing)}
                  onActivate={() => onNavigate(USAGE_HASH)}
                />
              </div>
            ) : null}
            {renderItem(SETTINGS)}
          </div>
          <div className={cn('min-h-0 flex-1 flex-col', isDesktop ? 'flex' : 'hidden')}>
            <TooltipPrimitive.Provider delayDuration={250} skipDelayDuration={100}>
              <div className="-mr-2 flex min-h-0 flex-col gap-2 overflow-y-auto pr-2">
                {desktopItems.map((item) => renderItem(item, true))}
              </div>
              {/* Foot of the rail: subscription rings, then the host's CPU/RAM
                  readout, then the gear. Grouped so the pair share one mt-auto
                  rather than each claiming half the slack between them. */}
              <div className="mt-auto flex w-full flex-col items-center gap-4 pt-3">
                <UsageRailRings claude={claudeRing} codex={codexRing} onNavigate={onNavigate} />
                <SystemUsageMeter />
              </div>
              {renderItem(SETTINGS, true)}
            </TooltipPrimitive.Provider>
          </div>
        </div>
      </nav>
      <main className="relative min-h-0 min-w-0 flex-1">{children}</main>
    </div>
  );
}
