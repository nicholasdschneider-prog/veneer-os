import { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, Folder, Inbox, Search, X } from 'lucide-react';
import { api } from '../lib/api';
import type { ArchivedConversationGroup, Conversation } from '../lib/types';
import { ConversationList } from './ConversationList';
import { Button } from '@/components/ui/button';

const SEARCH_DELAY_MS = 250;
const REFRESH_INTERVAL_MS = 5_000;

export function archiveGroupKey(projectId: string | null): string {
  return projectId ?? '__unfiled__';
}

export function archiveGroupLabel(group: Pick<ArchivedConversationGroup, 'projectId' | 'projectName'>): string {
  return group.projectId === null ? 'No project' : group.projectName;
}

function ArchivedProjectGroup({
  group,
  expanded,
  expandedGroup,
  expandedLoading,
  expandedError,
  searching,
  selectedId,
  onOpen,
  onExpand,
  onCollapse,
  onPage,
  onRetry,
  onRemoved,
  onUnarchived,
  onChanged,
}: {
  group: ArchivedConversationGroup;
  expanded: boolean;
  expandedGroup: ArchivedConversationGroup | null;
  expandedLoading: boolean;
  expandedError: boolean;
  searching: boolean;
  selectedId: string | null;
  onOpen: (id: string, projectId?: string) => void;
  onExpand: () => void;
  onCollapse: () => void;
  onPage: (page: number) => void;
  onRetry: () => void;
  onRemoved: (id: string) => void;
  onUnarchived: (conversation: Conversation) => void;
  onChanged: (conversations: Conversation[]) => void;
}) {
  const displayedGroup = expanded && expandedGroup ? expandedGroup : group;
  const noun = searching ? (group.totalCount === 1 ? 'match' : 'matches') : group.totalCount === 1 ? 'chat' : 'chats';

  return (
    <section className="border-t border-border first:border-t-0">
      <div className="flex min-w-0 items-center gap-2 px-3 py-3">
        {group.projectId === null ? (
          <Inbox className="size-4 shrink-0 stroke-muted-foreground" aria-hidden="true" />
        ) : (
          <Folder className="size-4 shrink-0 stroke-muted-foreground" aria-hidden="true" />
        )}
        <h2 className="min-w-0 flex-1 truncate text-base font-medium sm:text-sm">
          {archiveGroupLabel(group)}
        </h2>
        <span className="shrink-0 text-base tabular-nums text-muted-foreground sm:text-sm">
          {group.totalCount} {noun}
        </span>
      </div>

      {expanded && expandedLoading ? (
        <p className="px-3 py-8 text-center text-base text-muted-foreground sm:text-sm">Loading chats…</p>
      ) : expanded && expandedError ? (
        <div className="flex flex-col items-center gap-2 px-3 py-8 text-center">
          <p className="text-base text-muted-foreground sm:text-sm">This project’s archive could not be loaded.</p>
          <Button type="button" variant="outline" size="sm" onClick={onRetry}>
            Try again
          </Button>
        </div>
      ) : (
        <ConversationList
          conversations={displayedGroup.conversations}
          flat
          orderBy="activity"
          archivedView
          selectedId={selectedId}
          onOpen={(id) => onOpen(id, group.projectId ?? undefined)}
          onRemoved={onRemoved}
          onUnarchived={onUnarchived}
          onChanged={onChanged}
        />
      )}

      {!expanded && group.totalCount > 10 ? (
        <div className="flex justify-center px-3 py-2">
          <Button type="button" variant="ghost" size="sm" className="rounded-full px-3 text-brand" onClick={onExpand}>
            View all {group.totalCount} {noun}
          </Button>
        </div>
      ) : null}

      {expanded && expandedGroup && !expandedLoading && !expandedError ? (
        <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
          <Button type="button" variant="ghost" size="sm" className="rounded-full px-3 text-brand" onClick={onCollapse}>
            Show recent 10
          </Button>
          {expandedGroup.totalPages > 1 ? (
            <nav aria-label={`Pagination for ${archiveGroupLabel(group)}`} className="flex items-center gap-1">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="relative rounded-full"
                disabled={expandedGroup.page <= 1}
                onClick={() => onPage(expandedGroup.page - 1)}
                aria-label="Previous page"
              >
                <ChevronLeft className="size-4 shrink-0" />
                <span className="pointer-fine:hidden absolute top-1/2 left-1/2 size-[max(100%,3rem)] -translate-1/2" aria-hidden="true" />
              </Button>
              <span className="px-1 text-base tabular-nums text-muted-foreground sm:text-sm">
                Page {expandedGroup.page} of {expandedGroup.totalPages}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="relative rounded-full"
                disabled={expandedGroup.page >= expandedGroup.totalPages}
                onClick={() => onPage(expandedGroup.page + 1)}
                aria-label="Next page"
              >
                <ChevronRight className="size-4 shrink-0" />
                <span className="pointer-fine:hidden absolute top-1/2 left-1/2 size-[max(100%,3rem)] -translate-1/2" aria-hidden="true" />
              </Button>
            </nav>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

export function ArchivedConversationGroups({
  selectedId,
  onOpen,
  onUnarchived,
}: {
  selectedId: string | null;
  onOpen: (id: string, projectId?: string) => void;
  onUnarchived: (conversation: Conversation) => void;
}) {
  const [inputQuery, setInputQuery] = useState('');
  const [query, setQuery] = useState('');
  const [groups, setGroups] = useState<ArchivedConversationGroup[] | null>(null);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [expandedPage, setExpandedPage] = useState(1);
  const [expandedGroup, setExpandedGroup] = useState<ArchivedConversationGroup | null>(null);
  const [expandedLoading, setExpandedLoading] = useState(false);
  const [expandedError, setExpandedError] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(inputQuery.trim()), SEARCH_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [inputQuery]);

  useEffect(() => {
    setExpandedKey(null);
    setExpandedPage(1);
    setExpandedGroup(null);
  }, [query]);

  useEffect(() => {
    let active = true;
    let loaded = false;
    setGroups(null);
    setError(false);
    const load = () => {
      void api.archivedConversations({ query }).then((result) => {
        if (!active || !('groups' in result)) return;
        loaded = true;
        setGroups(result.groups);
        setError(false);
      }).catch(() => {
        if (active && !loaded) setError(true);
      });
    };
    load();
    const timer = window.setInterval(load, REFRESH_INTERVAL_MS);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [query, retry]);

  useEffect(() => {
    if (!expandedKey) return;
    const projectId = expandedKey === archiveGroupKey(null) ? null : expandedKey;
    let active = true;
    let loaded = false;
    setExpandedGroup(null);
    setExpandedLoading(true);
    setExpandedError(false);
    const load = () => {
      void api.archivedConversations({
        query,
        projectId,
        page: expandedPage,
        pageSize: 20,
      }).then((result) => {
        if (!active || !('group' in result)) return;
        loaded = true;
        setExpandedGroup(result.group);
        setExpandedLoading(false);
        setExpandedError(false);
        if (result.group.page !== expandedPage) setExpandedPage(result.group.page);
      }).catch(() => {
        if (!active || loaded) return;
        setExpandedLoading(false);
        setExpandedError(true);
      });
    };
    load();
    const timer = window.setInterval(load, REFRESH_INTERVAL_MS);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [expandedKey, expandedPage, query, retry]);

  const removeConversation = (projectId: string | null, id: string) => {
    setGroups((current) => current
      ?.map((group) => group.projectId === projectId
        ? {
            ...group,
            totalCount: Math.max(0, group.totalCount - 1),
            conversations: group.conversations.filter((conversation) => conversation.id !== id),
          }
        : group)
      .filter((group) => group.totalCount > 0) ?? current);
    if (expandedGroup?.projectId === projectId) {
      const nextTotal = Math.max(0, expandedGroup.totalCount - 1);
      const nextTotalPages = Math.max(1, Math.ceil(nextTotal / expandedGroup.pageSize));
      if (expandedGroup.page > nextTotalPages) setExpandedPage(nextTotalPages);
    }
    setExpandedGroup((current) => {
      if (!current || current.projectId !== projectId) return current;
      const totalCount = Math.max(0, current.totalCount - 1);
      const totalPages = Math.max(1, Math.ceil(totalCount / current.pageSize));
      return {
        ...current,
        totalCount,
        totalPages,
        conversations: current.conversations.filter((conversation) => conversation.id !== id),
      };
    });
  };

  const changeConversations = (projectId: string | null, conversations: Conversation[]) => {
    const updatedById = new Map(conversations.map((conversation) => [conversation.id, conversation]));
    setGroups((current) => current?.map((group) =>
      group.projectId === projectId
        ? {
            ...group,
            conversations: group.conversations.map((conversation) =>
              updatedById.get(conversation.id) ?? conversation),
          }
        : group,
    ) ?? current);
    setExpandedGroup((current) => current?.projectId === projectId
      ? { ...current, conversations }
      : current);
  };

  const typing = inputQuery.trim() !== query;

  return (
    <div className="flex flex-col gap-2">
      <div className="px-3 pb-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 shrink-0 stroke-muted-foreground" aria-hidden="true" />
          <input
            type="search"
            name="archived-chat-search"
            value={inputQuery}
            onChange={(event) => setInputQuery(event.target.value)}
            placeholder="Search archived chat titles"
            aria-label="Search archived chat titles"
            className="w-full rounded-xl bg-muted/50 py-2.5 pl-10 pr-10 text-base outline-none ring-1 ring-border focus-visible:ring-2 focus-visible:ring-brand sm:py-2 sm:text-sm"
          />
          {inputQuery ? (
            <button
              type="button"
              onClick={() => setInputQuery('')}
              aria-label="Clear archived chat search"
              className="absolute right-1 top-1/2 flex size-9 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground active:bg-accent"
            >
              <X className="size-4 shrink-0" aria-hidden="true" />
              <span className="pointer-fine:hidden absolute top-1/2 left-1/2 size-[max(100%,3rem)] -translate-1/2" aria-hidden="true" />
            </button>
          ) : null}
        </div>
        <p className="sr-only" aria-live="polite">
          {typing ? 'Searching archived chats' : query && groups ? `${groups.length} project groups found` : ''}
        </p>
      </div>

      {groups === null && !error ? (
        <p className="px-3 py-12 text-center text-base text-muted-foreground sm:text-sm">
          {query ? 'Searching…' : 'Loading archived chats…'}
        </p>
      ) : error ? (
        <div className="flex flex-col items-center gap-3 px-3 py-12 text-center">
          <div className="flex flex-col gap-1">
            <p className="text-base font-medium sm:text-sm">Archived chats could not be loaded</p>
            <p className="text-base text-muted-foreground sm:text-sm">Check your connection and try again.</p>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={() => setRetry((value) => value + 1)}>
            Try again
          </Button>
        </div>
      ) : groups?.length === 0 ? (
        <div className="flex flex-col gap-1 px-3 py-16 text-center">
          <p className="text-lg font-medium">{query ? 'No matching archived chats' : 'No archived chats'}</p>
          <p className="text-base text-muted-foreground sm:text-sm">
            {query ? 'Try a different title.' : 'Chats you archive show up here.'}
          </p>
        </div>
      ) : (
        <div>
          {groups?.map((group) => {
            const key = archiveGroupKey(group.projectId);
            const expanded = expandedKey === key;
            return (
              <ArchivedProjectGroup
                key={key}
                group={group}
                expanded={expanded}
                expandedGroup={expanded ? expandedGroup : null}
                expandedLoading={expanded && expandedLoading}
                expandedError={expanded && expandedError}
                searching={Boolean(query)}
                selectedId={selectedId}
                onOpen={onOpen}
                onExpand={() => {
                  setExpandedKey(key);
                  setExpandedPage(1);
                }}
                onCollapse={() => {
                  setExpandedKey(null);
                  setExpandedGroup(null);
                }}
                onPage={setExpandedPage}
                onRetry={() => setRetry((value) => value + 1)}
                onRemoved={(id) => removeConversation(group.projectId, id)}
                onUnarchived={onUnarchived}
                onChanged={(conversations) => changeConversations(group.projectId, conversations)}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
