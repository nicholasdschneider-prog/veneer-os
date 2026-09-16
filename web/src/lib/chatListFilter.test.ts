import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CHAT_LIST_FILTER_KEY,
  countUnreadChats,
  filterUnread,
  handleNewChatShortcut,
  isNewChatShortcut,
  loadChatListFilter,
  projectSectionForFilter,
  resolveInitialFilter,
  saveChatListFilter,
} from './chatListFilter';

type Row = { id: string; unread?: boolean };

const rows: Row[] = [
  { id: 'a', unread: true },
  { id: 'b', unread: false },
  { id: 'c', unread: true },
];

function stubStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  });
  return store;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('unread filtering', () => {
  it('keeps only unread chats when the Unread segment is on', () => {
    expect(filterUnread(rows, new Set()).map((row) => row.id)).toEqual(['a', 'c']);
  });

  it('leaves the order alone so pinned-first sorting still applies', () => {
    const pinnedFirst: Row[] = [
      { id: 'pinned', unread: true },
      { id: 'recent', unread: true },
    ];

    expect(filterUnread(pinnedFirst, new Set()).map((row) => row.id)).toEqual(['pinned', 'recent']);
  });

  it('keeps a chat listed once opening it marks it read', () => {
    const afterOpening: Row[] = [{ id: 'a', unread: false }, { id: 'b', unread: false }];

    expect(filterUnread(afterOpening, new Set(['a'])).map((row) => row.id)).toEqual(['a']);
  });
});

describe('unread count', () => {
  it('counts top-level and project chats together, de-duplicating ids', () => {
    expect(countUnreadChats([rows, [{ id: 'a', unread: true }, { id: 'd', unread: true }]])).toBe(3);
  });

  it('ignores projects whose chats have not loaded', () => {
    expect(countUnreadChats([rows, null, undefined])).toBe(2);
  });

  it('does not count sticky rows that are already read', () => {
    expect(countUnreadChats([[{ id: 'a', unread: false }]])).toBe(0);
  });
});

describe('project sections', () => {
  it('hides a project with nothing unread', () => {
    expect(projectSectionForFilter([{ id: 'b', unread: false }], 'unread', new Set())).toEqual({
      hidden: true,
      chats: [],
    });
  });

  it('hides a project whose chats have never loaded', () => {
    expect(projectSectionForFilter(null, 'unread', new Set())).toEqual({ hidden: true, chats: null });
  });

  it('shows only the unread chats of a matching project', () => {
    const section = projectSectionForFilter(rows, 'unread', new Set());

    expect(section.hidden).toBe(false);
    expect(section.chats?.map((row) => row.id)).toEqual(['a', 'c']);
  });

  it('passes everything through — loading included — in the All view', () => {
    expect(projectSectionForFilter(rows, 'all', new Set())).toEqual({ hidden: false, chats: rows });
    expect(projectSectionForFilter(null, 'all', new Set())).toEqual({ hidden: false, chats: null });
  });
});

describe('filter persistence', () => {
  it('defaults to All and round-trips the stored choice', () => {
    const store = stubStorage();

    expect(loadChatListFilter()).toBe('all');
    saveChatListFilter('unread');
    expect(store.get(CHAT_LIST_FILTER_KEY)).toBe('unread');
    expect(loadChatListFilter()).toBe('unread');
  });

  it('falls back to All when storage is unavailable', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    });

    expect(loadChatListFilter()).toBe('all');
    expect(() => saveChatListFilter('unread')).not.toThrow();
  });

  it('drops a stored Unread choice when nothing is unread on load', () => {
    expect(resolveInitialFilter('unread', 0)).toBe('all');
  });

  it('keeps a stored Unread choice when something is unread', () => {
    expect(resolveInitialFilter('unread', 2)).toBe('unread');
    expect(resolveInitialFilter('all', 0)).toBe('all');
  });
});

describe('new chat shortcut', () => {
  it('fires on Cmd+N and Ctrl+N', () => {
    const onNewChat = vi.fn();
    const preventDefault = vi.fn();

    expect(handleNewChatShortcut({ key: 'n', metaKey: true, preventDefault }, onNewChat)).toBe(true);
    expect(handleNewChatShortcut({ key: 'N', ctrlKey: true, preventDefault }, onNewChat)).toBe(true);
    expect(onNewChat).toHaveBeenCalledTimes(2);
    expect(preventDefault).toHaveBeenCalledTimes(2);
  });

  it('ignores plain N, Cmd+Shift+N and Alt+N', () => {
    expect(isNewChatShortcut({ key: 'n' })).toBe(false);
    expect(isNewChatShortcut({ key: 'n', metaKey: true, shiftKey: true })).toBe(false);
    expect(isNewChatShortcut({ key: 'n', ctrlKey: true, altKey: true })).toBe(false);
    expect(isNewChatShortcut({ key: 'm', metaKey: true })).toBe(false);
  });

  it('stays out of the way while typing', () => {
    const onNewChat = vi.fn();
    const preventDefault = vi.fn();
    const typing = { key: 'n', metaKey: true, preventDefault };

    expect(handleNewChatShortcut({ ...typing, target: { tagName: 'INPUT' } }, onNewChat)).toBe(false);
    expect(handleNewChatShortcut({ ...typing, target: { tagName: 'TEXTAREA' } }, onNewChat)).toBe(false);
    expect(
      handleNewChatShortcut(
        { ...typing, target: { tagName: 'DIV', isContentEditable: true } },
        onNewChat,
      ),
    ).toBe(false);
    expect(onNewChat).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
  });
});
