import { describe, expect, it } from 'vitest';
import type { Page } from '../lib/types';
import {
  groupPages,
  PAGE_GROUP_LIMIT,
  recentCreatedPages,
  RECENT_PAGE_LIMIT,
  visibleGroupPages,
} from './pageGroups';

function page(
  id: string,
  projectId: string | null,
  projectName: string | null,
  updatedAt: string,
  pinOrder: number | null = null,
  createdAt: string = updatedAt,
): Page {
  return {
    id,
    slug: `${id}-slug`,
    title: id,
    url: `https://pages.example.com/p/${id}`,
    projectId,
    projectName,
    conversationId: null,
    creator: { id: 1, displayName: 'Owner' },
    pinOrder,
    sizeBytes: 10,
    createdAt,
    updatedAt,
    expiresAt: '2099-01-01T00:00:00.000Z',
  };
}

describe('page groups', () => {
  it('shows the three most recently created pages without changing the source order', () => {
    const pages = [
      page('updated-newer', 'alpha', 'Alpha', '2026-07-29 14:00:00', null, '2026-07-29 09:00:00'),
      page('created-third', 'alpha', 'Alpha', '2026-07-29 10:00:00', null, '2026-07-29 11:00:00'),
      page('created-first', 'beta', 'Beta', '2026-07-29 09:00:00', null, '2026-07-29 13:00:00'),
      page('created-second', null, null, '2026-07-29 08:00:00', null, '2026-07-29 12:00:00'),
    ];

    expect(recentCreatedPages(pages).map((item) => item.id)).toEqual([
      'created-first',
      'created-second',
      'created-third',
    ]);
    expect(recentCreatedPages(pages)).toHaveLength(RECENT_PAGE_LIMIT);
    expect(pages.map((item) => item.id)).toEqual([
      'updated-newer',
      'created-third',
      'created-first',
      'created-second',
    ]);
  });

  it('groups pages in API project order and puts unfiled pages in their own group', () => {
    const groups = groupPages([
      page('beta-new', 'beta', 'Beta', '2026-07-29 12:00:00'),
      page('alpha-page', 'alpha', 'Alpha', '2026-07-29 11:00:00'),
      page('beta-old', 'beta', 'Beta', '2026-07-29 10:00:00'),
      page('loose-page', null, null, '2026-07-29 09:00:00'),
    ]);

    expect(groups.map((group) => [group.name, group.pages.map((item) => item.id)])).toEqual([
      ['Beta', ['beta-new', 'beta-old']],
      ['Alpha', ['alpha-page']],
      ['Unfiled', ['loose-page']],
    ]);
  });

  it('sorts pins first and keeps their stored order', () => {
    const [group] = groupPages([
      page('recent', 'alpha', 'Alpha', '2026-07-29 12:00:00'),
      page('second-pin', 'alpha', 'Alpha', '2026-07-29 09:00:00', 4),
      page('first-pin', 'alpha', 'Alpha', '2026-07-29 08:00:00', -2),
    ]);

    expect(group?.pages.map((item) => item.id)).toEqual(['first-pin', 'second-pin', 'recent']);
  });

  it('shows ten pages, expands on request, and keeps an older selection visible', () => {
    const [group] = groupPages(
      Array.from({ length: 12 }, (_, index) =>
        page(
          `page-${index + 1}`,
          'alpha',
          'Alpha',
          `2026-07-${String(29 - index).padStart(2, '0')} 12:00:00`,
        ),
      ),
    );
    expect(group).toBeDefined();
    if (!group) return;

    expect(visibleGroupPages(group, false, null)).toHaveLength(PAGE_GROUP_LIMIT);
    expect(visibleGroupPages(group, true, null)).toHaveLength(12);
    expect(visibleGroupPages(group, false, 'page-12')).toHaveLength(12);
  });

  it('keeps all pinned pages visible above the ten-page limit', () => {
    const [group] = groupPages(
      Array.from({ length: 14 }, (_, index) =>
        page(
          `page-${index + 1}`,
          'alpha',
          'Alpha',
          '2026-07-29 12:00:00',
          index < 11 ? index : null,
        ),
      ),
    );
    expect(group).toBeDefined();
    if (!group) return;

    expect(visibleGroupPages(group, false, null)).toHaveLength(11);
    expect(visibleGroupPages(group, false, null).every((item) => item.pinOrder !== null)).toBe(true);
  });
});
