import { Fragment, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  Bot,
  CalendarClock,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Files,
  Folder,
  FolderOpen,
  Globe,
  GripVertical,
  Pencil,
  Pin,
  Plus,
} from 'lucide-react';
import { api } from '../lib/api';
import type { BuildQueueJob, Conversation, Project, ScheduledTask, ScheduledTaskRun } from '../lib/types';
import { Button } from '@/components/ui/button';
import { ConversationList, getConversationListPagination } from '../components/ConversationList';
import { EditProjectDialog } from '../components/EditProjectDialog';
import { NewProjectDialog } from '../components/NewProjectDialog';
import { BuildQueue } from '../components/BuildQueue';
import { NewChatPlaceholderRow } from '../components/NewChatPlaceholderRow';
import { ArchivedConversationGroups } from '../components/ArchivedConversationGroups';
import {
  listPendingNewChats,
  pendingNewChatsVersion,
  subscribePendingNewChats,
  type PendingNewChat,
} from '../lib/newChatDrafts';
import { DESKTOP_QUERY, useMediaQuery } from '../hooks/useMediaQuery';
import { useScrollMemory } from '../hooks/useScrollMemory';
import { ChatListFilterControl } from '../components/ChatListFilterControl';
import {
  countUnreadChats,
  filterUnread,
  handleNewChatShortcut,
  loadChatListFilter,
  projectSectionForFilter,
  resolveInitialFilter,
  saveChatListFilter,
  type ChatListFilter,
} from '../lib/chatListFilter';

const NO_PENDING_NEW_CHATS: readonly PendingNewChat[] = [];

// Persist which projects are expanded so the open/closed set survives leaving
// the Chats screen (e.g. to Settings) and reloads. Best-effort — storage errors
// (private mode, quota) just fall back to nothing expanded.
const EXPANDED_KEY = 'chatlist.expandedProjects';
const AUTOMATIONS_EXPANDED_KEY = 'chatlist.automationsExpanded';

function loadExpanded(): Set<string> {
  try {
    const raw = localStorage.getItem(EXPANDED_KEY);
    if (!raw) return new Set();
    const ids = JSON.parse(raw);
    return Array.isArray(ids) ? new Set(ids.filter((id) => typeof id === 'string')) : new Set();
  } catch {
    return new Set();
  }
}

function saveExpanded(expanded: Set<string>): void {
  try {
    localStorage.setItem(EXPANDED_KEY, JSON.stringify([...expanded]));
  } catch {
    // ignore storage failures
  }
}

function loadAutomationsExpanded(): boolean {
  try {
    return localStorage.getItem(AUTOMATIONS_EXPANDED_KEY) === 'true';
  } catch {
    return false;
  }
}

function saveAutomationsExpanded(expanded: boolean): void {
  try {
    localStorage.setItem(AUTOMATIONS_EXPANDED_KEY, String(expanded));
  } catch {
    // ignore storage failures
  }
}

function readyConversations(pending: readonly PendingNewChat[], projectId: string | null): Conversation[] {
  return pending.flatMap((item) =>
    item.status === 'ready' && item.projectId === projectId && item.conversation
      ? [item.conversation]
      : [],
  );
}

function mergeReadyConversations(current: Conversation[], ready: Conversation[]): Conversation[] {
  const currentIds = new Set(current.map((conversation) => conversation.id));
  return [...ready.filter((conversation) => !currentIds.has(conversation.id)), ...current];
}

function isNewChatPlaceholder(
  item: PendingNewChat,
): item is PendingNewChat & { status: 'starting' | 'failed' } {
  return item.status !== 'ready';
}

/**
 * Project header actions show only for the active project (expanded, or
 * holding the selected chat). Inactive rows hide them on mobile and reveal
 * them on desktop hover/focus, so a long project list is not a wall of icons.
 * `display` is the desktop display class for the element (buttons are flex).
 */
export function projectActionVisibilityClasses(isActive: boolean, display = 'inline-flex'): string {
  return isActive
    ? 'opacity-100'
    : `hidden md:${display} md:opacity-0 md:group-hover/project:opacity-100 md:group-focus-within/project:opacity-100`;
}

/** Secondary (manage) actions sit dimmed on desktop until the row is hovered. */
export function projectSecondaryActionClasses(isActive: boolean): string {
  return isActive
    ? 'md:opacity-45 md:group-hover/project:opacity-100 md:group-focus-within/project:opacity-100'
    : projectActionVisibilityClasses(false);
}

/**
 * Unread view renders matching projects open so their chats are visible, but
 * only for this render — the persisted expanded set is never written to.
 */
export function projectRowExpanded(
  filter: ChatListFilter,
  expanded: ReadonlySet<string>,
  projectId: string,
): boolean {
  return filter === 'unread' || expanded.has(projectId);
}

export function openRestoredConversation(
  conversation: Pick<Conversation, 'id' | 'projectId'>,
  showActiveChats: () => void,
  onOpen: (id: string, projectId?: string) => void,
): void {
  showActiveChats();
  onOpen(conversation.id, conversation.projectId ?? undefined);
}

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

