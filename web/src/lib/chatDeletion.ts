import type { Conversation } from './types';

type DeleteableChat = Pick<Conversation, 'status' | 'visibility'>;

export interface ChatDeleteConfirmation {
  title: string;
  description: string;
  actionLabel: string;
}

export interface ChatActionLabels {
  pin: string;
  archive: string;
  delete: string;
}

export interface ChatHeaderMenuLabels {
  info: string;
  copyLink: string;
  manage: Pick<ChatActionLabels, 'pin' | 'delete'> | null;
}

export function chatActionLabels(pinned: boolean, archived: boolean): ChatActionLabels {
  return {
    pin: pinned ? 'Unpin chat' : 'Pin chat',
    archive: archived ? 'Move to Chats' : 'Archive chat',
    delete: 'Delete chat…',
  };
}

export function chatHeaderMenuLabels(
  canManage: boolean,
  pinned: boolean,
): ChatHeaderMenuLabels {
  const actions = chatActionLabels(pinned, false);
  return {
    info: 'Chat info',
    copyLink: 'Copy link',
    manage: canManage ? { pin: actions.pin, delete: actions.delete } : null,
  };
}

/** Canonical URL for an existing chat. Omits transient hash params such as artifact. */
export function chatShareUrl(
  location: Pick<URL, 'origin' | 'pathname'>,
  conversationId: string,
  projectId?: string | null,
): string {
  const hash = projectId
    ? `#/chat/${conversationId}?project=${projectId}`
    : `#/chat/${conversationId}`;
  return `${location.origin}${location.pathname}${hash}`;
}

type ClipboardWriter = Pick<Clipboard, 'writeText'>;

export function copyChatShareUrl(
  clipboard: ClipboardWriter | undefined,
  location: Pick<URL, 'origin' | 'pathname'>,
  conversationId: string,
  projectId?: string | null,
): Promise<void> {
  if (!clipboard) return Promise.reject(new Error('Clipboard API unavailable'));
  return clipboard.writeText(chatShareUrl(location, conversationId, projectId));
}

export function chatDeleteConfirmation(chat: DeleteableChat): ChatDeleteConfirmation {
  const teamChat = chat.visibility === 'team';
  const workingWarning = chat.status === 'working' ? ' The agent is still working and will be stopped.' : '';

  return {
    title: teamChat ? 'Delete for everyone?' : 'Delete this chat?',
    description: teamChat
      ? `Everyone on your team will permanently lose access to this chat.${workingWarning} This can’t be undone.`
      : `This chat will be permanently deleted.${workingWarning} This can’t be undone.`,
    actionLabel: teamChat ? 'Delete for everyone' : 'Delete chat',
  };
}
