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
