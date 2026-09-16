// Remembers, per chat, when the user last closed the Veneer Browser panel.
//
// The dismissal is a timestamp in localStorage rather than a flag in
// sessionStorage: the agent's browser runtime restarts between commands, so a
// poll can briefly read the session as inactive. A flag that cleared on
// "inactive" reopened the panel on the very next command, and sessionStorage
// vanished whenever a phone relaunched the app. Only a browser session that
// started after the close may reopen the panel.
const CONVERSATION_BROWSER_DISMISSED_KEY_PREFIX = 'veneer:chat-browser-dismissed-at:';

function storageKey(conversationId: string): string {
  return `${CONVERSATION_BROWSER_DISMISSED_KEY_PREFIX}${conversationId}`;
}

export function rememberedConversationBrowserDismissal(conversationId: string): number | null {
  try {
    const raw = window.localStorage.getItem(storageKey(conversationId));
    if (raw === null) return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

export function rememberConversationBrowserDismissal(conversationId: string, dismissedAt: number | null): void {
  try {
    if (dismissedAt === null) window.localStorage.removeItem(storageKey(conversationId));
    else window.localStorage.setItem(storageKey(conversationId), String(dismissedAt));
  } catch {
    // The in-memory dismissal still works when storage is unavailable.
  }
}

export interface ConversationBrowserPollSession {
  active: boolean;
  startedAt: string | null;
}

export function conversationBrowserPollState(
  session: ConversationBrowserPollSession,
  dismissedAt: number | null,
  alternativePanelSelected = false,
  now: number = Date.now(),
): {
  dismissedAt: number | null;
  shouldOpen: boolean;
} {
  if (!session.active) return { dismissedAt, shouldOpen: false };
  if (alternativePanelSelected) return { dismissedAt: dismissedAt ?? now, shouldOpen: false };
  if (dismissedAt === null) return { dismissedAt: null, shouldOpen: true };
  const startedAt = session.startedAt ? Date.parse(session.startedAt) : NaN;
  // A session that began after the close is new work; the old dismissal is spent.
  if (Number.isFinite(startedAt) && startedAt > dismissedAt) return { dismissedAt: null, shouldOpen: true };
  return { dismissedAt, shouldOpen: false };
}
