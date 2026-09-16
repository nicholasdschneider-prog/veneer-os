import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { BrowserStartingState } from './BrowserStartingState';
import { Check, ChevronDown, CircleStop, Globe, Loader2, Plus, Radar, Save, ShieldCheck, X } from 'lucide-react';
import { SharpOrb } from '../AgentActivityOrb';
import { DESKTOP_QUERY, useMediaQuery } from '../../hooks/useMediaQuery';
import { api } from '../../lib/api';
import type { VeneerBrowserProfile, VeneerBrowserSession } from '../../lib/types';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import { Switch } from '../ui/switch';

const EMPTY_PROFILES: VeneerBrowserProfile[] = [];
const EMPTY_TABS: ViewerTarget[] = [];

/**
 * Advanced capture grant for one chat's Veneer Browser working copy: when
 * active, the agent may inspect that browser's network traffic (including
 * request headers carrying the user's login tokens). Only the signed-in user
 * can flip it, over their authenticated web session — the agent cannot.
 *
 * NOTE: these two calls live here instead of lib/api.ts only because that file
 * is locked by concurrent work. Fold them into the `api` object (alongside the
 * other veneerBrowserConversation* helpers) once it is free.
 */
export interface VeneerBrowserCaptureGrant {
  active: boolean;
}

export const ADVANCED_CAPTURE_CONFIRM =
  'Let the agent read this browser’s network traffic, including request headers that contain your login tokens, for this chat only?';

async function captureGrantRequest(
  conversationId: string,
  init?: RequestInit,
): Promise<VeneerBrowserCaptureGrant> {
  const res = await fetch(
    `/api/veneer-browser/conversations/${encodeURIComponent(conversationId)}/capture`,
    { headers: { 'Content-Type': 'application/json' }, ...init },
  );
  const body = (await res.json().catch(() => null)) as
    | { ok?: boolean; error?: string; capture?: VeneerBrowserCaptureGrant }
    | null;
  if (!res.ok || !body || body.ok === false || !body.capture) {
    throw new Error(body?.error ?? `Request failed (${res.status})`);
  }
  return body.capture;
}

/** Reads the current grant for this chat's working copy. */
export function fetchConversationCaptureGrant(conversationId: string): Promise<VeneerBrowserCaptureGrant> {
  return captureGrantRequest(conversationId);
}

/** Writes the grant for this chat's working copy. */
export function setConversationCaptureGrant(
  conversationId: string,
  active: boolean,
): Promise<VeneerBrowserCaptureGrant> {
  return captureGrantRequest(conversationId, { method: 'PUT', body: JSON.stringify({ active }) });
}

/**
 * Turning capture on always asks first, because it hands the agent this
 * browser's credentialed traffic. Turning it off never asks. Returns null when
 * the user declines, so no request is made.
 */
export async function toggleConversationCaptureGrant(
  conversationId: string,
  next: boolean,
  confirm: (message: string) => boolean,
): Promise<VeneerBrowserCaptureGrant | null> {
  if (next && !confirm(ADVANCED_CAPTURE_CONFIRM)) return null;
  return await setConversationCaptureGrant(conversationId, next);
}

/** Which chrome the host draws over the viewer's own 44px address row. */
export type ViewerHost = 'desktop' | 'mobile';

/**
 * The viewer draws no tab strip of its own now: this panel owns the tabs, so
 * the embedded page hides both its own chrome frame (`chrome=off`) and its tab
 * strip (`tabs=off`) and reports its tabs over postMessage instead. `host`
 * tells the viewer how much room to reserve inside its address row for our
 * overlay buttons (desktop: 48px right; mobile: 50px left + 92px right).
 */
export function conversationBrowserViewerPath(conversationId: string, host: ViewerHost): string {
  return `/veneer-browser?conversation=${encodeURIComponent(conversationId)}&chrome=off&tabs=off&host=${host}`;
}

/** The LAN-served viewer page with the same layout flags as the tunnel page. */
export function lanBrowserViewerSrc(viewerUrl: string, host: ViewerHost): string {
  return `${viewerUrl}${viewerUrl.includes('?') ? '&' : '?'}chrome=off&tabs=off&host=${host}`;
}

/** This page's own origin, or '' where there is no real browser (tests, SSR). */
function ownOrigin(): string {
  return typeof window !== 'undefined' && window.location ? window.location.origin : '';
}

/** Whether a real browser is around to pick a viewer page in an effect. */
function browserRuntime(): boolean {
  return typeof window !== 'undefined' && !!window.location && typeof fetch === 'function';
}

/** The origin a viewer page will post from, given its src. */
export function viewerOriginOf(src: string): string {
  try {
    return new URL(src, ownOrigin() || 'https://veneer.invalid').origin;
  } catch {
    return ownOrigin();
  }
}

/**
 * How long a LAN-served viewer may stay silent before the panel gives up on it
 * and embeds the tunnel page instead. The LAN page is on the same building
 * network, so a healthy one says "ready" well inside this.
 */
export const LAN_VIEWER_READY_DEADLINE_MS = 2500;
/** After a LAN failure, how long the panel sticks to the tunnel page. */
const LAN_VIEWER_RETRY_MS = 5 * 60 * 1000;
/** Remembered across panels: no LAN door on this host, or it failed recently. */
let lanViewerUnavailableUntil = 0;

/* -------------------------------------------------------------------------- */
/* Viewer <-> host messaging                                                   */
/* -------------------------------------------------------------------------- */

