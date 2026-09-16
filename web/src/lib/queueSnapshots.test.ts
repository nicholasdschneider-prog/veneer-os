import { describe, expect, it } from 'vitest';
import type { ConversationQueueSnapshot } from './types';
import { newestQueueSnapshot, type OrderedQueueSnapshot } from './queueSnapshots';

const beforeInterrupt: ConversationQueueSnapshot = {
  revision: 10,
  messages: [{ id: 7, text: 'Send this now', createdAt: '2026-08-05T12:00:00Z' }],
  failedTurn: null,
};
const afterPromotion: ConversationQueueSnapshot = {
  revision: 11,
  messages: [],
  failedTurn: null,
};

function deliver(snapshots: ConversationQueueSnapshot[]): OrderedQueueSnapshot | null {
  return snapshots.reduce<OrderedQueueSnapshot | null>(
    (current, snapshot) => newestQueueSnapshot(current, 'chat-1', snapshot),
    null,
  );
}

describe('ordered queue snapshots', () => {
  it('applies the HTTP snapshot followed by the newer WebSocket removal', () => {
    expect(deliver([beforeInterrupt, afterPromotion])?.snapshot.messages).toEqual([]);
  });

  it('does not restore a removed row when the older HTTP snapshot arrives last', () => {
    const state = deliver([afterPromotion, beforeInterrupt]);
    expect(state?.snapshot.revision).toBe(11);
    expect(state?.snapshot.messages).toEqual([]);
  });
});