function automationStatus(task: ScheduledTask, run?: ScheduledTaskRun): { label: string; tone: string } {
  if (run?.status === 'queued' || run?.status === 'running') return { label: 'Working…', tone: 'text-foreground' };
  if (run?.status === 'needs_you') return { label: 'Needs you', tone: 'text-amber-600 dark:text-amber-500' };
  if (run?.status === 'failed') return { label: 'Failed', tone: 'text-destructive' };
  if (!task.enabled) return { label: 'Paused', tone: 'text-muted-foreground' };
  if (run?.status === 'completed') return { label: timeAgo(run.finishedAt ?? run.startedAt), tone: 'text-muted-foreground' };
  if (run?.status === 'skipped') return { label: `Skipped ${timeAgo(run.finishedAt ?? run.startedAt)}`, tone: 'text-muted-foreground' };
  return { label: 'Not run yet', tone: 'text-muted-foreground' };
}

function AutomationStatusDot({ run }: { run?: ScheduledTaskRun }) {
  if (run?.status === 'queued' || run?.status === 'running') {
    return (
      <span className="vp-working-grid inline-grid size-1.5 grid-cols-2 grid-rows-2 gap-px" aria-hidden="true">
        <span />
        <span />
        <span />
        <span />
      </span>
    );
  }
  if (run?.status === 'needs_you') return <span className="inline-block size-1.5 rounded-full bg-amber-500" />;
  if (run?.status === 'failed') {
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
  return null;
}

function AutomationsList({
  tasks,
  selectedId,
  onOpen,
  onOpenAutomations,
}: {
  tasks: ScheduledTask[];
  selectedId: string | null;
  onOpen: (id: string) => void;
  onOpenAutomations: () => void;
}) {
  const [expanded, setExpanded] = useState(loadAutomationsExpanded);

  useEffect(() => {
    saveAutomationsExpanded(expanded);
  }, [expanded]);

  if (tasks.length === 0) return null;
  return (
    <section className="mt-2 border-t border-border pt-2">
      <div className="flex items-center gap-1 px-3 py-2">
        <button
          type="button"
          onClick={() => setExpanded((open) => !open)}
          aria-expanded={expanded}
          aria-label={`${expanded ? 'Collapse' : 'Expand'} automations`}
          className="-my-2 flex min-w-0 flex-1 items-center gap-2 rounded-lg py-2 text-left active:bg-accent"
        >
          <CalendarClock className="size-4 shrink-0 text-muted-foreground" />
          <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Automations</span>
          <ChevronDown
            className={`size-3.5 shrink-0 text-muted-foreground transition-transform ${expanded ? 'rotate-180' : ''}`}
            aria-hidden="true"
          />
        </button>
        <button
          type="button"
          onPointerUp={onOpenAutomations}
          className="rounded-full px-2 py-1 text-xs font-medium text-muted-foreground active:bg-accent"
        >
          View all
        </button>
      </div>
      {expanded ? (
        <ul className="ml-[1.4rem] flex flex-col gap-0.5 pl-1.5">
          {tasks.map((task) => {
            const latestRun = task.recentRuns[0];
            const latestChat = task.recentRuns.find((run) => run.conversationId)?.conversationId ?? null;
            const isSelected = task.recentRuns.some((run) => run.conversationId === selectedId);
            const status = automationStatus(task, latestRun);
            return (
              <li key={task.id}>
                <button
                  type="button"
                  onPointerUp={() => (latestChat ? onOpen(latestChat) : onOpenAutomations())}
                  aria-current={isSelected ? 'true' : undefined}
                  className={`flex w-full min-w-0 items-center gap-2 rounded-xl px-2.5 py-2 text-left active:bg-accent ${
                    isSelected ? 'bg-accent' : ''
                  }`}
                >
                  <span className="-ml-2.5 flex shrink-0 items-center">
                    <span className="flex size-2.5 -translate-x-2 shrink-0 items-center justify-center">
                      <AutomationStatusDot run={latestRun} />
                    </span>
                    <CalendarClock className="size-3.5 shrink-0 text-muted-foreground" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex min-w-0 items-baseline gap-2">
                      <span className="truncate text-[13px] font-medium">{task.name}</span>
                      <span className={`ml-auto shrink-0 text-xs ${status.tone}`}>{status.label}</span>
                    </span>
                    <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                      <span className="truncate">{task.scheduleText}</span>
                      {task.projectName ? <span className="shrink-0">· {task.projectName}</span> : null}
                    </span>
                  </span>
                  {task.pinned ? (
                    <span className="shrink-0 text-brand" title="Pinned">
                      <Pin className="size-3.5 fill-current" aria-hidden="true" />
                      <span className="sr-only">Pinned</span>
                    </span>
                  ) : null}
                  <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/60" aria-hidden="true" />
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}

export function ChatList({
  displayName,
  role,
  selectedId = null,
  focusedId = null,
  openProjectId = null,
  onOpen,
  onOpenProject,
  onOpenProjectFiles,
  onOpenProjectBrowser,
  onOpenAutomations,
  onNewChat,
  onToast,
}: {
  displayName: string;
  role: string;
  selectedId?: string | null;
  /** Chat to reveal after Mark as unread returns from the detail view. */
  focusedId?: string | null;
  /** Project of the currently-open chat, if any — auto-expanded and highlighted. */
  openProjectId?: string | null;
  onOpen: (id: string, projectId?: string) => void;
  onOpenProject: (id: string) => void;
  onOpenProjectFiles: (id: string) => void;
  onOpenProjectBrowser: (id: string) => void;
  onOpenAutomations: () => void;
  onNewChat: (projectId?: string, todoId?: string | null) => void;
  onToast?: (message: string) => void;
}) {
  const isDesktop = useMediaQuery(DESKTOP_QUERY);
  const [view, setView] = useState<'active' | 'archived'>('active');
  // Mobile swaps the whole list out while a chat is open; coming back lands
  // where the user was instead of at the top of a long project list.
  const listScrollRef = useScrollMemory<HTMLDivElement>(`chat-list:${view}`);
  // All / Unread segmented control. Persisted so the choice survives reloads.
  const [filter, setFilter] = useState<ChatListFilter>(loadChatListFilter);
  // Chats opened from the Unread view stay listed even once opening marks them
  // read, so rows don't vanish under the pointer. Cleared on every filter change.
  const [stickyUnreadIds, setStickyUnreadIds] = useState<Set<string>>(new Set());
  const [conversations, setConversations] = useState<Conversation[] | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [automations, setAutomations] = useState<ScheduledTask[] | null>(null);
  const [buildJobs, setBuildJobs] = useState<BuildQueueJob[]>([]);
  const [newProject, setNewProject] = useState(false);
  const [editProject, setEditProject] = useState<Project | null>(null);
  const [reorderingProjects, setReorderingProjects] = useState(false);
  const [dragProjectId, setDragProjectId] = useState<string | null>(null);
  const [projectDropIndex, setProjectDropIndex] = useState<number | null>(null);
  useSyncExternalStore(subscribePendingNewChats, pendingNewChatsVersion, pendingNewChatsVersion);
  const pendingNewChats = listPendingNewChats();
  const activePendingNewChats = view === 'active' ? pendingNewChats : NO_PENDING_NEW_CHATS;
  const hiddenPendingIds = new Set(
    activePendingNewChats.filter((item) => item.status !== 'ready').map((item) => item.id),
  );
  const unfiledPlaceholders = activePendingNewChats
    .filter(isNewChatPlaceholder)
    .filter((item) => item.projectId === null);
  const dragProjectIdRef = useRef<string | null>(null);
  const projectDropIndexRef = useRef<number | null>(null);
  const projectListRef = useRef<HTMLUListElement>(null);
  // Which projects are expanded to show their chats inline, and those chats
  // (undefined = never opened, null = loading, array = loaded). Kept per project
  // so collapsing/re-expanding is instant and only the open ones poll.
  // Seeded from localStorage so the open/closed set survives navigating away
  // (e.g. to Settings) and back, and across reloads.
  const [expanded, setExpanded] = useState<Set<string>>(loadExpanded);
  const [projectChats, setProjectChats] = useState<Record<string, Conversation[] | null>>({});
  const projectChatsRef = useRef(projectChats);
  projectChatsRef.current = projectChats;
  const [showAllProjectChats, setShowAllProjectChats] = useState<Set<string>>(new Set());
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const projectsRef = useRef(projects);
  projectsRef.current = projects;
  const unreadViewRef = useRef(false);
  // Persist the expanded set whenever it changes.
  useEffect(() => {
    saveExpanded(expanded);
  }, [expanded]);

  // A project can change inside the new-chat form without changing the URL.
  // Expand the destination when creation begins so the pending row is visible.
  useEffect(() => {
    const pendingProjectIds = activePendingNewChats.flatMap((item) => item.projectId ? [item.projectId] : []);
    if (pendingProjectIds.length === 0) return;
    setExpanded((current) => {
      const next = new Set(current);
      let changed = false;
      for (const id of pendingProjectIds) {
        if (next.has(id)) continue;
        next.add(id);
        changed = true;
      }
      return changed ? next : current;
    });
  }, [activePendingNewChats]);
  const canManage = role === 'owner' || role === 'consultant';
  const queuedConversationIds = new Set(buildJobs.map((job) => job.conversationId));
  const sourceJobs = buildJobs.filter((job) => job.scopeKey === 'source');
  // The archived view has no filter, so it always lists everything.
  const listFilter: ChatListFilter = view === 'active' ? filter : 'all';
  const unreadView = listFilter === 'unread';
  unreadViewRef.current = unreadView;

  // Project chats are otherwise lazy-loaded on expand, which would leave unread
  // chats inside collapsed projects uncounted and missing from the Unread
  // view. Load each project's list once; the refresh loop keeps it fresh.
  useEffect(() => {
    if (view !== 'active') return;
    const missing = projects
      .map((project) => project.id)
      .filter((id) => projectChatsRef.current[id] === undefined);
    if (missing.length === 0) return;
    setProjectChats((prev) => {
      const next = { ...prev };
      for (const id of missing) if (next[id] === undefined) next[id] = null;
      return next;
    });
    // No cancel guard: the 5s project refresh re-runs this effect, and a
    // cancelled first load would strand the project at "loading".
    for (const id of missing) {
      void api.conversations(false, id).then((r) => {
        setProjectChats((prev) => ({ ...prev, [id]: r.conversations }));
      }).catch(() => undefined);
    }
  }, [projects, view]);

  useEffect(() => {
    saveChatListFilter(filter);
    setStickyUnreadIds(new Set());
  }, [filter]);

  // The desktop list stays mounted while a chat is open, so its cached row
  // still says "read" when the detail action returns. Refresh just that list
  // immediately instead of waiting for the normal five-second poll.
  useEffect(() => {
    if (!focusedId || view !== 'active') return;
    let stop = false;
    const targetProject = openProjectId ?? 'none';
    void api.conversations(false, targetProject).then((result) => {
      if (stop) return;
      if (openProjectId) {
        setProjectChats((current) => ({ ...current, [openProjectId]: result.conversations }));
      } else {
        setConversations(result.conversations);
      }
    }).catch(() => undefined);
    return () => {
      stop = true;
    };
  }, [focusedId, openProjectId, view]);

  // Desktop keyboard shortcut for the action the left rail owns.
  useEffect(() => {
    if (!isDesktop) return;
    const onKeyDown = (event: KeyboardEvent) => {
      handleNewChatShortcut(event, () => onNewChat());
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isDesktop, onNewChat]);

  // Keeps a chat listed in the Unread view after opening marks it read.
  const openChat = (id: string, projectId?: string) => {
    if (unreadView) setStickyUnreadIds((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
    onOpen(id, projectId);
  };

  /** The rows a project would actually list (null while its chats are unknown). */
  const listedChatsForProject = (projectId: string): Conversation[] | null => {
    const chats = projectChats[projectId];
    const projectPending = activePendingNewChats.filter((item) => item.projectId === projectId);
    const optimisticChats = readyConversations(projectPending, projectId);
    return chats === undefined || chats === null
      ? optimisticChats.length
        ? optimisticChats
        : null
      : mergeReadyConversations(chats, optimisticChats).filter(
          (chat) => !queuedConversationIds.has(chat.id) && !hiddenPendingIds.has(chat.id),
        );
  };

  const listedTopLevel = mergeReadyConversations(
    conversations ?? [],
    readyConversations(activePendingNewChats, null),
  ).filter(
    (conversation) =>
      !queuedConversationIds.has(conversation.id) && !hiddenPendingIds.has(conversation.id),
  );

  // Counted from what the screen already holds: collapsed projects that have
  // never loaded their chats simply don't contribute.
  const unreadCount = countUnreadChats([
    listedTopLevel,
    ...projects.map((project) => listedChatsForProject(project.id)),
  ]);

  const unreadTopLevel = filterUnread(listedTopLevel, stickyUnreadIds);
  const unreadProjectMatches =
    unreadView &&
    projects.some(
      (project) =>
        !projectSectionForFilter(listedChatsForProject(project.id), 'unread', stickyUnreadIds).hidden,
    );
  const caughtUp = unreadView && !unreadProjectMatches && unreadTopLevel.length === 0;

  // A stored "unread" choice shouldn't strand you on an empty list at startup.
  // Once only — later zero counts are expected while sticky rows keep the view
  // meaningful as you read through it.
  const unreadFallbackDone = useRef(false);
  useEffect(() => {
    if (unreadFallbackDone.current || conversations === null) return;
    unreadFallbackDone.current = true;
    setFilter((current) => resolveInitialFilter(current, unreadCount));
  }, [conversations, unreadCount]);

  useEffect(() => {
    let stop = false;
    setConversations(null);
    const load = () => {
      if (view === 'active') {
        // Active view shows only UNFILED chats; project chats live under their
        // project. Archived chats use their bounded grouped endpoint below.
        void api.conversations(false, 'none').then((r) => {
          if (!stop) setConversations(r.conversations);
        }).catch(() => undefined);
        void api.buildQueue().then((r) => {
          if (!stop) setBuildJobs(r.jobs);
        }).catch(() => undefined);
        void api.scheduledTasks().then((r) => {
          if (!stop) setAutomations(r.scheduledTasks);
        }).catch(() => undefined);
        void api.projects().then((r) => {
          if (!stop) setProjects(r.projects);
        }).catch(() => undefined);
        // Keep the expanded projects' chat lists fresh on the same cadence.
        // The Unread view lists chats from every project, so refresh them all
        // there; the unread badge for collapsed projects comes from the
        // one-time load below and refreshes whenever a project is opened.
        const refreshIds = unreadViewRef.current
          ? projectsRef.current.map((project) => project.id)
          : [...expandedRef.current];
        for (const id of refreshIds) {
          void api.conversations(false, id).then((r) => {
            if (!stop) setProjectChats((prev) => ({ ...prev, [id]: r.conversations }));
          }).catch(() => undefined);
        }
      }
    };
    load();
    const timer = setInterval(load, 5_000); // list freshness; per-chat is WS-live
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, [view]);

  // Auto-expand the open chat's project and load its chats, so the row shows
  // nested with the active chat highlighted. Manual collapse still sticks — this
  // only re-runs when you move to a chat in a different project.
  useEffect(() => {
    if (!openProjectId) return;
    const pid = openProjectId;
    setExpanded((prev) => (prev.has(pid) ? prev : new Set(prev).add(pid)));
    setProjectChats((prev) => (prev[pid] === undefined ? { ...prev, [pid]: null } : prev));
    let stop = false;
    void api.conversations(false, pid).then((r) => {
      if (!stop) setProjectChats((prev) => ({ ...prev, [pid]: r.conversations }));
    }).catch(() => undefined);
    return () => {
      stop = true;
    };
  }, [openProjectId]);

  const toggleProject = (id: string) => {
    const expanding = !expanded.has(id);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    // Lazy-load the first time a project opens; later opens reuse cached chats.
    if (expanding && projectChats[id] === undefined) {
      setProjectChats((prev) => ({ ...prev, [id]: null }));
      void api.conversations(false, id).then((r) => {
        setProjectChats((prev) => ({ ...prev, [id]: r.conversations }));
      }).catch(() => undefined);
    }
  };

  const saveProjectOrder = (ids: string[]) => {
    const position = new Map(ids.map((id, index) => [id, index]));
    setProjects((prev) =>
      [...prev]
        .sort(
          (a, b) =>
            (position.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
            (position.get(b.id) ?? Number.MAX_SAFE_INTEGER),
        )
        .map((project, sortOrder) => ({ ...project, sortOrder })),
    );
    void api.reorderProjects(ids).catch(() => {
      onToast?.('Project order could not be saved');
      void api.projects().then((result) => setProjects(result.projects)).catch(() => undefined);
    });
  };

  const moveProject = (id: string, offset: number) => {
    const ids = projects.map((project) => project.id);
    const from = ids.indexOf(id);
    const to = Math.max(0, Math.min(ids.length - 1, from + offset));
    if (from < 0 || from === to) return;
    ids.splice(from, 1);
    ids.splice(to, 0, id);
    saveProjectOrder(ids);
  };

  const onProjectGripDown = (event: React.PointerEvent, id: string) => {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragProjectIdRef.current = id;
    setDragProjectId(id);
  };

  const onProjectGripMove = (event: React.PointerEvent) => {
    if (!dragProjectIdRef.current) return;
    const rows = Array.from(projectListRef.current?.querySelectorAll<HTMLElement>('[data-project-row]') ?? []);
    let index = rows.length;
    for (let i = 0; i < rows.length; i++) {
      const bounds = rows[i]!.getBoundingClientRect();
      if (event.clientY < bounds.top + bounds.height / 2) {
        index = i;
        break;
      }
    }
    projectDropIndexRef.current = index;
    setProjectDropIndex(index);
  };

  const endProjectDrag = (event: React.PointerEvent) => {
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    dragProjectIdRef.current = null;
    projectDropIndexRef.current = null;
    setDragProjectId(null);
    setProjectDropIndex(null);
  };

  const onProjectGripUp = (event: React.PointerEvent) => {
    const id = dragProjectIdRef.current;
    const over = projectDropIndexRef.current;
    endProjectDrag(event);
    if (!id || over === null) return;
    const ids = projects.map((project) => project.id);
    const from = ids.indexOf(id);
    if (from < 0) return;
    const to = Math.min(over > from ? over - 1 : over, ids.length - 1);
    if (to === from) return;
    ids.splice(from, 1);
    ids.splice(to, 0, id);
    saveProjectOrder(ids);
  };

  return (
    <div className="mx-auto flex h-full max-w-2xl flex-col pt-[env(safe-area-inset-top)]">
      <header className="flex items-center justify-between gap-2 px-5 pb-3 pt-6">
        {view === 'active' ? (
          <h1 className="min-w-0 truncate text-2xl font-semibold">Chats</h1>
        ) : (
          <div className="flex min-w-0 items-center gap-2">
            <Button
              variant="ghost"
              size="icon-lg"
              className="h-11 w-11 rounded-full"
              onPointerUp={() => setView('active')}
              aria-label="Back"
            >
              <ChevronLeft className="size-5" />
            </Button>
            <h1 className="min-w-0 truncate text-2xl font-semibold">Archived</h1>
          </div>
        )}
        {/* No global New chat here: chats start from a project (the per-project
            "+" below). The header space goes to the All / Unread filter
            (active view only — archived has no filter). */}
        {view === 'active' ? (
          <ChatListFilterControl filter={filter} unreadCount={unreadCount} onChange={setFilter} />
        ) : null}
      </header>

      <div ref={listScrollRef} className="flex-1 overflow-y-auto px-3 pb-[calc(env(safe-area-inset-bottom)+1rem)]">
        {/* Unread view drops the whole Projects section when no project has
            anything unread, rather than leaving a stray heading. */}
        {view === 'active' && (!unreadView || unreadProjectMatches) ? (
          <section className="mb-2">
            <div className="flex items-center justify-between px-3 pb-1.5 pt-1">
              <h2 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Projects</h2>
              {unreadView ? null : (
                <button
                  onPointerUp={() => setNewProject(true)}
                  className="flex items-center gap-1 rounded-full px-2 py-1 text-xs font-medium text-muted-foreground active:bg-accent"
                >
                  <Plus className="size-3.5" /> New project
                </button>
              )}
            </div>
            {projects.length === 0 ? null : (
              <ul ref={projectListRef} className="flex flex-col gap-0.5">
                {projects.map((p, index) => {
                  const projectPending = activePendingNewChats.filter((item) => item.projectId === p.id);
                  const projectPlaceholders = unreadView
                    ? []
                    : projectPending.filter(isNewChatPlaceholder);
                  // Unread view: a project with nothing unread (or nothing
                  // loaded) drops out entirely; the rest render expanded
                  // without touching the persisted expanded set.
                  const section = projectSectionForFilter(
                    listedChatsForProject(p.id),
                    listFilter,
                    stickyUnreadIds,
                  );
                  if (section.hidden) return null;
                  const listedChats = section.chats;
                  const isOpen = projectRowExpanded(listFilter, expanded, p.id);
                  const revealedId = selectedId ?? focusedId;
                  const holdsSelectedChat =
                    revealedId !== null &&
                    ((listedChats ?? []).some((c) => c.id === revealedId) ||
                      (selectedId === 'new' && projectPlaceholders.some((item) => item.status === 'starting')));
                  const isActive = isOpen || holdsSelectedChat;
                  const projectActionVisibility = projectActionVisibilityClasses(isActive);
                  const projectSecondaryVisibility = projectSecondaryActionClasses(isActive);
                  const projectDividerVisibility = projectActionVisibilityClasses(isActive, 'inline-block');
                  const pagination = listedChats === null
                    ? null
                    : getConversationListPagination(listedChats, revealedId, 'created');
                  const selectedChatIsOlder =
                    pagination !== null && pagination.selectedTopLevelIndex >= 10;
                  const showAllChats = showAllProjectChats.has(p.id) || selectedChatIsOlder;
                  const projectJobs = buildJobs.filter((job) => job.scopeKey === `project:${p.id}`);
                  return (
                    <Fragment key={p.id}>
                      {dragProjectId !== null && projectDropIndex === index ? (
                        <li aria-hidden className="mx-3 h-0.5 rounded bg-brand" />
                      ) : null}
                      <li className={dragProjectId === p.id ? 'group/project opacity-40' : 'group/project'}>
                        <div data-project-row className="flex items-center">
                        {reorderingProjects ? (
                          <button
                            type="button"
                            className="touch-none cursor-grab self-stretch py-3 pl-2 pr-1 text-muted-foreground/60"
                            onPointerDown={(event) => onProjectGripDown(event, p.id)}
                            onPointerMove={onProjectGripMove}
                            onPointerUp={onProjectGripUp}
                            onPointerCancel={endProjectDrag}
                            onKeyDown={(event) => {
                              if (event.key === 'ArrowUp') {
                                event.preventDefault();
                                moveProject(p.id, -1);
                              } else if (event.key === 'ArrowDown') {
                                event.preventDefault();
                                moveProject(p.id, 1);
                              }
                            }}
                            aria-label={`Reorder ${p.name}. Use arrow keys or drag.`}
                          >
                            <GripVertical className="size-4" />
                          </button>
                        ) : null}
                        {/* Tapping the row expands/collapses; the folder icon
                            opens to signal the project is open (no caret). */}
                        <button
                          onPointerUp={() => toggleProject(p.id)}
                          aria-expanded={isOpen}
                          className="flex min-w-0 flex-1 items-center gap-2.5 rounded-xl px-3 py-3 text-left active:bg-accent"
                        >
                          {isOpen ? (
                            <FolderOpen className="size-5 shrink-0 text-muted-foreground" />
                          ) : (
                            <Folder className="size-5 shrink-0 text-muted-foreground" />
                          )}
                          <span className="flex min-w-0 items-baseline gap-1.5">
                            <span className="truncate font-medium">{p.name}</span>
                            {!isOpen && p.chatCount > 0 ? (
                              <span className="shrink-0 text-sm tabular-nums text-muted-foreground">
                                {p.chatCount}
                              </span>
                            ) : null}
                          </span>
                        </button>
                        {canManage ? (
                          <Button
                            variant="ghost"
                            size="icon-lg"
                            className={`h-11 w-9 shrink-0 rounded-full text-muted-foreground transition-opacity ${projectSecondaryVisibility}`}
                            onPointerUp={() => onOpenProjectFiles(p.id)}
                            aria-label={`Browse files in ${p.name}`}
                          >
                            <Files className="size-4" />
                          </Button>
                        ) : null}
                        <Button
                          variant="ghost"
                          size="icon-lg"
                          className={`h-11 w-9 shrink-0 rounded-full text-muted-foreground transition-opacity ${projectSecondaryVisibility}`}
                          onPointerUp={() => onOpenProjectBrowser(p.id)}
                          aria-label={`Open browser for ${p.name}`}
                        >
                          <Globe className="size-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-lg"
                          className={`h-11 w-9 shrink-0 rounded-full text-muted-foreground transition-opacity ${projectSecondaryVisibility}`}
                          onPointerUp={() => setEditProject(p)}
                          aria-label={`Edit ${p.name}`}
                        >
                          <Pencil className="size-4" />
                        </Button>
                        {/* Hairline separates manage actions from the primary
                            "new agent" action; it follows the secondaries' visibility. */}
                        <span
                          aria-hidden="true"
                          className={`mx-1 h-5 w-px shrink-0 bg-border transition-opacity ${projectDividerVisibility}`}
                        />
                        <Button
                          variant="ghost"
                          size="icon-lg"
                          className={`h-11 w-9 shrink-0 rounded-full text-foreground transition-opacity ${projectActionVisibility}`}
                          onPointerUp={() => onNewChat(p.id)}
                          aria-label={`New chat in ${p.name}`}
                        >
                          <Bot className="size-[22px]" />
                        </Button>
                        </div>
                        {isOpen ? (
                          <div className="mb-1 ml-[1.4rem] pl-1.5">
                          {projectPlaceholders.length ? (
                            <ul className="flex flex-col gap-0.5">
                              {projectPlaceholders.map((item) => (
                                <NewChatPlaceholderRow
                                  key={item.id}
                                  status={item.status}
                                  selected={selectedId === 'new' && item.status === 'starting'}
                                  onOpen={() => onNewChat(item.projectId ?? undefined, item.todoId)}
                                />
                              ))}
                            </ul>
                          ) : null}
                          {listedChats === null ? (
                            <p className="px-3 py-3 text-sm text-muted-foreground">Loading…</p>
                          ) : (
                            <>
                              <ConversationList
                                conversations={listedChats ?? []}
                                flat
                                orderBy="created"
                                maxTopLevel={showAllChats ? undefined : 10}
                                onOpen={(cid) => openChat(cid, p.id)}
                                selectedId={selectedId}
                                focusedId={focusedId}
                                onToast={onToast}
                                onRemoved={(cid) =>
                                  setProjectChats((prev) => ({
                                    ...prev,
                                    [p.id]: (prev[p.id] ?? []).filter((c) => c.id !== cid),
                                  }))
                                }
                                onChanged={(next) => setProjectChats((prev) => ({ ...prev, [p.id]: next }))}
                                emptyState={projectJobs.length || projectPlaceholders.length ? null : (
                                  // Ghost row: shaped like the chat row that will replace it,
                                  // so nothing shifts when the first agent appears.
                                  <button
                                    onPointerUp={() => onNewChat(p.id)}
                                    className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-left text-muted-foreground hover:text-foreground active:bg-accent"
                                  >
                                    <span className="flex size-[22px] shrink-0 items-center justify-center rounded-full border border-dashed border-current opacity-70">
                                      <Plus className="size-3" />
                                    </span>
                                    <span>Start an agent</span>
                                  </button>
                                )}
                              />
                              {pagination && pagination.topLevelCount > 10 && !selectedChatIsOlder ? (
                                <div className="flex justify-center py-1">
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="rounded-full px-4 text-brand"
                                    onPointerUp={() =>
                                      setShowAllProjectChats((current) => {
                                        const next = new Set(current);
                                        if (next.has(p.id)) next.delete(p.id);
                                        else next.add(p.id);
                                        return next;
                                      })
                                    }
                                  >
                                    {showAllChats ? 'Show recent 10' : `View all ${pagination.topLevelCount} chats`}
                                  </Button>
                                </div>
                              ) : null}
                              <BuildQueue
                                jobs={projectJobs}
                                selectedId={selectedId}
                                onOpen={(conversationId, projectId) => onOpen(conversationId, projectId ?? undefined)}
                                onRemoved={(jobId) => setBuildJobs((jobs) => jobs.filter((job) => job.id !== jobId))}
                              />
                            </>
                          )}
                          </div>
                        ) : null}
                      </li>
                    </Fragment>
                  );
                })}
                {dragProjectId !== null && projectDropIndex === projects.length ? (
                  <li aria-hidden className="mx-3 h-0.5 rounded bg-brand" />
                ) : null}
              </ul>
            )}
          </section>
        ) : null}

        {unfiledPlaceholders.length && !unreadView ? (
          <ul className="ml-[1.4rem] flex flex-col gap-0.5 pl-1.5">
            {unfiledPlaceholders.map((item) => (
                <NewChatPlaceholderRow
                  key={item.id}
                  status={item.status}
                  selected={selectedId === 'new' && item.status === 'starting'}
                  onOpen={() => onNewChat(undefined, item.todoId)}
                />
            ))}
          </ul>
        ) : null}

        {view === 'archived' ? (
          <ArchivedConversationGroups
            selectedId={selectedId}
            onOpen={onOpen}
            onUnarchived={(conversation) =>
              openRestoredConversation(conversation, () => setView('active'), onOpen)
            }
          />
        ) : conversations === null && readyConversations(activePendingNewChats, null).length === 0 ? (
          <p className="px-2 py-8 text-center text-muted-foreground">Loading…</p>
        ) : (
          <ConversationList
            conversations={unreadView ? unreadTopLevel : listedTopLevel}
            onOpen={openChat}
            selectedId={selectedId}
            focusedId={focusedId}
            insetRows
            onToast={onToast}
            onRemoved={(id) => setConversations((prev) => prev?.filter((c) => c.id !== id) ?? prev)}
            onChanged={setConversations}
            emptyState={
              // Unread view speaks for itself: either the caught-up note (when
              // no project matched either) or nothing at all.
              unreadView ? (
                caughtUp ? (
                  <p className="px-2 py-16 text-center text-muted-foreground">
                    You&rsquo;re all caught up.
                  </p>
                ) : null
              ) : // When projects with chats exist above, an empty loose-chat list
              // isn't really "empty" — so only show the message when there are
              // no projects to point at either (archived view has no projects).
              projects.length === 0 && sourceJobs.length === 0 && activePendingNewChats.length === 0 ? (
                <div className="px-2 py-16 text-center">
                  <p className="text-lg font-medium">No chats here yet</p>
                  <p className="mt-1 text-muted-foreground">Open a project to start a chat.</p>
                </div>
              ) : null
            }
          />
        )}

        {view === 'active' ? (
          <BuildQueue
            jobs={sourceJobs}
            selectedId={selectedId}
            onOpen={(conversationId, projectId) => onOpen(conversationId, projectId ?? undefined)}
            onRemoved={(jobId) => setBuildJobs((jobs) => jobs.filter((job) => job.id !== jobId))}
          />
        ) : null}

        {view === 'active' && automations ? (
          <AutomationsList
            tasks={automations}
            selectedId={selectedId}
            onOpen={(id) => onOpen(id)}
            onOpenAutomations={onOpenAutomations}
          />
        ) : null}

        {view === 'active' ? (
          <nav
            aria-label="Chat list options"
            className="mx-auto mt-2 flex w-fit items-center gap-1 rounded-full border bg-background p-1"
          >
            <button
              type="button"
              onPointerUp={() => setView('archived')}
              className="rounded-full px-3 py-2 text-sm text-muted-foreground active:bg-accent"
            >
              Archived chats
            </button>
            <button
              type="button"
              onPointerUp={() => setReorderingProjects((active) => !active)}
              aria-pressed={reorderingProjects}
              className={`flex items-center gap-1.5 rounded-full px-3 py-2 text-sm ${
                reorderingProjects
                  ? 'bg-accent font-medium text-foreground'
                  : 'text-muted-foreground active:bg-accent'
              }`}
            >
              <GripVertical className="size-4" />
              Reorder
            </button>
          </nav>
        ) : null}
      </div>

      <NewProjectDialog
        open={newProject}
        onOpenChange={setNewProject}
        onCreated={(p) => {
          setNewProject(false);
          onOpenProject(p.id);
        }}
      />

      {editProject ? (
        <EditProjectDialog
          open={editProject !== null}
          project={editProject}
          canDelete={canManage}
          onOpenChange={(o) => {
            if (!o) setEditProject(null);
          }}
          onSaved={(updated) => {
            setProjects((prev) => prev.map((x) => (x.id === updated.id ? updated : x)));
            setEditProject(null);
          }}
          onDeleted={() => {
            const id = editProject.id;
            setProjects((prev) => prev.filter((x) => x.id !== id));
            setExpanded((prev) => {
              const next = new Set(prev);
              next.delete(id);
              return next;
            });
            setProjectChats((prev) => {
              const next = { ...prev };
              delete next[id];
              return next;
            });
            setShowAllProjectChats((prev) => {
              const next = new Set(prev);
              next.delete(id);
              return next;
            });
            onToast?.(`"${editProject.name}" deleted`);
            setEditProject(null);
          }}
          onToast={onToast}
        />
      ) : null}
    </div>
  );
}
