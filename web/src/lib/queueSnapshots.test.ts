import { describe, expect, it } from 'vitest';
import type { ConversationQueueSnapshot } from './types';
import { pendingSendsForDisplay, newestQueueSnapshot, type OrderedQueueSnapshot } from './queueSnapshots';

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

it('renders one bubble per rapid send when WebSocket receipts arrive before HTTP responses', () => {
  const pending=[{id:'first',text:'Same message',queueFloor:7},{id:'second',text:'Same message',queueFloor:7}];
  const row=(id:number)=>({id,text:'Same message',createdAt:'2026-09-25T21:00:00Z',delivered:true as const});
  expect(pendingSendsForDisplay(pending,[row(7)])).toEqual(pending);
  expect(pendingSendsForDisplay(pending,[row(7),row(8)])).toEqual([pending[1]]);
  expect(pendingSendsForDisplay(pending,[row(7),row(8),row(9)])).toEqual([]);
  expect(pending).toHaveLength(2);
});