export const VIEWER_MESSAGE_SOURCE = 'veneer-browser-viewer';
export const HOST_MESSAGE_SOURCE = 'veneer-browser-host';

/** One open tab as reported by the embedded viewer. */
export interface ViewerTarget {
  targetId: string;
  title?: string;
  url?: string;
}

export type ViewerMessage =
  | { source: typeof VIEWER_MESSAGE_SOURCE; t: 'targets'; list: ViewerTarget[]; activeId: string | null }
  | { source: typeof VIEWER_MESSAGE_SOURCE; t: 'ready' }
  /** The viewer has drawn its first picture. */
  | { source: typeof VIEWER_MESSAGE_SOURCE; t: 'frame' };

export type HostMessage =
  | { source: typeof HOST_MESSAGE_SOURCE; t: 'activate'; targetId: string }
  | { source: typeof HOST_MESSAGE_SOURCE; t: 'close'; targetId: string }
  | { source: typeof HOST_MESSAGE_SOURCE; t: 'newtab' }
  | { source: typeof HOST_MESSAGE_SOURCE; t: 'capture'; active: boolean };

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * Validates a `message` event payload from the embedded viewer. Anything that
 * is not a well-formed viewer message — including messages from other embeds
 * on the same origin — comes back as null so the caller can ignore it.
 */
export function parseViewerMessage(data: unknown): ViewerMessage | null {
  if (typeof data !== 'object' || data === null) return null;
  const message = data as Record<string, unknown>;
  if (message.source !== VIEWER_MESSAGE_SOURCE) return null;
  if (message.t === 'ready') return { source: VIEWER_MESSAGE_SOURCE, t: 'ready' };
  if (message.t === 'frame') return { source: VIEWER_MESSAGE_SOURCE, t: 'frame' };
  if (message.t !== 'targets' || !Array.isArray(message.list)) return null;
  const list: ViewerTarget[] = [];
  for (const entry of message.list) {
    if (typeof entry !== 'object' || entry === null) continue;
    const target = entry as Record<string, unknown>;
    if (typeof target.targetId !== 'string' || !target.targetId) continue;
    list.push({
      targetId: target.targetId,
      title: optionalString(target.title),
      url: optionalString(target.url),
    });
  }
  return {
    source: VIEWER_MESSAGE_SOURCE,
    t: 'targets',
    list,
    activeId: typeof message.activeId === 'string' ? message.activeId : null,
  };
}

/**
 * Advanced capture only applies to a live working copy, so the toggle stays
 * hidden for a stopped or absent one.
 */
export function captureToggleVisible(session: VeneerBrowserSession | null): boolean {
  return Boolean(session?.temporaryClone && session.active);
}

export function shouldShowConversationBrowserViewer(
  session: VeneerBrowserSession | null,
  busy: boolean,
): boolean {
  return Boolean(session?.active && !busy);
}

export const SAVED_PROFILE_UPDATE_SUCCESS_MS = 2000;
/** How long the start-up screen may cover a viewer that has not drawn yet. */
export const VIEWER_FIRST_FRAME_DEADLINE_MS = 6_000;
/** How long the start-up orb lingers, fading, after the first frame arrives, so
 *  the hand-off to the live page is a soft crossfade rather than a hard cut. */
export const VIEWER_OVERLAY_FADE_MS = 180;

export function savedProfileUpdatePresentation(state: 'idle' | 'saving' | 'updated') {
  if (state === 'updated') return { label: 'Updated', showCheck: true, showSpinner: false };
  if (state === 'saving') return { label: 'Update saved profile', showCheck: false, showSpinner: true };
  return { label: 'Update saved profile', showCheck: false, showSpinner: false };
}

/* -------------------------------------------------------------------------- */
/* Profile chip menu model                                                     */
/* -------------------------------------------------------------------------- */

export type BrowserMenuItem =
  | {
      id: 'update-profile' | 'save-as' | 'stop';
      kind: 'action';
      label: string;
      destructive?: boolean;
      showSpinner?: boolean;
      showCheck?: boolean;
    }
  | { id: 'capture'; kind: 'toggle'; label: string; checked: boolean }
  | { id: string; kind: 'profile'; label: string; profileId: string; selected: boolean }
  | { id: string; kind: 'label'; label: string }
  | { id: string; kind: 'separator' };

export interface BrowserMenuModel {
  /** Second line of the menu's header block, under the profile name. */
  subtitle: string;
  items: BrowserMenuItem[];
}

/**
 * The single home for every profile action, rendered by the chip's dropdown.
 * It is a pure function so the menu's contents stay testable — Radix renders
 * nothing at all while the menu is closed.
 */
