import type { Page } from '../lib/types';

export const UNFILED_PAGE_GROUP_ID = '__unfiled__';
export const PAGE_GROUP_LIMIT = 10;
export const RECENT_PAGE_LIMIT = 3;

export interface PageGroup {
  id: string;
  projectId: string | null;
  name: string;
  pages: Page[];
}

function pageTime(value: string): number {
  return new Date(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`).getTime();
}

export function recentCreatedPages(pages: readonly Page[]): Page[] {
  return [...pages]
    .sort((a, b) => pageTime(b.createdAt) - pageTime(a.createdAt) || a.id.localeCompare(b.id))
    .slice(0, RECENT_PAGE_LIMIT);
}

function comparePages(a: Page, b: Page): number {
  if (a.pinOrder !== null || b.pinOrder !== null) {
    if (a.pinOrder === null) return 1;
    if (b.pinOrder === null) return -1;
    if (a.pinOrder !== b.pinOrder) return a.pinOrder - b.pinOrder;
  }
  return pageTime(b.updatedAt) - pageTime(a.updatedAt) || a.id.localeCompare(b.id);
}

/**
 * Group pages in the project order supplied by the API. Each group sorts
 * pinned pages first, then the remaining pages by recent update.
 */
export function groupPages(pages: readonly Page[]): PageGroup[] {
  const groups = new Map<string, PageGroup>();
  for (const page of pages) {
    const id = page.projectId ?? UNFILED_PAGE_GROUP_ID;
    let group = groups.get(id);
    if (!group) {
      group = {
        id,
        projectId: page.projectId,
        name: page.projectName ?? 'Unfiled',
        pages: [],
      };
      groups.set(id, group);
    }
    group.pages.push(page);
  }
  for (const group of groups.values()) group.pages.sort(comparePages);
  return [...groups.values()];
}

/**
 * Keep all pins visible. Fill the rest of the compact list up to ten pages.
 * If the selected page would be hidden, show the full group until it closes.
 */
export function visibleGroupPages(
  group: PageGroup,
  showAll: boolean,
  selectedId: string | null,
): Page[] {
  if (showAll) return group.pages;
  let pinnedCount = 0;
  while (pinnedCount < group.pages.length && group.pages[pinnedCount]?.pinOrder !== null) pinnedCount += 1;
  const compactCount = Math.max(PAGE_GROUP_LIMIT, pinnedCount);
  const selectedIndex = selectedId ? group.pages.findIndex((page) => page.id === selectedId) : -1;
  return selectedIndex >= compactCount ? group.pages : group.pages.slice(0, compactCount);
}
