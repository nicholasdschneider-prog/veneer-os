import type { ConversationQueueSnapshot } from './types';

export interface OrderedQueueSnapshot {
  conversationId: string;
  snapshot: ConversationQueueSnapshot;
}

/** Keep the newest server-created queue state when transports arrive out of order. */
export function newestQueueSnapshot(
  current: OrderedQueueSnapshot | null,
  conversationId: string,
  incoming: ConversationQueueSnapshot,
): OrderedQueueSnapshot {
  if (
    current?.conversationId === conversationId
    && incoming.revision < current.snapshot.revision
  ) {
    return current;
  }
  return { conversationId, snapshot: incoming };
}

/** A WebSocket receipt can precede the POST response. Prefer its durable row
 * over the matching optimistic bubble, without consuming either record. Match
 * each new row once so repeated identical sends retain their multiplicity. */
export function pendingSendsForDisplay<T extends { text: string; queueFloor?: number }>(
  pending: T[], messages: ConversationQueueSnapshot['messages'],
): T[] {
  const matched = new Set<number>();
  return pending.filter(item => {
    if (item.queueFloor === undefined) return true;
    const row = messages.find(message => message.id > item.queueFloor!
      && message.text === item.text && !matched.has(message.id));
    if (!row) return true;
    matched.add(row.id);
    return false;
  });
}
