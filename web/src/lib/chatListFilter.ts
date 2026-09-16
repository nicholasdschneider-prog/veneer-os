/**
 * Pure helpers behind the Chats header's All / Unread segmented control.
 *
 * Kept out of the screen component so the filtering, counting, storage and
 * keyboard-shortcut rules can be unit-tested without a DOM.
 */

export type ChatListFilter = 'all' | 'unread';

export const CHAT_LIST_FILTER_KEY = 'veneer.chatListFilter';

/** Minimum shape the filter/count helpers need from a conversation. */
type UnreadRow = { id: string; unread?: boolean };

/** Best-effort read — private mode / disabled storage just means "All". */
export function loadChatListFilter(): ChatListFilter {
  try {
    return localStorage.getItem(CHAT_LIST_FILTER_KEY) === 'unread' ? 'unread' : 'all';
  } catch {
    return 'all';
  }
}

export function saveChatListFilter(filter: ChatListFilter): void {
  try {
    localStorage.setItem(CHAT_LIST_FILTER_KEY, filter);
  } catch {
    // ignore storage failures
  }
}

/**
 * A row belongs in the Unread view when it is genuinely unread, or when it is
 * "sticky": opened from this view, so it stays put instead of vanishing under
 * the pointer the moment opening marks it read.
 */
export function isUnreadRow(conversation: UnreadRow, sticky: ReadonlySet<string>): boolean {
  return conversation.unread === true || sticky.has(conversation.id);
}

export function filterUnread<T extends UnreadRow>(
  conversations: readonly T[],
  sticky: ReadonlySet<string>,
): T[] {
  return conversations.filter((conversation) => isUnreadRow(conversation, sticky));
}

/**
 * Unread chats across every list the screen already holds (top level plus each
 * loaded project). Ids are de-duplicated so a chat appearing in two lists is
 * counted once; projects whose chats have never loaded simply don't contribute.
 */
export function countUnreadChats(
  lists: readonly (readonly UnreadRow[] | null | undefined)[],
): number {
  const seen = new Set<string>();
  for (const list of lists) {
    if (!list) continue;
    for (const conversation of list) {
      if (conversation.unread === true) seen.add(conversation.id);
    }
  }
  return seen.size;
}

/**
 * What a project should list under the current filter. In the Unread view a
 * project with nothing unread — or whose chats have never loaded — drops out
 * of the list entirely rather than showing an empty folder.
 */
export function projectSectionForFilter<T extends UnreadRow>(
  listed: T[] | null,
  filter: ChatListFilter,
  sticky: ReadonlySet<string>,
): { hidden: boolean; chats: T[] | null } {
  if (filter === 'all') return { hidden: false, chats: listed };
  if (listed === null) return { hidden: true, chats: null };
  const chats = filterUnread(listed, sticky);
  return { hidden: chats.length === 0, chats };
}

/**
 * Startup only: a remembered "unread" choice falls back to All when there is
 * nothing unread, so the app never opens on a blank list. Later zero counts are
 * left alone — sticky rows keep the view meaningful as you read through it.
 */
export function resolveInitialFilter(stored: ChatListFilter, unreadCount: number): ChatListFilter {
  return stored === 'unread' && unreadCount === 0 ? 'all' : stored;
}

type ShortcutEvent = {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  target?: unknown;
};

function isEditableTarget(target: unknown): boolean {
  if (!target || typeof target !== 'object') return false;
  const element = target as { tagName?: unknown; isContentEditable?: unknown };
  const tag = typeof element.tagName === 'string' ? element.tagName.toLowerCase() : '';
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
  return element.isContentEditable === true;
}

/**
 * Cmd/Ctrl+N starts a new chat. Shift is excluded (Cmd+Shift+N is the browser's
 * own new-window shortcut) and typing in a field always wins.
 */
export function isNewChatShortcut(event: ShortcutEvent): boolean {
  if (event.key.toLowerCase() !== 'n') return false;
  if (!(event.metaKey || event.ctrlKey)) return false;
  if (event.altKey || event.shiftKey) return false;
  return !isEditableTarget(event.target);
}

/** Runs the New chat shortcut, swallowing the browser default. Returns whether it fired. */
export function handleNewChatShortcut(
  event: ShortcutEvent & { preventDefault: () => void },
  onNewChat: () => void,
): boolean {
  if (!isNewChatShortcut(event)) return false;
  event.preventDefault();
  onNewChat();
  return true;
}
