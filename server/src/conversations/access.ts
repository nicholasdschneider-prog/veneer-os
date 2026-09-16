import type { ConversationRow, UserRow } from '../db/db.js';

type ConversationAccessRow = Pick<ConversationRow, 'user_id' | 'visibility'>;

export function canViewConversation(
  user: Pick<UserRow, 'id'>,
  conversation: ConversationAccessRow,
): boolean {
  return conversation.visibility === 'team' || conversation.user_id === user.id;
}

export function canSendToConversation(user: Pick<UserRow, 'id'>, conversation: ConversationAccessRow): boolean {
  return conversation.visibility === 'team' || conversation.user_id === user.id;
}

export function canManageConversation(
  user: Pick<UserRow, 'id'>,
  conversation: ConversationAccessRow,
): boolean {
  return conversation.visibility === 'team' || conversation.user_id === user.id;
}

/** Changing Team/Private visibility changes who can read the full transcript.
 * Keep that privacy boundary with the creator even though every collaborator
 * can otherwise manage a Team chat. */
export function canChangeConversationVisibility(
  user: Pick<UserRow, 'id'>,
  conversation: ConversationAccessRow,
): boolean {
  return conversation.user_id === user.id;
}
