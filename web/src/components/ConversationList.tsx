import { Fragment, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import {
  Archive,
  ArchiveRestore,
  Bot,
  ChevronRight,
  Ellipsis,
  HatGlasses,
  LoaderCircle,
  Mail,
  Minimize2,
  Pin,
  Trash2,
  Undo2,
} from 'lucide-react';
import { api } from '../lib/api';
import { chatActionLabels, chatDeleteConfirmation } from '../lib/chatDeletion';
import {
  cancelArchive,
  isArchiveCommitted,
  isArchivePending,
  pendingArchiveVersion,
  scheduleArchive,
  subscribePendingArchive,
} from '../lib/pendingArchive';
import { isProvider } from '../lib/modelLabel';
import { ProviderIcon } from './ProviderIcon';
import type { Conversation } from '../lib/types';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { AgentActivityOrb } from './AgentActivityOrb';
import { CreatorAvatar } from './CreatorAvatar';
import { AgentWakeupClock } from './chat/AgentWakeupClock';
import { useChatAppearance, type ChatListIconMode } from '../lib/chatAppearance';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

// SQLite datetime('now') is UTC without a zone suffix.
function parseDbDate(iso: string): Date {
  return new Date(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`);
}

/** Local calendar day, so "today's chats" matches what the user means by today. */
function isToday(iso: string): boolean {
  const d = parseDbDate(iso);
  const now = new Date();
  return (
    d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
  );
}

function timeAgo(iso: string): string {
  const mins = Math.max(0, Math.round((Date.now() - parseDbDate(iso).getTime()) / 60_000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

// Recency bucket for list grouping. Calendar days (not 24h windows), so a
// chat from last night shows under Yesterday even 10 hours later.
function groupLabel(iso: string): string {
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOfDay(new Date()) - startOfDay(parseDbDate(iso))) / 86_400_000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return 'This week';
  if (days < 31) return 'This month';
  return 'Older';
}

// The list arrives sorted by recency, so buckets are contiguous runs.
function groupByRecency(conversations: Conversation[]): { label: string; items: Conversation[] }[] {
  const groups: { label: string; items: Conversation[] }[] = [];
  for (const c of conversations) {
    const label = groupLabel(c.lastActiveAt);
    const last = groups[groups.length - 1];
    if (last?.label === label) last.items.push(c);
    else groups.push({ label, items: [c] });
  }
  return groups;
}

// Mirrors the server's list order: pinned first (by manual position), then the
// requested timestamp. Project lists use creation time so live activity does
// not move their rows; loose chats keep using recency.
// Used to keep optimistic pin/reorder updates in the same order the next poll returns.
function sortConversations(list: Conversation[], orderBy: 'activity' | 'created'): Conversation[] {
  return [...list].sort((a, b) => {
    if ((a.pinOrder != null) !== (b.pinOrder != null)) return a.pinOrder != null ? -1 : 1;
    if (a.pinOrder != null && b.pinOrder != null && a.pinOrder !== b.pinOrder) return a.pinOrder - b.pinOrder;
    const aTimestamp = orderBy === 'created' ? a.createdAt : a.lastActiveAt;
    const bTimestamp = orderBy === 'created' ? b.createdAt : b.lastActiveAt;
    return parseDbDate(bTimestamp).getTime() - parseDbDate(aTimestamp).getTime();
  });
}

/** Updates one chat's pinned state and returns the list in server display order. */
export async function updateConversationPin(
  conversations: Conversation[],
  conversation: Conversation,
  orderBy: 'activity' | 'created',
): Promise<Conversation[]> {
  const result = await api.updateConversation(conversation.id, { pinned: conversation.pinOrder == null });
  return sortConversations(
    conversations.map((item) =>
      item.id === result.conversation.id ? result.conversation : item,
    ),
    orderBy,
  );
}

function conversationHierarchy(
  conversations: Conversation[],
  orderBy: 'activity' | 'created',
  archivedView: boolean,
) {
  const visible = sortConversations(
    conversations.filter((c) => !isArchiveCommitted(c.id)),
    orderBy,
  );
  const ids = new Set(visible.map((c) => c.id));
  const childrenOf = new Map<string, Conversation[]>();

  if (!archivedView) {
    for (const c of visible) {
      const origin = c.originConversationId;
      if (!origin || origin === c.id || !ids.has(origin) || c.pinOrder != null) continue;
      childrenOf.set(origin, [...(childrenOf.get(origin) ?? []), c]);
    }
    // Oldest first, the order the agent spawned them.
    for (const kids of childrenOf.values())
      kids.sort((a, b) => parseDbDate(a.createdAt).getTime() - parseDbDate(b.createdAt).getTime());
  }

  const nestedIds = new Set([...childrenOf.values()].flat().map((c) => c.id));
  return {
    visible,
    childrenOf,
    topLevel: visible.filter((c) => !nestedIds.has(c.id)),
  };
}

/** Pagination facts for project chat lists, where handoff children use their own disclosure. */
export function getConversationListPagination(
  conversations: Conversation[],
  selectedId: string | null,
  orderBy: 'activity' | 'created' = 'activity',
): { topLevelCount: number; selectedTopLevelIndex: number } {
  const { childrenOf, topLevel } = conversationHierarchy(conversations, orderBy, false);
  const parentOf = new Map<string, string>();
  for (const [parentId, children] of childrenOf)
    for (const child of children) parentOf.set(child.id, parentId);

  let selectedTopLevelId = selectedId;
  const visited = new Set<string>();
  while (selectedTopLevelId && parentOf.has(selectedTopLevelId) && !visited.has(selectedTopLevelId)) {
    visited.add(selectedTopLevelId);
    selectedTopLevelId = parentOf.get(selectedTopLevelId) ?? null;
  }

  return {
    topLevelCount: topLevel.length,
    selectedTopLevelIndex: selectedTopLevelId
      ? topLevel.findIndex((conversation) => conversation.id === selectedTopLevelId)
      : -1,
  };
}

function StatusDot({
  status,
  activity = null,
  unread = false,
}: {
  status: Conversation['status'];
  activity?: Conversation['activity'];
  unread?: boolean;
}) {
  if (activity === 'compacting' || status === 'working') {
    return (
      <AgentActivityOrb
        state="working"
        size={20}
        className="shrink-0"
        aria-label={activity === 'compacting' ? 'Compacting…' : 'Working…'}
        aria-hidden
      />
    );
  }
  if (status === 'needs_you') return <span className="inline-block size-1.5 rounded-full bg-amber-500" />;
  if (status === 'failed') {
    return (
      <span
        role="img"
        aria-label="Failed"
        className="flex size-2.5 items-center justify-center text-[13px] font-extrabold leading-none text-destructive"
      >
        !
      </span>
    );
  }
  if (unread) {
    return (
      <span
        className="inline-block size-1.5 rounded-full bg-brand"
        title="Unread"
        aria-label="Unread"
      />
    );
  }
  return null;
}

function hasUnreadDescendant(parentId: string, childrenOf: Map<string, Conversation[]>): boolean {
  const kids = childrenOf.get(parentId);
  if (!kids?.length) return false;
  return kids.some((child) => child.unread || hasUnreadDescendant(child.id, childrenOf));
}

function ConversationIcon({
  conversation,
  mode,
  active = false,
}: {
  conversation: Conversation;
  mode: ChatListIconMode;
  /** Unread or busy rows show the brand-colour glyph so they pop in the list. */
  active?: boolean;
}) {
  if (mode === 'creator') {
    return (
      <CreatorAvatar
        name={conversation.creator.displayName}
        ariaLabel={`Created by ${conversation.creator.displayName}`}
        className="size-4 text-[9px]"
      />
    );
  }
  return conversation.provider && isProvider(conversation.provider) ? (
    <ProviderIcon
      provider={conversation.provider}
      variant={active ? 'color' : 'mono'}
      className="size-3.5 shrink-0 text-muted-foreground"
    />
  ) : (
    <Bot className="size-3.5 shrink-0 text-muted-foreground" />
  );
}

export function ConversationRowMenuItems({
  conversation,
  compacting,
  onTogglePin,
  onMarkUnread,
  onCompact,
  onArchive,
  onDelete,
}: {
  conversation: Conversation;
  compacting: boolean;
  onTogglePin: () => void;
  onMarkUnread: () => void;
  onCompact: () => void;
  onArchive: () => void;
  onDelete: () => void;
}) {
  const isCompacting = compacting || conversation.activity === 'compacting';
  const pinned = conversation.pinOrder != null;
  const labels = chatActionLabels(pinned, false);
  const supported = conversation.provider === 'claude' || conversation.provider === 'codex';
  const turnRunning = conversation.status === 'working' || conversation.status === 'needs_you';
  const compactDisabled = isCompacting || turnRunning || !supported;
  return (
    <>
      <DropdownMenuItem onSelect={onTogglePin}>
        <Pin className={cn('size-4', pinned && 'fill-current')} />
        {labels.pin}
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={onMarkUnread}>
        <Mail className="size-4" />
        Mark as unread
      </DropdownMenuItem>
      <DropdownMenuItem
        disabled={compactDisabled}
        title={
          !supported
            ? 'Available for Claude and Codex chats.'
            : isCompacting
              ? 'Context compaction is running.'
              : turnRunning
                ? 'Wait for the current reply to finish.'
                : undefined
        }
        onSelect={onCompact}
      >
        {isCompacting ? (
          <LoaderCircle className="size-4 shrink-0 animate-spin" />
        ) : (
          <Minimize2 className="size-4 shrink-0" />
        )}
        {isCompacting
          ? 'Compacting context…'
          : supported
            ? 'Compact context'
            : 'Context compaction unavailable'}
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={onArchive}>
        <Archive className="size-4" />
        {labels.archive}
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem variant="destructive" onSelect={onDelete}>
        <Trash2 className="size-4" />
        {labels.delete}
      </DropdownMenuItem>
    </>
  );
}

function Row({
  c,
  iconMode,
  onOpen,
  archivedView,
  selectedId,
  focusedId,
  onTogglePin,
  onMarkUnreadAction,
  onCompactAction,
  onArchiveAction,
  onDeleteAction,
  onUndoArchive,
  pendingArchive = false,
  compacting = false,
}: {
  c: Conversation;
  iconMode: ChatListIconMode;
  onOpen: (id: string) => void;
  archivedView: boolean;
  selectedId: string | null;
  /** Briefly reveals this row after returning from Mark as unread. */
  focusedId: string | null;
  /** Immediate pin/unpin toggle (hidden in the archived view). */
  onTogglePin: (c: Conversation) => void;
  onMarkUnreadAction: (c: Conversation) => void;
  onCompactAction: (c: Conversation) => void;
  /** Active view: archives immediately. Archived view: opens the restore/delete dialog. */
  onArchiveAction: (c: Conversation) => void;
  /** Opens the permanent-delete confirmation from an active chat's action menu. */
  onDeleteAction: (c: Conversation) => void;
  /** Cancels a pending archive during the grace period (active view only). */
  onUndoArchive?: (c: Conversation) => void;
  /** True while this row is counting down to archive — shown greyed with an Undo affordance. */
  pendingArchive?: boolean;
  compacting?: boolean;
}) {
  const rowRef = useRef<HTMLLIElement>(null);
  const focused = c.id === focusedId;
  const [focusHighlight, setFocusHighlight] = useState(focused);

  useEffect(() => {
    if (!focused) {
      setFocusHighlight(false);
      return;
    }
    setFocusHighlight(true);
    const frame = window.requestAnimationFrame(() => {
      const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      rowRef.current?.scrollIntoView({ block: 'center', behavior: reducedMotion ? 'auto' : 'smooth' });
    });
    const timer = window.setTimeout(() => setFocusHighlight(false), 2400);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [focused]);

  const pinned = c.pinOrder != null;
  const isCompacting = compacting || c.activity === 'compacting';
  const selected = c.id === selectedId;
  const showUnread = !archivedView && c.unread && !selected;
  // Older chats step back a little so today's work reads at a glance. Unread,
  // open, and archiving rows keep their own emphasis.
  const faded = !showUnread && !selected && !pendingArchive && !isToday(c.lastActiveAt);
  // Colour logo whenever the chat wants attention: unread, or the agent is busy / waiting on you.
  const iconActive = showUnread || isCompacting || c.status === 'working' || c.status === 'needs_you';
  return (
    <li
      ref={rowRef}
      data-conversation-id={c.id}
      data-focus-target={focused ? 'true' : undefined}
      className={cn(
        'group flex items-center gap-0.5 rounded-xl transition-[background-color,box-shadow] duration-500',
        pendingArchive && 'opacity-50',
        focusHighlight && 'bg-brand/10 ring-2 ring-brand/40',
      )}
    >
      <button
        onPointerUp={() => onOpen(c.id)}
        aria-current={c.id === selectedId ? 'true' : undefined}
        className={cn(
          'flex min-w-0 flex-1 items-center gap-2 rounded-xl px-2.5 py-2 text-left active:bg-accent',
          c.id === selectedId && 'bg-accent',
        )}
      >
        {/* The status dot occupies the existing left padding, so the chat icon
            and title never shift when a chat starts or stops working. */}
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="-ml-2.5 flex shrink-0 items-center">
            <span className="flex size-2.5 -translate-x-2 shrink-0 items-center justify-center">
              <StatusDot
                status={c.status}
                activity={isCompacting ? 'compacting' : null}
                unread={showUnread}
              />
            </span>
            <span className={cn('flex shrink-0 items-center', faded && 'opacity-75')}>
              <ConversationIcon conversation={c} mode={iconMode} active={iconActive} />
            </span>
          </span>
          <span className="flex min-w-0 flex-1 items-baseline gap-2">
            <span
              className={cn(
                'flex min-w-0 items-center text-[13px] font-normal',
                // Today's chats go a step past --foreground so they stand out from faded ones.
                faded ? 'opacity-75' : 'text-neutral-950 dark:text-white',
                pendingArchive && 'line-through',
              )}
            >
              <AgentWakeupClock active={c.hasPendingWakeup} />
              <span className="truncate">{c.title ?? 'New conversation'}</span>
            </span>
            {c.visibility === 'private' ? (
              <span
                className="inline-flex shrink-0 items-center text-muted-foreground"
                title="Private — only you can see this chat"
                aria-label="Private chat"
              >
                <HatGlasses className="size-3.5" aria-hidden="true" />
              </span>
            ) : null}
            <span className="flex shrink-0 items-baseline gap-1 text-xs text-muted-foreground">
              <span>
                {pendingArchive ? (
                  <span className="italic">Archiving…</span>
                ) : isCompacting ? (
                  'Compacting…'
                ) : c.status === 'needs_you' ? (
                  <span className="font-medium text-amber-600 dark:text-amber-500">Needs your input</span>
                ) : c.status === 'working' ? (
                  'Working…'
                ) : (
                  timeAgo(c.lastActiveAt)
                )}
              </span>
            </span>
          </span>
        </div>
      </button>
      {pendingArchive && c.canManage ? (
        <Button
          variant="ghost"
          size="sm"
          className="mr-1 h-9 shrink-0 gap-1.5 rounded-full px-2.5 font-medium text-brand"
          onPointerUp={() => onUndoArchive?.(c)}
          aria-label="Undo archive"
        >
          <Undo2 className="size-4" />
          Undo
        </Button>
      ) : c.canManage ? (
        archivedView ? (
          <Button
            variant="ghost"
            size="icon-lg"
            className="hidden h-9 w-8 shrink-0 rounded-full text-muted-foreground transition-opacity md:inline-flex md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100"
            onPointerUp={() => onArchiveAction(c)}
            aria-label="Move conversation to Chats"
          >
            <ArchiveRestore className="size-3.5" />
          </Button>
        ) : (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-lg"
                className="relative h-9 w-8 shrink-0 rounded-full text-muted-foreground opacity-100 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100"
                aria-label={`More actions for ${c.title ?? 'New conversation'}`}
              >
                <Ellipsis className="size-4" />
                <span
                  className="pointer-fine:hidden absolute top-1/2 left-1/2 size-[max(100%,3rem)] -translate-1/2"
                  aria-hidden="true"
                />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <ConversationRowMenuItems
                conversation={c}
                compacting={isCompacting}
                onTogglePin={() => onTogglePin(c)}
                onMarkUnread={() => onMarkUnreadAction(c)}
                onCompact={() => onCompactAction(c)}
                onArchive={() => onArchiveAction(c)}
                onDelete={() => onDeleteAction(c)}
              />
            </DropdownMenuContent>
          </DropdownMenu>
        )
      ) : pinned ? (
        <span
          className="inline-flex size-8 shrink-0 items-center justify-center text-brand"
          title="Pinned"
          aria-label="Pinned chat"
        >
          <Pin className="size-3.5 shrink-0 fill-current" aria-hidden="true" />
        </span>
      ) : null}
      {!pendingArchive && !archivedView && pinned && c.canManage ? (
        <Button
          variant="ghost"
          size="icon-lg"
          className="relative h-9 w-8 shrink-0 rounded-full text-brand"
          onClick={(event) => {
            event.stopPropagation();
            onTogglePin(c);
          }}
          aria-label={`Unpin ${c.title ?? 'New conversation'}`}
          title="Unpin chat"
        >
          <Pin className="size-3.5 shrink-0 fill-current" aria-hidden="true" />
          <span
            className="pointer-fine:hidden absolute top-1/2 left-1/2 size-[max(100%,3rem)] -translate-1/2"
            aria-hidden="true"
          />
        </Button>
      ) : null}
    </li>
  );
}

/**
 * The chat list — pinned rows above recency groups — shared by the Chats page
 * and a project's page. Active rows keep pin, context compaction, archive, and delete inside one
 * overflow menu, while manageable pinned rows keep a direct right-edge Unpin
 * button. View-only pinned rows retain a passive marker. The archived view
 * keeps its restore/delete dialog per row. The parent owns the
 * array; this calls `onRemoved(id)` after archive/unarchive/delete (all three
 * drop the row from the current list) and `onChanged(next)` with a re-sorted
 * replacement array after pin/unpin, so the UI updates ahead of the
 * next poll.
 */
export function ConversationList({
  conversations,
  onOpen,
  archivedView = false,
  selectedId = null,
  focusedId = null,
  onRemoved,
  onUnarchived,
  onChanged,
  emptyState,
  flat = false,
  orderBy = 'activity',
  insetRows = false,
  maxTopLevel,
  iconMode: iconModeOverride,
  onToast,
}: {
  conversations: Conversation[];
  onOpen: (id: string) => void;
  archivedView?: boolean;
  /** Highlights the open chat's row (desktop split view, where the list stays visible). */
  selectedId?: string | null;
  /** Scrolls to and briefly highlights a chat returning from its unread action. */
  focusedId?: string | null;
  onRemoved: (id: string) => void;
  /** Opens a restored chat after it leaves the archived list. */
  onUnarchived?: (conversation: Conversation) => void;
  onChanged?: (next: Conversation[]) => void;
  emptyState?: ReactNode;
  /** Drop the Today/Yesterday recency headers and show one flat list — used
      inside a project, where the per-row age already conveys recency. */
  flat?: boolean;
  /** Project lists stay in creation order; loose chats follow recent activity. */
  orderBy?: 'activity' | 'created';
  /** Indent rows to align with chats nested beneath project headings. */
  insetRows?: boolean;
  /** Keep all pins visible, then cap the remaining top-level rows. */
  maxTopLevel?: number;
  /** Test/embedded override. Normal chat lists use the signed-in user's preference. */
  iconMode?: ChatListIconMode;
  onToast?: (message: string) => void;
}) {
  const chatAppearance = useChatAppearance();
  const iconMode = iconModeOverride ?? chatAppearance.listIcon;
  // Restore/delete dialog — archived view only.
  const [actionFor, setActionFor] = useState<Conversation | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [compactingIds, setCompactingIds] = useState<Set<string>>(new Set());
  const compactingRef = useRef<Set<string>>(new Set());

  // Archive grace period: tapping archive doesn't write immediately. The row
  // stays visible but greyed ("Archiving…") for a few seconds with an Undo
  // affordance; only when the timer fires do we PATCH and drop the row. The
  // timers live in the shared pendingArchive module (module scope, so they
  // survive this list unmounting and a page refresh); subscribing here just
  // re-renders the greyed rows as pending state changes.
  useSyncExternalStore(subscribePendingArchive, pendingArchiveVersion, pendingArchiveVersion);

  // Drop rows whose archive has just committed: a list poll in flight when the
  // write landed can re-surface them for a few seconds, so the shared module
  // holds them briefly (see isArchiveCommitted) and we filter them here.
  // Agent-spawned chats (handoff tool) nest under the chat that spawned them,
  // collapsed to a count row by default — but only when that origin chat is in
  // this same list. Orphans (origin archived, deleted, or filed in another
  // project) and pinned children render as normal top-level rows. The archived
  // view stays a flat everything-list.
  const { visible, childrenOf, topLevel } = conversationHierarchy(conversations, orderBy, archivedView);

  // Which parents' handoff groups are expanded (session-local, collapsed by default).
  const [openHandoffs, setOpenHandoffs] = useState<Set<string>>(new Set());
  const parentOf = new Map<string, string>();
  for (const [pid, kids] of childrenOf) for (const k of kids) parentOf.set(k.id, pid);
  // If the open chat is hidden inside a collapsed group, expand its ancestors.
  // No dep array: parentOf is rebuilt per render; the setState bails out unchanged.
  useEffect(() => {
    const revealId = selectedId ?? focusedId;
    if (!revealId || !parentOf.has(revealId)) return;
    setOpenHandoffs((prev) => {
      const next = new Set(prev);
      let changed = false;
      for (let p = parentOf.get(revealId); p !== undefined && !next.has(p); p = parentOf.get(p)) {
        next.add(p);
        changed = true;
      }
      return changed ? next : prev;
    });
  });

  // Server order is pinned-first, so these filters preserve display order. The
  // archived view has no pins (archiving unpins server-side); the fallback
  // keeps any stale pinned row visible there rather than hiding it.
  const pinned = archivedView ? [] : topLevel.filter((c) => c.pinOrder != null);
  const unpinnedAll = archivedView ? topLevel : topLevel.filter((c) => c.pinOrder == null);
  const unpinned =
    maxTopLevel === undefined
      ? unpinnedAll
      : unpinnedAll.slice(0, Math.max(0, maxTopLevel - pinned.length));

  const closeDialog = () => {
    setActionFor(null);
    setConfirmDelete(false);
  };

  // Grace period before an archive actually writes. ~5s felt right against the
  // existing 5s list poll — long enough to catch an accidental tap, short
  // enough not to feel stuck.
  const ARCHIVE_GRACE_MS = 5_000;

  // One tap on Archive chat — starts the grace period, no dialog. The
  // shared module owns the timer (so it survives unmount/refresh); onRemoved
  // drops the row once the write lands, ahead of the next poll.
  const startArchive = (c: Conversation) => scheduleArchive(c.id, ARCHIVE_GRACE_MS, () => onRemoved(c.id));

  // Tap Undo before the timer fires — cancel the write entirely.
  const undoArchive = (c: Conversation) => cancelArchive(c.id);

  const confirmDeleteFor = (c: Conversation) => {
    setActionFor(c);
    setConfirmDelete(true);
  };

  // One tap on the menu's pin action.
  const togglePin = async (c: Conversation) => {
    try {
      onChanged?.(await updateConversationPin(conversations, c, orderBy));
    } catch {
      /* list resyncs on next poll */
    }
  };

  const markUnread = async (c: Conversation) => {
    try {
      const { conversation } = await api.markConversationUnread(c.id);
      onChanged?.(conversations.map((item) => (item.id === conversation.id ? conversation : item)));
    } catch {
      /* list resyncs on next poll */
    }
  };

  const compactContext = async (c: Conversation) => {
    if (compactingRef.current.has(c.id)) return;
    compactingRef.current.add(c.id);
    setCompactingIds(new Set(compactingRef.current));
    onToast?.(`Compacting context for “${c.title?.trim() || 'Untitled chat'}”…`);
    try {
      await api.compactConversation(c.id);
      onToast?.(`Context compacted for “${c.title?.trim() || 'Untitled chat'}”`);
    } catch (err) {
      onToast?.(err instanceof Error ? err.message : 'Could not compact context');
    } finally {
      compactingRef.current.delete(c.id);
      setCompactingIds(new Set(compactingRef.current));
    }
  };

  const unarchive = async () => {
    if (!actionFor) return;
    setBusy(true);
    try {
      const { conversation } = await api.updateConversation(actionFor.id, { archived: false });
      onRemoved(conversation.id);
      onUnarchived?.(conversation);
    } catch {
      /* list resyncs on next poll */
    } finally {
      setBusy(false);
      closeDialog();
    }
  };

  const doDelete = async () => {
    if (!actionFor) return;
    setBusy(true);
    try {
      await api.deleteConversation(actionFor.id);
      onRemoved(actionFor.id);
    } catch {
      /* list resyncs on next poll */
    } finally {
      setBusy(false);
      closeDialog();
    }
  };

  const deleteConfirmation = actionFor ? chatDeleteConfirmation(actionFor) : null;

  const toggleHandoffs = (id: string) =>
    setOpenHandoffs((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // A parent row's spawned-agents disclosure: a collapsed count row (with an
  // aggregate status dot so a stuck child can't hide), expanding to the nested
  // chats — which may carry their own groups (handoff chains). The depth cap is
  // a defensive bound only; origin links can't cycle (fixed at creation).
  const renderHandoffs = (parent: Conversation, depth = 0): ReactNode => {
    const kids = childrenOf.get(parent.id);
    if (!kids || kids.length === 0 || depth > 4) return null;
    const open = openHandoffs.has(parent.id);
    const agg: Conversation['status'] = kids.some((k) => k.status === 'needs_you')
      ? 'needs_you'
      : kids.some((k) => k.status === 'failed')
        ? 'failed'
        : kids.some((k) => k.status === 'working')
          ? 'working'
          : 'idle';
    const aggActivity: Conversation['activity'] = kids.some((k) => k.activity === 'compacting')
      ? 'compacting'
      : null;
    return (
      <li className="ml-[1.4rem] pl-1.5">
        <button
          onPointerUp={() => toggleHandoffs(parent.id)}
          aria-expanded={open}
          className="flex w-full items-center gap-1.5 rounded-xl px-2.5 py-1.5 text-left text-xs font-medium text-muted-foreground active:bg-accent"
        >
          <ChevronRight className={cn('size-3.5 shrink-0 transition-transform', open && 'rotate-90')} />
          <span>
            {kids.length} handoff agent{kids.length === 1 ? '' : 's'}
          </span>
          {!open ? (
            <StatusDot
              status={agg}
              activity={aggActivity}
              unread={hasUnreadDescendant(parent.id, childrenOf)}
            />
          ) : null}
        </button>
        {open ? (
          <ul className="flex flex-col gap-0.5">
            {kids.map((k) => (
              <Fragment key={k.id}>
                <Row
                  c={k}
                  iconMode={iconMode}
                  onOpen={onOpen}
                  archivedView={false}
                  selectedId={selectedId}
                  focusedId={focusedId}
                  onTogglePin={(x) => void togglePin(x)}
                  onMarkUnreadAction={(x) => void markUnread(x)}
                  onCompactAction={(x) => void compactContext(x)}
                  onArchiveAction={(x) => startArchive(x)}
                  onDeleteAction={confirmDeleteFor}
                  onUndoArchive={(x) => undoArchive(x)}
                  pendingArchive={isArchivePending(k.id)}
                  compacting={compactingIds.has(k.id)}
                />
                {renderHandoffs(k, depth + 1)}
              </Fragment>
            ))}
          </ul>
        ) : null}
      </li>
    );
  };

  if (visible.length === 0) return <>{emptyState ?? null}</>;

  return (
    <>
      {pinned.length > 0 ? (
        <section>
          <ul className={cn('flex flex-col gap-0.5', insetRows && 'ml-[1.4rem] pl-1.5')}>
            {pinned.map((c) => (
              <Fragment key={c.id}>
                <Row
                  c={c}
                  iconMode={iconMode}
                  onOpen={onOpen}
                  archivedView={false}
                  selectedId={selectedId}
                  focusedId={focusedId}
                  onTogglePin={(x) => void togglePin(x)}
                  onMarkUnreadAction={(x) => void markUnread(x)}
                  onCompactAction={(x) => void compactContext(x)}
                  onArchiveAction={(x) => startArchive(x)}
                  onDeleteAction={confirmDeleteFor}
                  onUndoArchive={(x) => undoArchive(x)}
                  pendingArchive={isArchivePending(c.id)}
                  compacting={compactingIds.has(c.id)}
                />
                {renderHandoffs(c)}
              </Fragment>
            ))}
          </ul>
        </section>
      ) : null}

      {(flat ? [{ label: '', items: unpinned }] : groupByRecency(unpinned)).map((group, gi) => (
        <section key={group.label}>
          {group.label ? (
            <h2
              className={cn(
                'px-3 pb-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase',
                gi === 0 && pinned.length === 0 ? 'pt-1' : 'pt-5',
              )}
            >
              {group.label}
            </h2>
          ) : null}
          <ul className={cn('flex flex-col gap-0.5', insetRows && 'ml-[1.4rem] pl-1.5')}>
            {group.items.map((c) => (
              <Fragment key={c.id}>
                <Row
                  c={c}
                  iconMode={iconMode}
                  onOpen={onOpen}
                  archivedView={archivedView}
                  selectedId={selectedId}
                  focusedId={focusedId}
                  onTogglePin={(x) => void togglePin(x)}
                  onMarkUnreadAction={(x) => void markUnread(x)}
                  onCompactAction={(x) => void compactContext(x)}
                  onArchiveAction={archivedView ? setActionFor : (x) => startArchive(x)}
                  onDeleteAction={confirmDeleteFor}
                  onUndoArchive={(x) => undoArchive(x)}
                  pendingArchive={isArchivePending(c.id)}
                  compacting={compactingIds.has(c.id)}
                />
                {renderHandoffs(c)}
              </Fragment>
            ))}
          </ul>
        </section>
      ))}

      <Dialog open={actionFor !== null} onOpenChange={(open) => !open && closeDialog()}>
        <DialogContent showCloseButton={!confirmDelete}>
          {confirmDelete && deleteConfirmation ? (
            <>
              <DialogHeader>
                <DialogTitle>{deleteConfirmation.title}</DialogTitle>
                <DialogDescription>{deleteConfirmation.description}</DialogDescription>
              </DialogHeader>
              <DialogFooter className="gap-2">
                <Button
                  variant="outline"
                  className="h-11 flex-1 rounded-xl"
                  onPointerUp={() => (actionFor?.archived ? setConfirmDelete(false) : closeDialog())}
                  disabled={busy}
                >
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  className="h-11 flex-1 rounded-xl"
                  onPointerUp={() => void doDelete()}
                  disabled={busy}
                >
                  {deleteConfirmation.actionLabel}
                </Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>Move this conversation to Chats?</DialogTitle>
                <DialogDescription className="truncate">
                  {actionFor?.title ?? 'New conversation'}
                </DialogDescription>
              </DialogHeader>
              <div className="flex flex-col items-center gap-2">
                <Button
                  className="h-12 w-full gap-2 rounded-xl text-base"
                  onPointerUp={() => void unarchive()}
                  disabled={busy}
                >
                  <ArchiveRestore className="size-4" />
                  Move to Chats
                </Button>
                <Button
                  variant="link"
                  className="h-auto px-2 py-1 text-sm text-destructive"
                  onPointerUp={() => setConfirmDelete(true)}
                  disabled={busy}
                >
                  Delete conversation
                </Button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
