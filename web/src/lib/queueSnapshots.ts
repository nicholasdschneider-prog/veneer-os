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
