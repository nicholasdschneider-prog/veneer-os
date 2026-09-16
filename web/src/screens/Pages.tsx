import { useEffect, useMemo, useState } from 'react';
import {
  Check,
  ChevronLeft,
  Clock3,
  Copy,
  ExternalLink,
  Folder,
  FolderOpen,
  LayoutTemplate,
  Pin,
  Trash2,
} from 'lucide-react';
import { api } from '../lib/api';
import type { Page } from '../lib/types';
import { formatBytes } from '../lib/format';
import { pageExpiresSoon, pageExpiryDate, pageExpiryLabel, parsePageDate } from '../lib/pageExpiry';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { EmbeddedPreviewFrame } from '@/components/ui/embedded-preview-frame';
import { SplitView, SplitPlaceholder } from '../components/layout/SplitView';
import { DESKTOP_QUERY, useMediaQuery } from '../hooks/useMediaQuery';
import { groupPages, recentCreatedPages, visibleGroupPages } from './pageGroups';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

// Compact relative time, matching ConversationList's timeAgo.
function timeAgo(iso: string): string {
  const mins = Math.max(0, Math.round((Date.now() - parsePageDate(iso).getTime()) / 60_000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

const EXPANDED_GROUPS_KEY = 'pages.expandedGroups.v1';

function loadExpandedGroups(): Set<string> {
  try {
    const stored = localStorage.getItem(EXPANDED_GROUPS_KEY);
    if (!stored) return new Set();
    const ids: unknown = JSON.parse(stored);
    return Array.isArray(ids) ? new Set(ids.filter((id): id is string => typeof id === 'string')) : new Set();
  } catch {
    return new Set();
  }
}

function saveExpandedGroups(groups: Set<string>): void {
  try {
    localStorage.setItem(EXPANDED_GROUPS_KEY, JSON.stringify([...groups]));
  } catch {
    // Storage can be unavailable in private browsing.
  }
}

/**
 * The Pages screen (#/pages): standalone public HTML pages agents publish to
 * the configured pages host. Chats-style two-pane layout — a list on the left, a live
 * preview of the selected page on the right. Creation happens via the agent's
 * publish_page tool, not here; this UI browses, opens, copies and deletes.
 */
export function Pages({ onToast }: { onToast: (m: string) => void }) {
  const isDesktop = useMediaQuery(DESKTOP_QUERY);
  const [pages, setPages] = useState<Page[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmPage, setConfirmPage] = useState<Page | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(loadExpandedGroups);
  const [showAllGroups, setShowAllGroups] = useState<Set<string>>(new Set());

  // Load on mount and poll for freshness (agents publish out-of-band).
  useEffect(() => {
    let stop = false;
    const load = () => {
      void api
        .pages()
        .then((r) => {
          if (!stop) setPages(r.pages);
        })
        .catch(() => {
          if (!stop) setPages((prev) => prev ?? []);
        });
    };
    load();
    const timer = setInterval(load, 10_000);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, []);

  useEffect(() => saveExpandedGroups(expandedGroups), [expandedGroups]);

  // Resolve the selection against the live list; drop it if the page is gone.
  const selected = useMemo(
    () => (selectedId ? (pages ?? []).find((p) => p.id === selectedId) ?? null : null),
    [pages, selectedId],
  );
  useEffect(() => {
    if (selectedId && pages && !pages.some((p) => p.id === selectedId)) setSelectedId(null);
  }, [pages, selectedId]);

  // Reset the "Copied" affordance whenever the shown page changes.
  useEffect(() => setCopied(false), [selectedId]);

  const pageGroups = useMemo(() => groupPages(pages ?? []), [pages]);
  const recentPages = useMemo(() => recentCreatedPages(pages ?? []), [pages]);

  const copyLink = (url: string) => {
    void navigator.clipboard
      .writeText(url)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => onToast('Could not copy link'));
  };

  const toggleGroup = (id: string) => {
    setExpandedGroups((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const togglePagePin = async (page: Page) => {
    try {
      const result = await api.updatePage(page.id, { pinned: page.pinOrder === null });
      setPages((current) =>
        current?.map((item) => (item.id === result.page.id ? result.page : item)) ?? current,
      );
    } catch (error) {
      onToast(error instanceof Error ? error.message : 'Could not update pin');
    }
  };

  const doDelete = async (p: Page) => {
    setDeleting(true);
    try {
      await api.deletePage(p.id);
      setPages((prev) => prev?.filter((x) => x.id !== p.id) ?? prev);
      if (selectedId === p.id) setSelectedId(null);
      onToast(`Deleted "${p.title}"`);
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Delete failed');
    } finally {
      setDeleting(false);
      setConfirmPage(null);
    }
  };

  const pageRow = (page: Page) => {
    const active = page.id === selectedId;
    const pinned = page.pinOrder !== null;
    const expiresSoon = pageExpiresSoon(page.expiresAt);
    return (
      <li key={page.id} className="group/page flex items-center gap-0.5">
        <button
          type="button"
          onPointerUp={() => setSelectedId(page.id)}
          aria-current={active ? 'true' : undefined}
          className={cn(
            'flex min-w-0 flex-1 items-center gap-2 rounded-xl px-2.5 py-2 text-left active:bg-accent',
            active && 'bg-accent',
          )}
        >
          <LayoutTemplate className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-medium">{page.title || page.slug}</span>
            <span
              className={cn('mt-0.5 block truncate text-xs', expiresSoon ? 'text-amber-600' : 'text-muted-foreground')}
            >
              {page.creator.displayName} · {pageExpiryLabel(page.expiresAt)}
            </span>
          </span>
        </button>
        <Button
          variant="ghost"
          size="icon-lg"
          className={cn(
            'h-9 w-8 shrink-0 rounded-full transition-opacity md:opacity-0 md:group-hover/page:opacity-100 md:group-focus-within/page:opacity-100',
            pinned ? 'text-brand' : 'text-muted-foreground',
          )}
          onPointerUp={() => void togglePagePin(page)}
          aria-label={pinned ? `Unpin ${page.title}` : `Pin ${page.title}`}
        >
          <Pin className={cn('size-3.5', pinned && 'fill-current')} />
        </Button>
      </li>
    );
  };

  const sidebar = (
    <div className="mx-auto flex h-full max-w-2xl flex-col pt-[env(safe-area-inset-top)]">
      <header className="px-5 pb-3 pt-6">
        <h1 className="text-2xl font-semibold">Pages</h1>
        <p className="mt-1 text-sm text-muted-foreground">Pages expire seven days after their latest content publish.</p>
      </header>
      <div className="flex-1 overflow-y-auto px-3 pb-[calc(env(safe-area-inset-bottom)+1rem)]">
        {pages === null ? (
          <p className="px-2 py-8 text-center text-muted-foreground">Loading…</p>
        ) : pages.length === 0 ? (
          <div className="px-2 py-16 text-center">
            <LayoutTemplate className="mx-auto size-10 text-muted-foreground" />
            <p className="mt-3 text-lg font-medium">No pages yet</p>
            <p className="mt-1 text-muted-foreground">
              When a chat publishes a page for you with the <span className="font-medium">publish_page</span> tool, it
              shows up here for seven days.
            </p>
          </div>
        ) : (
          <ul className="flex flex-col gap-0.5">
            <li>
              <div className="flex min-w-0 w-full items-center gap-2.5 rounded-xl px-3 py-3">
                <Clock3 className="size-5 shrink-0 text-muted-foreground" />
                <span className="truncate font-medium">Recent</span>
              </div>
              <div className="mb-1 ml-[1.4rem] pl-1.5">
                <ul className="flex flex-col gap-0.5">{recentPages.map(pageRow)}</ul>
              </div>
            </li>
            {pageGroups.map((group) => {
              const isOpen = expandedGroups.has(group.id);
              const showAll = showAllGroups.has(group.id);
              const compactPages = visibleGroupPages(group, false, null);
              const visiblePages = visibleGroupPages(group, showAll, selectedId);
              const selectionExpanded = !showAll && visiblePages.length > compactPages.length;
              return (
                <li key={group.id}>
                  <button
                    type="button"
                    onPointerUp={() => toggleGroup(group.id)}
                    aria-expanded={isOpen}
                    className="flex min-w-0 w-full items-center gap-2.5 rounded-xl px-3 py-3 text-left active:bg-accent"
                  >
                    {isOpen ? (
                      <FolderOpen className="size-5 shrink-0 text-muted-foreground" />
                    ) : (
                      <Folder className="size-5 shrink-0 text-muted-foreground" />
                    )}
                    <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
                      <span className="truncate font-medium">{group.name}</span>
                      {!isOpen ? (
                        <span className="shrink-0 text-sm tabular-nums text-muted-foreground">
                          {group.pages.length}
                        </span>
                      ) : null}
                    </span>
                  </button>
                  {isOpen ? (
                    <div className="mb-1 ml-[1.4rem] pl-1.5">
                      <ul className="flex flex-col gap-0.5">{visiblePages.map(pageRow)}</ul>
                      {compactPages.length < group.pages.length && !selectionExpanded ? (
                        <div className="flex justify-center py-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="rounded-full px-4 text-brand"
                            onPointerUp={() =>
                              setShowAllGroups((current) => {
                                const next = new Set(current);
                                if (next.has(group.id)) next.delete(group.id);
                                else next.add(group.id);
                                return next;
                              })
                            }
                          >
                            {showAll ? 'Show recent 10' : 'Show more'}
                          </Button>
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );

  const detail = selected ? (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-1 border-b border-border px-2 py-2 pt-[calc(env(safe-area-inset-top)+0.5rem)] md:pt-2">
        {!isDesktop ? (
          <Button
            variant="ghost"
            size="icon-lg"
            className="h-11 w-11 shrink-0 rounded-full"
            onPointerUp={() => setSelectedId(null)}
            aria-label="Back"
          >
            <ChevronLeft className="size-5" />
          </Button>
        ) : null}
        <div className="min-w-0 flex-1 px-2">
          <p className="truncate font-medium">{selected.title || selected.slug}</p>
          <p className="truncate text-xs text-muted-foreground">
            {formatBytes(selected.sizeBytes)} · updated {timeAgo(selected.updatedAt)}
          </p>
          <p
            className={cn(
              'truncate text-xs',
              pageExpiresSoon(selected.expiresAt) ? 'text-amber-600' : 'text-muted-foreground',
            )}
            title={`Expires ${pageExpiryDate(selected.expiresAt)}`}
          >
            {pageExpiryLabel(selected.expiresAt)} · {pageExpiryDate(selected.expiresAt)}
          </p>
        </div>
        <Button
          asChild
          variant="ghost"
          size="icon-lg"
          className="h-11 w-11 shrink-0 rounded-full text-muted-foreground"
        >
          <a href={selected.url} target="_blank" rel="noopener" aria-label="Open in new tab">
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
        <Button
          variant="ghost"
          size="icon-lg"
          className={cn(
            'h-11 w-11 shrink-0 rounded-full',
            selected.pinOrder !== null ? 'text-brand' : 'text-muted-foreground',
          )}
          onPointerUp={() => void togglePagePin(selected)}
          aria-label={selected.pinOrder !== null ? 'Unpin page' : 'Pin page'}
        >
          <Pin className={cn('size-5', selected.pinOrder !== null && 'fill-current')} />
        </Button>
        <Button
          variant="ghost"
          size="icon-lg"
          className="h-11 w-11 shrink-0 rounded-full text-muted-foreground"
          onPointerUp={() => setConfirmPage(selected)}
          aria-label="Delete page"
        >
          <Trash2 className="size-5" />
        </Button>
      </header>
      {/* Untrusted user HTML on a separate origin — deliberately NO
          allow-same-origin, so the page can't reach this app's origin. */}
      <EmbeddedPreviewFrame
        key={selected.id}
        src={selected.url}
        title={selected.title || selected.slug}
        className="min-h-0 flex-1 border-0 bg-white"
      />
    </div>
  ) : (
    <SplitPlaceholder title="Select a page" hint="Agents publish pages with the publish_page tool." />
  );

  return (
    <>
      <SplitView storageKey="split:pages" mobileShows={selected ? 'detail' : 'sidebar'} sidebar={sidebar}>
        {detail}
      </SplitView>

      <Dialog open={confirmPage !== null} onOpenChange={(o) => !o && !deleting && setConfirmPage(null)}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle className="truncate pr-6">Delete {confirmPage?.title || confirmPage?.slug}?</DialogTitle>
            <DialogDescription>
              This permanently removes the published page, including its public address. Anyone with the link will get a
              404.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              className="h-11 flex-1 rounded-xl"
              onPointerUp={() => setConfirmPage(null)}
              disabled={deleting}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              className="h-11 flex-1 rounded-xl"
              onPointerUp={() => confirmPage && void doDelete(confirmPage)}
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
