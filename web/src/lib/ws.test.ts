import { describe, expect, it, vi } from 'vitest';
import { deliverServerFrame, type SubscriptionHandlers } from './ws';

describe('conversation WebSocket activity', () => {
  it('keeps presence markers out of normal chat transcripts during subscription changes', () => {
    const onEvent = vi.fn();
    const frame = { kind: 'presence' as const, event: { type: 'text_delta', text: '…' } };
    deliverServerFrame(frame, { onEvent });
    expect(onEvent).not.toHaveBeenCalled();
    deliverServerFrame(frame, { onEvent, presenceOnly: true });
    expect(onEvent).toHaveBeenCalledOnce();
  });
  it('restores compaction from snapshots and clears it from live status', () => {
    const onSnapshot = vi.fn<NonNullable<SubscriptionHandlers['onSnapshot']>>();
    const onStatus = vi.fn<NonNullable<SubscriptionHandlers['onStatus']>>();

    deliverServerFrame(
      {
        kind: 'snapshot',
        conversationId: 'chat-1',
        events: [],
        status: 'working',
        activity: 'compacting',
        queue: { revision: 1, messages: [], failedTurn: null },
      },
      { onSnapshot, onStatus },
    );
    expect(onSnapshot).toHaveBeenCalledWith(
      [],
      'working',
      { revision: 1, messages: [], failedTurn: null },
      'compacting',
      [],
    );

    deliverServerFrame(
      { kind: 'status', conversationId: 'chat-1', status: 'idle', activity: null },
      { onSnapshot, onStatus },
    );
    expect(onStatus).toHaveBeenCalledWith('idle', null);
  });
});