export function browserMenuModel(
  session: VeneerBrowserSession,
  opts: {
    capture: boolean;
    updateState: 'idle' | 'saving' | 'updated';
    profiles: VeneerBrowserProfile[];
    tabCount: number | null;
  },
): BrowserMenuModel {
  const state = session.temporaryClone
    ? session.active
      ? 'Browser open'
      : 'Browser stopped'
    : session.active
      ? 'Open'
      : 'Not open';
  const subtitle =
    opts.tabCount === null ? state : `${state} · ${opts.tabCount} ${opts.tabCount === 1 ? 'tab' : 'tabs'}`;

  const items: BrowserMenuItem[] = [];

  if (session.canUpdateProfile) {
    const update = savedProfileUpdatePresentation(opts.updateState);
    items.push({
      id: 'update-profile',
      kind: 'action',
      label: update.label,
      showSpinner: update.showSpinner,
      showCheck: update.showCheck,
    });
  }
  if (session.temporaryClone) {
    items.push({ id: 'save-as', kind: 'action', label: 'Save as new profile…' });
  }
  if (captureToggleVisible(session)) {
    items.push({ id: 'capture', kind: 'toggle', label: 'Advanced capture', checked: opts.capture });
  }

  // A working copy has nowhere to switch to — you get back to the picker by
  // discarding it — so the profile list only shows for a plain session.
  if (!session.temporaryClone && opts.profiles.length > 0) {
    if (items.length > 0) items.push({ id: 'separator:profiles', kind: 'separator' });
    items.push({ id: 'label:profiles', kind: 'label', label: 'Switch profile' });
    for (const profile of opts.profiles) {
      items.push({
        id: `profile:${profile.id}`,
        kind: 'profile',
        label: profile.name,
        profileId: profile.id,
        selected: session.profileId === profile.id,
      });
    }
    items.push({
      id: 'profile:none',
      kind: 'profile',
      label: 'No saved login',
      profileId: '',
      selected: session.profileId === null,
    });
  }

  if (session.temporaryClone) {
    if (items.length > 0) items.push({ id: 'separator:stop', kind: 'separator' });
    items.push({ id: 'stop', kind: 'action', label: 'Stop and discard', destructive: true });
  }

  return { subtitle, items };
}

export function browserChipName(session: VeneerBrowserSession): string {
  if (session.fresh) return 'Signed out';
  return session.profileName ?? 'No saved login';
}

export function browserChipInitial(session: VeneerBrowserSession): string {
  return session.profileName?.trim().charAt(0).toUpperCase() || '—';
}

/**
 * The green dot on the avatar means "a saved login is live in here" — it only
 * shows for a running session that is actually backed by a saved profile.
 */
export function avatarRingVisible(session: VeneerBrowserSession | null): boolean {
  return Boolean(session?.profileId && session.active);
}

/* -------------------------------------------------------------------------- */
/* Tab list model                                                              */
/* -------------------------------------------------------------------------- */

export interface BrowserTabRow {
  targetId: string;
  title: string;
  host: string;
  active: boolean;
}

const BLANK_URL = 'about:blank';

/**
 * One row per open tab, shared by the desktop tab strip and the mobile tab
 * list so both name a tab the same way. A blank tab reads as "New Tab" with no
 * host; anything the URL parser rejects falls back to the raw address.
 */
export function tabListModel(tabs: ViewerTarget[], activeId: string | null): BrowserTabRow[] {
  return tabs.map((tab) => {
    const url = tab.url?.trim() ?? '';
    const blank = !url || url === BLANK_URL;
    let host = '';
    if (!blank) {
      try {
        host = new URL(url).host || url;
      } catch {
        host = url;
      }
    }
    const named = tab.title?.trim();
    const title = named && named !== BLANK_URL ? named : blank ? 'New Tab' : host || url;
    return { targetId: tab.targetId, title, host, active: tab.targetId === activeId };
  });
}

/* -------------------------------------------------------------------------- */
/* Pieces                                                                      */
/* -------------------------------------------------------------------------- */

/** The 48px pointer-coarse target every icon-sized control in here carries. */
function TouchTarget() {
  return (
    <span
      className="pointer-fine:hidden absolute top-1/2 left-1/2 size-[max(100%,3rem)] -translate-1/2"
      aria-hidden="true"
    />
  );
}

function CloseBrowserButton({ onClose, className }: { onClose: () => void; className?: string }) {
  return (
    <Button
      className={cn('relative size-8 shrink-0 sm:size-9', className)}
      variant="ghost"
      size="icon"
      onPointerUp={onClose}
      aria-label="Close browser"
    >
      <X className="size-4 shrink-0" />
      <TouchTarget />
    </Button>
  );
}

/** The brand disc with the profile initial, ringed while a saved login is live. */
function profileAvatarClass(session: VeneerBrowserSession, size: string): string {
  return cn(
    'grid shrink-0 place-items-center rounded-full bg-brand font-semibold text-white',
    size,
    avatarRingVisible(session) && 'ring-2 ring-emerald-500 ring-offset-2 ring-offset-background',
  );
}

/**
 * Every profile action lives in this one menu. The trigger differs by layout —
 * a named chip off the viewer, a bare avatar over it — so callers pass their
 * own trigger contents.
 */
