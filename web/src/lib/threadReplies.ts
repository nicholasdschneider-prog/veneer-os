import type { MessageOrigin } from './types';

export type ReplyAnchor = { turn: string; at: string };
export type ThreadReply = {
  id: string; seq: number; thread_id: string; anchor: string; source_text: string;
  text: string; actor_name: string; actor_conversation_id: string | null;
  bot_name: string; created_at: string; unread: number;
};
export function replyTime(reply: ThreadReply) {
  return Date.parse(reply.created_at.replace(' ', 'T') + 'Z');
}
export function mergeThreadReplies(current: ThreadReply[], incoming: ThreadReply[]) {
  if (!incoming.length) return current;
  const byId = new Map(current.map(r => [r.id, r]));
  for (const reply of incoming) byId.set(reply.id, reply);
  return [...byId.values()].sort((a,b) => a.seq-b.seq);
}

/** Replies already have a canonical quoted row in the chat's reply feed. */
export function isResultReplyDelivery(item: { text: string; origin?: MessageOrigin }): boolean {
  if (item.origin?.kind === 'result_reply') return true;
  // Older pending/history notifications retain the scheduler wrapper. Hide only
  // authenticated wakeups matching this exact internal notification format.
  return item.origin?.kind === 'wakeup'
    && /^Hey, can you pick this back up for me\?\n\nA human replied in message thread [0-9a-f-]{36}\. Use read_message_thread /.test(item.text);
}