function ProfileMenu({
  session,
  model,
  busy,
  align,
  triggerClassName,
  triggerLabel,
  onSelect,
  children,
}: {
  session: VeneerBrowserSession;
  model: BrowserMenuModel;
  busy: boolean;
  align: 'start' | 'end';
  triggerClassName: string;
  triggerLabel?: string;
  onSelect: (item: BrowserMenuItem) => void;
  children: ReactNode;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className={triggerClassName} aria-label={triggerLabel}>
        {children}
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align} className="min-w-56">
        <DropdownMenuLabel className="text-foreground">
          <span className="block truncate text-sm font-medium">{browserChipName(session)}</span>
          <span className="block truncate text-xs font-normal text-muted-foreground">{model.subtitle}</span>
        </DropdownMenuLabel>
        {model.items.map((item) => {
          if (item.kind === 'separator') return <DropdownMenuSeparator key={item.id} />;
          if (item.kind === 'label') return <DropdownMenuLabel key={item.id}>{item.label}</DropdownMenuLabel>;
          if (item.kind === 'profile') {
            return (
              <DropdownMenuItem key={item.id} disabled={busy} onSelect={() => onSelect(item)}>
                {item.selected ? (
                  <Check className="size-4 shrink-0" />
                ) : (
                  <span className="size-4 shrink-0" aria-hidden="true" />
                )}
                <span className="truncate">{item.label}</span>
              </DropdownMenuItem>
            );
          }
          if (item.kind === 'toggle') {
            return (
              <DropdownMenuItem
                key={item.id}
                className="justify-between gap-3"
                disabled={busy}
                onSelect={(event) => {
                  // Keep the menu open so the switch can be seen landing.
                  event.preventDefault();
                  onSelect(item);
                }}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <Radar className="size-4 shrink-0" />
                  <span className="truncate">{item.label}</span>
                </span>
                {/* The row owns the click; the switch is the state readout. */}
                <span className="pointer-events-none">
                  <Switch checked={item.checked} onCheckedChange={() => undefined} aria-label={item.label} />
                </span>
              </DropdownMenuItem>
            );
          }
          return (
            <DropdownMenuItem
              key={item.id}
              disabled={busy}
              variant={item.destructive ? 'destructive' : 'default'}
              onSelect={() => onSelect(item)}
            >
              {item.id === 'update-profile' ? (
                item.showSpinner ? (
                  <Loader2 className="size-4 shrink-0 animate-spin" />
                ) : item.showCheck ? (
                  <Check className="size-4 shrink-0" />
                ) : (
                  <ShieldCheck className="size-4 shrink-0" />
                )
              ) : null}
              {item.id === 'save-as' ? <Save className="size-4 shrink-0" /> : null}
              {item.id === 'stop' ? <CircleStop className="size-4 shrink-0" /> : null}
              <span className="truncate">{item.label}</span>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ProfileChip({
  session,
  model,
  busy,
  onSelect,
}: {
  session: VeneerBrowserSession;
  model: BrowserMenuModel;
  busy: boolean;
  onSelect: (item: BrowserMenuItem) => void;
}) {
  return (
    <ProfileMenu
      session={session}
      model={model}
      busy={busy}
      align="start"
      triggerClassName="relative flex h-8 shrink-0 items-center gap-1.5 rounded-full pr-2 pl-1 text-sm font-medium hover:bg-muted"
      onSelect={onSelect}
    >
      <span className="grid size-5 shrink-0 place-items-center rounded-full bg-brand text-[0.6875rem] font-semibold text-white">
        {browserChipInitial(session)}
      </span>
      <span className="max-w-40 truncate">{browserChipName(session)}</span>
      <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <TouchTarget />
    </ProfileMenu>
  );
}

/**
 * The per-tab close control. A span, not a button: on desktop it lives inside
 * the tab button, on mobile inside a menu item, and in both cases the pointer
 * events must stop before the parent activates or selects the tab.
 */
function TabCloseControl({
  className,
  iconClassName,
  label,
  onClose,
}: {
  className: string;
  iconClassName: string;
  label: string;
  onClose: () => void;
}) {
  return (
    <span
      role="button"
      aria-label={label}
      className={className}
      onPointerUp={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        onClose();
      }}
    >
      <X className={iconClassName} />
      <TouchTarget />
    </span>
  );
}

/**
 * Chrome-style joined tabs. The active tab shares the iframe address row's
 * background and grows a pair of inverted corners ("feet") so the two read as
 * one surface: an 8px square hanging off each bottom corner, painted with a
 * radial gradient that is transparent inside the corner radius (letting the
 * rail show through) and page-background outside it.
 */
const ACTIVE_TAB_FEET =
  "before:absolute before:bottom-0 before:-left-2 before:size-2 before:content-[''] before:[background:radial-gradient(circle_at_0_0,transparent_8px,var(--background)_8.5px)] " +
  "after:absolute after:bottom-0 after:-right-2 after:size-2 after:content-[''] after:[background:radial-gradient(circle_at_100%_0,transparent_8px,var(--background)_8.5px)]";

function DesktopTabStrip({
  rows,
  onActivate,
  onCloseTab,
}: {
  rows: BrowserTabRow[];
  onActivate: (targetId: string) => void;
  onCloseTab: (targetId: string) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="Open tabs"
      // The -mx/px pair keeps the tabs where they were while giving the
      // scroller room to show the edge tab's feet instead of clipping them.
      className="-mx-2 flex h-9 min-w-0 flex-1 items-stretch overflow-x-auto px-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {rows.map((row, index) => {
        const previous = rows[index - 1];
        return (
          <Fragment key={row.targetId}>
            {previous && !previous.active && !row.active ? (
              <span className="h-4 w-px shrink-0 self-center bg-border" aria-hidden="true" />
            ) : null}
            <button
              type="button"
              role="tab"
              aria-selected={row.active}
              title={row.title}
              className={cn(
                // No `truncate` here: the title span truncates, and hiding
                // this button's overflow would clip the feet off the corners.
                'group relative flex h-9 max-w-48 min-w-24 flex-1 basis-0 items-center gap-2 rounded-t-lg px-3 text-sm font-medium whitespace-nowrap',
                row.active
                  ? `bg-background text-foreground ${ACTIVE_TAB_FEET}`
                  : 'text-muted-foreground hover:bg-background/50',
              )}
              onPointerUp={() => onActivate(row.targetId)}
            >
              <Globe className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate text-left">{row.title}</span>
              <TabCloseControl
                className={cn(
                  'relative grid size-5 shrink-0 place-items-center rounded hover:bg-muted',
                  !row.active && 'invisible group-hover:visible',
                )}
                iconClassName="size-3 shrink-0"
                label={`Close ${row.title}`}
                onClose={() => onCloseTab(row.targetId)}
              />
            </button>
          </Fragment>
        );
      })}
    </div>
  );
}

/** Mobile has no room for a strip, so the tabs live behind a counted button. */
function MobileTabMenu({
  rows,
  onActivate,
  onCloseTab,
  onNewTab,
}: {
  rows: BrowserTabRow[];
  onActivate: (targetId: string) => void;
  onCloseTab: (targetId: string) => void;
  onNewTab: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="relative grid size-10 shrink-0 place-items-center"
        aria-label={`${rows.length} open tabs`}
      >
        <span className="grid size-[22px] place-items-center rounded-md text-xs font-semibold tabular-nums ring-[1.5px] ring-current ring-inset">
          {rows.length}
        </span>
        <TouchTarget />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-72 max-w-[calc(100vw-1rem)]">
        {rows.map((row) => (
          <DropdownMenuItem
            key={row.targetId}
            className={cn('h-11 gap-2.5', row.active && 'bg-muted')}
            onSelect={() => onActivate(row.targetId)}
          >
            <Globe className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate font-medium">{row.title}</span>
              <span className="truncate text-xs text-muted-foreground">{row.host}</span>
            </span>
            <TabCloseControl
              className="relative grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-background"
              iconClassName="size-3.5 shrink-0"
              label={`Close ${row.title}`}
              onClose={() => onCloseTab(row.targetId)}
            />
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onNewTab}>
          <Plus className="size-4 shrink-0" />
          <span className="truncate">New tab</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ProfileSelect({
  session,
  profiles,
  busy,
  large,
  onChange,
}: {
  session: VeneerBrowserSession;
  profiles: VeneerBrowserProfile[];
  busy: boolean;
  large?: boolean;
  onChange: (profileId: string) => void;
}) {
  return (
    <label className={cn('inline-flex max-w-full items-center gap-1.5', large && 'text-xl font-semibold')}>
      <select
        name="browser-profile"
        aria-label="Browser profile"
        className={cn(
          'max-w-full appearance-none bg-transparent [field-sizing:content]',
          large ? 'py-1 text-xl font-semibold' : 'text-sm',
        )}
        value={session.profileId ?? ''}
        disabled={busy || session.temporaryClone}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">No saved login</option>
        {profiles.map((profile) => (
          <option key={profile.id} value={profile.id}>{profile.name}</option>
        ))}
      </select>
      <ChevronDown className="size-4 shrink-0 stroke-muted-foreground" aria-hidden="true" />
    </label>
  );
}

function BrowserEmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-5 p-6 text-center">
      <span className="flex size-18 shrink-0 items-center justify-center" aria-hidden="true">
        <SharpOrb state="searching" cssSize={72} />
      </span>
      {children}
    </div>
  );
}

export function ConversationBrowserPanel({
  conversationId,
  onClose,
  onToast,
  initialSession = null,
  initialProfiles = EMPTY_PROFILES,
  initialCapture = false,
  initialTabs = EMPTY_TABS,
  initialActiveTabId = null,
}: {
  conversationId: string;
  onClose: () => void;
  onToast: (message: string) => void;
  initialSession?: VeneerBrowserSession | null;
  initialProfiles?: VeneerBrowserProfile[];
  initialCapture?: boolean;
  /** First paint only: the live viewer replaces these with its own `targets`. */
  initialTabs?: ViewerTarget[];
  initialActiveTabId?: string | null;
}) {
  const isDesktop = useMediaQuery(DESKTOP_QUERY);
  const [session, setSession] = useState<VeneerBrowserSession | null>(initialSession);
  const [profiles, setProfiles] = useState<VeneerBrowserProfile[]>(initialProfiles);
  const [capture, setCapture] = useState(initialCapture);
  const [busy, setBusy] = useState(false);
  // Only an open shows the start-up screen; other busy actions keep their buttons.
  const [opening, setOpening] = useState(false);
  // The start-up screen stays over the viewer until it has drawn a picture, or
  // until a generous deadline passes so a stuck viewer can still show its own
  // status text.
  const [viewerLive, setViewerLive] = useState(false);
  // The orb overlay covers the iframe until the first frame, then lingers one
  // fade before unmounting so the live page appears through a soft crossfade.
  const [overlayFading, setOverlayFading] = useState(false);
  // The over-the-iframe start-up orb waits a short grace before appearing, so a
  // quick re-attach (revisit to an already-running browser) never flashes it —
  // only a genuinely slow cold start outlives the grace.

  const [updatingProfile, setUpdatingProfile] = useState(false);
  const [profileUpdated, setProfileUpdated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewerKey, setViewerKey] = useState(0);
  const [tabs, setTabs] = useState<ViewerTarget[]>(initialTabs);
  const [activeTabId, setActiveTabId] = useState<string | null>(initialActiveTabId);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const captureRef = useRef(capture);
  captureRef.current = capture;

  const load = useCallback(async () => {
    const result = await api.veneerBrowserConversation(conversationId);
    setSession(result.session);
    const available = await api.veneerBrowserConversationProfiles(conversationId);
    setProfiles(available.profiles);
    if (!captureToggleVisible(result.session)) {
      setCapture(false);
      return;
    }
    // Piggybacks the 3s poll. A failed read leaves the last known state rather
    // than breaking the panel; writes surface their errors through action().
    const grant = await fetchConversationCaptureGrant(conversationId).catch(() => null);
    if (grant) setCapture(grant.active);
  }, [conversationId]);

  useEffect(() => {
    setSession(null);
    setProfiles([]);
    setCapture(false);
    setError(null);
    void load().catch((err: Error) => setError(err.message));
    const timer = window.setInterval(() => void load().catch(() => undefined), 3_000);
    return () => window.clearInterval(timer);
  }, [load]);

  useEffect(() => {
    if (!profileUpdated) return;
    const timer = window.setTimeout(() => setProfileUpdated(false), SAVED_PROFILE_UPDATE_SUCCESS_MS);
    return () => window.clearTimeout(timer);
  }, [profileUpdated]);

  // Which viewer page the frame shows: the tunnel page (same origin) or, when
  // this host has a LAN door and the browser can reach it, the LAN page.
  const [viewerSrc, setViewerSrc] = useState<string | null>(null);
  const viewerOriginRef = useRef(ownOrigin());
  const viewerReadyRef = useRef(false);

  const postToViewer = useCallback((message: HostMessage) => {
    iframeRef.current?.contentWindow?.postMessage(message, viewerOriginRef.current);
  }, []);

  // The viewer reports its tabs; anything else on the page that shouts at this
  // window is ignored. Only the origin the frame was pointed at is trusted.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== viewerOriginRef.current) return;
      const frame = iframeRef.current;
      if (!frame || !event.source || event.source !== frame.contentWindow) return;
      const message = parseViewerMessage(event.data);
      if (!message) return;
      viewerReadyRef.current = true;
      if (message.t === 'targets') {
        // Tabs can arrive before the first picture; do not drop the orb yet, or
        // the black "waiting for the first frame" screen shows through.
        setTabs(message.list);
        setActiveTabId(message.activeId);
        return;
      }
      if (message.t === 'frame') {
        // A real frame means a picture is on the canvas — now fade to the page.
        setViewerLive(true);
        return;
      }
      postToViewer({ source: HOST_MESSAGE_SOURCE, t: 'capture', active: captureRef.current });
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [postToViewer]);

  const showingViewer = shouldShowConversationBrowserViewer(session, busy);
  // The host layout is baked into the viewer's URL (it reserves room for our
  // overlays), so a size change has to remount the frame.
  const viewerHost: ViewerHost = isDesktop ? 'desktop' : 'mobile';
  const viewerFrameKey = `${conversationId}:${session?.profileId ?? ''}:${viewerKey}:${viewerHost}`;

  // A remounted or hidden viewer has no tabs to speak of until it says so.
  useEffect(() => {
    setTabs([]);
    setActiveTabId(null);
    setViewerLive(false);
    setOverlayFading(false);
    if (!showingViewer) return;
    const deadline = setTimeout(() => setViewerLive(true), VIEWER_FIRST_FRAME_DEADLINE_MS);
    return () => clearTimeout(deadline);
  }, [viewerFrameKey, showingViewer]);

  // Once the first frame arrives, fade the orb overlay out over the live page,
  // then unmount it. Until then it covers the iframe from the very first paint.
  useEffect(() => {
    if (!viewerLive) return;
    setOverlayFading(true);
    const done = setTimeout(() => setOverlayFading(false), VIEWER_OVERLAY_FADE_MS);
    return () => clearTimeout(done);
  }, [viewerLive]);

  // Pick the viewer page for this mount. Ask the app for a LAN page first;
  // if there is none, or the LAN page never says "ready", use the tunnel page
  // and leave the LAN alone for a while. The start-up screen covers the wait.
  useEffect(() => {
    if (!showingViewer) {
      setViewerSrc(null);
      return;
    }
    let cancelled = false;
    let readyTimer: ReturnType<typeof setTimeout> | null = null;
    const tunnelSrc = conversationBrowserViewerPath(conversationId, viewerHost);
    const useTunnel = () => {
      viewerOriginRef.current = ownOrigin();
      setViewerSrc(tunnelSrc);
    };
    viewerReadyRef.current = false;
    if (Date.now() < lanViewerUnavailableUntil) {
      useTunnel();
      return;
    }
    void api.lanVeneerBrowserViewer(conversationId).then((viewerUrl) => {
      if (cancelled) return;
      if (!viewerUrl) {
        lanViewerUnavailableUntil = Date.now() + LAN_VIEWER_RETRY_MS;
        useTunnel();
        return;
      }
      const src = lanBrowserViewerSrc(viewerUrl, viewerHost);
      viewerOriginRef.current = viewerOriginOf(src);
      setViewerSrc(src);
      readyTimer = setTimeout(() => {
        if (cancelled || viewerReadyRef.current) return;
        lanViewerUnavailableUntil = Date.now() + LAN_VIEWER_RETRY_MS;
        useTunnel();
      }, LAN_VIEWER_READY_DEADLINE_MS);
    }).catch(() => {
      if (cancelled) return;
      lanViewerUnavailableUntil = Date.now() + LAN_VIEWER_RETRY_MS;
      useTunnel();
    });
    return () => {
      cancelled = true;
      if (readyTimer) clearTimeout(readyTimer);
    };
  }, [viewerFrameKey, showingViewer, conversationId, viewerHost]);

  useEffect(() => {
    if (!showingViewer) return;
    postToViewer({ source: HOST_MESSAGE_SOURCE, t: 'capture', active: capture });
  }, [capture, showingViewer, viewerFrameKey, postToViewer]);

  const action = async (task: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await task();
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const attach = (profileId: string) => {
    if (!profileId || profileId === session?.profileId) return;
    void action(async () => {
      await api.selectVeneerBrowserConversationProfile(conversationId, profileId);
      onToast('Selected the saved browser profile for this chat.');
    });
  };

  const openSavedCopy = () => {
    setOpening(true);
    void action(async () => {
      await api.openVeneerBrowserConversation(conversationId);
      setViewerKey((value) => value + 1);
    }).finally(() => setOpening(false));
  };

  const openFresh = () => {
    setOpening(true);
    void action(async () => {
      await api.openFreshVeneerBrowserConversation(conversationId);
      setViewerKey((value) => value + 1);
      onToast('Opened a signed-out browser.');
    }).finally(() => setOpening(false));
  };

  const saveAs = () => {
    const name = window.prompt('Name this saved browser profile')?.trim();
    if (!name) return;
    void action(async () => {
      await api.saveVeneerBrowserConversationAs(conversationId, name);
      onToast(`Saved “${name}” as a reusable browser profile.`);
    });
  };

  const updateSavedProfile = (current: VeneerBrowserSession) => {
    if (!window.confirm(`Update “${current.profileName}” with this working copy? Use this only after you completed a new login.`)) return;
    setProfileUpdated(false);
    setUpdatingProfile(true);
    void action(async () => {
      await api.updateVeneerBrowserConversationProfile(conversationId);
      setProfileUpdated(true);
      onToast(`Updated “${current.profileName}”.`);
    }).finally(() => setUpdatingProfile(false));
  };

  const toggleCapture = () => void action(async () => {
    const granted = await toggleConversationCaptureGrant(
      conversationId,
      !captureRef.current,
      (message) => window.confirm(message),
    );
    if (!granted) return;
    setCapture(granted.active);
    onToast(granted.active
      ? 'Advanced capture on. The agent can read this browser’s network traffic for this chat.'
      : 'Advanced capture off. The agent can no longer read this browser’s network traffic.');
  });

  const stopAndDiscard = () => void action(async () => {
    await api.stopVeneerBrowserConversation(conversationId);
    onToast('Discarded the temporary browser copy.');
  });

  const runMenuItem = (current: VeneerBrowserSession, item: BrowserMenuItem) => {
    if (item.kind === 'profile') return attach(item.profileId);
    if (item.kind === 'toggle') return toggleCapture();
    if (item.kind !== 'action') return;
    if (item.id === 'update-profile') return updateSavedProfile(current);
    if (item.id === 'save-as') return saveAs();
    if (item.id === 'stop') return stopAndDiscard();
  };

  const menu = session
    ? browserMenuModel(session, {
        capture,
        updateState: updatingProfile ? 'saving' : profileUpdated ? 'updated' : 'idle',
        profiles,
        tabCount: showingViewer && tabs.length > 0 ? tabs.length : null,
      })
    : null;

  const tabRows = tabListModel(tabs, activeTabId);
  const activateTab = (targetId: string) => postToViewer({ source: HOST_MESSAGE_SOURCE, t: 'activate', targetId });
  const closeTab = (targetId: string) => postToViewer({ source: HOST_MESSAGE_SOURCE, t: 'close', targetId });
  const openNewTab = () => postToViewer({ source: HOST_MESSAGE_SOURCE, t: 'newtab' });

  // While the viewer is up, our chrome merges into the page: desktop draws a
  // tab strip that sits flush on the iframe's own address row, mobile draws
  // nothing here at all and puts everything in overlays. Every other state
  // keeps the plain chip-and-close toolbar.
  const header =
    session && menu ? (
      showingViewer ? (
        isDesktop ? (
          <header className="flex shrink-0 items-center gap-1 bg-shell-rail px-2 pt-1.5">
            <Button
              className="relative size-8 shrink-0 rounded-lg hover:bg-background/60"
              variant="ghost"
              size="icon"
              aria-label="New tab"
              onPointerUp={openNewTab}
            >
              <Plus className="size-4 shrink-0" />
              <TouchTarget />
            </Button>
            <DesktopTabStrip rows={tabRows} onActivate={activateTab} onCloseTab={closeTab} />
            <CloseBrowserButton
              className="size-8 rounded-lg hover:bg-background/60 sm:size-8"
              onClose={onClose}
            />
          </header>
        ) : null
      ) : (
        <header className="flex min-h-11 shrink-0 items-center gap-1 border-b border-border bg-shell-sidebar px-2 pt-[calc(env(safe-area-inset-top)+1.25rem)] md:pt-0">
          <ProfileChip session={session} model={menu} busy={busy} onSelect={(item) => runMenuItem(session, item)} />
          <div className="min-w-0 flex-1" />
          <CloseBrowserButton onClose={onClose} />
        </header>
      )
    ) : (
      <div className="absolute top-[calc(env(safe-area-inset-top)+0.5rem)] right-2 z-10 md:top-2">
        <CloseBrowserButton onClose={onClose} />
      </div>
    );

  // The desktop profile control and mobile controls ride on the viewer's 44px
  // address row, inside the space it reserved for them for this `host`.
  const overlays =
    session && menu ? (
      isDesktop ? (
        <div className="absolute top-0 right-2 z-10 flex h-11 items-center">
          <ProfileMenu
            session={session}
            model={menu}
            busy={busy}
            align="end"
            triggerLabel="Browser profile"
            triggerClassName={cn('relative text-[0.6875rem]', profileAvatarClass(session, 'size-8'))}
            onSelect={(item) => runMenuItem(session, item)}
          >
            {browserChipInitial(session)}
            <TouchTarget />
          </ProfileMenu>
        </div>
      ) : (
        <>
          <div className="absolute top-0 left-1.5 z-10 flex h-11 items-center">
            <ProfileMenu
              session={session}
              model={menu}
              busy={busy}
              align="start"
              triggerLabel="Browser profile"
              triggerClassName="relative grid size-10 shrink-0 place-items-center"
              onSelect={(item) => runMenuItem(session, item)}
            >
              <span className={cn('text-[0.625rem]', profileAvatarClass(session, 'size-6'))}>
                {browserChipInitial(session)}
              </span>
              <TouchTarget />
            </ProfileMenu>
          </div>
          <div className="absolute top-0 right-1.5 z-10 flex h-11 items-center gap-0.5">
            <MobileTabMenu
              rows={tabRows}
              onActivate={activateTab}
              onCloseTab={closeTab}
              onNewTab={openNewTab}
            />
            <CloseBrowserButton className="size-10 sm:size-10" onClose={onClose} />
          </div>
        </>
      )
    ) : null;

  return (
    <section className="relative flex h-full min-h-0 flex-col bg-background" aria-label="Chat Veneer Browser">
      {header}

      {!session ? <div className="flex flex-1 items-center justify-center"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div> : null}
      {session && !session.configured ? <div className="m-4 rounded-xl border p-4 text-sm text-muted-foreground">Veneer Browser is not configured on this client.</div> : null}
      {(error || session?.error) ? <div className="m-3 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error ?? session?.error}</div> : null}

      {session && showingViewer ? (
        // Mobile has no toolbar of its own, so the safe-area band lives here,
        // above the frame; the overlays anchor to the frame's own top edge.
        <div
          className={cn(
            'flex min-h-0 flex-1 flex-col bg-background',
            !isDesktop && 'pt-[calc(env(safe-area-inset-top)+1.25rem)]',
          )}
        >
          <div className="relative min-h-0 flex-1">
            {viewerSrc || !browserRuntime() ? (
              <iframe
                key={`${viewerFrameKey}:${viewerSrc ?? 'tunnel'}`}
                ref={iframeRef}
                title={`Veneer Browser — ${session.profileName ?? 'Chat browser'}`}
                src={viewerSrc ?? conversationBrowserViewerPath(conversationId, viewerHost)}
                className="h-full w-full border-0"
                allow="clipboard-read; clipboard-write"
              />
            ) : null}
            {overlays}
            {!viewerLive || overlayFading ? (
              <div
                className="vp-browser-overlay absolute inset-0 z-10 flex flex-col bg-background"
                data-live={viewerLive ? 'true' : undefined}
              >
                <BrowserStartingState onClose={isDesktop ? undefined : onClose} />
              </div>
            ) : null}
          </div>
        </div>
      ) : session?.configured && (opening || session.status === 'starting') ? (
        <BrowserStartingState />
      ) : session?.temporaryClone ? (
        <BrowserEmptyState>
          <ProfileSelect session={session} profiles={profiles} busy={busy} large onChange={attach} />
          <p className="max-w-[36ch] text-pretty text-base text-muted-foreground sm:text-sm">This browser is stopped.</p>
          <Button size="lg" className="h-10 px-5 text-base font-semibold" disabled={busy} onPointerUp={openSavedCopy}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : null}
            Reopen browser
          </Button>
        </BrowserEmptyState>
      ) : session?.profileId ? (
        <BrowserEmptyState>
          <ProfileSelect session={session} profiles={profiles} busy={busy} large onChange={attach} />
          <div className="flex w-full max-w-64 flex-col items-center gap-2.5">
            <Button size="lg" className="h-10 w-full px-5 text-base font-semibold" disabled={busy} onPointerUp={openSavedCopy}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : null}
              Open browser
            </Button>
            <Button
              variant="link"
              className="relative h-auto p-0 text-sm font-normal text-muted-foreground"
              disabled={busy}
              onPointerUp={openFresh}
            >
              Open signed-out
              <TouchTarget />
            </Button>
          </div>
        </BrowserEmptyState>
      ) : session?.configured ? (
        <BrowserEmptyState>
          <ProfileSelect session={session} profiles={profiles} busy={busy} large onChange={attach} />
          <p className="max-w-[40ch] text-pretty text-base text-muted-foreground sm:text-sm">
            Opens signed out. Save a login after you sign in if you want to reuse it.
          </p>
          <Button size="lg" className="h-10 px-5 text-base font-semibold" disabled={busy} onPointerUp={openFresh}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : null}
            Open signed-out browser
          </Button>
        </BrowserEmptyState>
      ) : null}
    </section>
  );
}
