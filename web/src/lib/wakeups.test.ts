import { describe, expect, it } from 'vitest';
import { deliverServerFrame } from './ws';
import { toPendingWakeups } from './wakeups';

const row = {
  id: 'wake-1',
  wake_key: 'build-check',
  reason: 'Check the build',
  scheduled_for: '2026-08-24T15:18:00.000Z',
  created_at: '2026-08-24 15:00:00',
  status: 'pending',
};

describe('toPendingWakeups', () => {
  it('normalizes rows, treats bare SQLite timestamps as UTC, and sorts by time', () => {
    const later = { ...row, id: 'wake-2', scheduled_for: '2026-08-24T16:00:00.000Z' };
    expect(toPendingWakeups([later, row]).map((wake) => wake.id)).toEqual(['wake-1', 'wake-2']);
    expect(toPendingWakeups([row])[0]).toEqual({
      id: 'wake-1',
      key: 'build-check',
      reason: 'Check the build',
      scheduledFor: '2026-08-24T15:18:00.000Z',
      createdAt: '2026-08-24T15:00:00.000Z',
    });
  });

  it('drops rows that already fired or were cancelled', () => {
    expect(toPendingWakeups([{ ...row, status: 'delivered' }])).toEqual([]);
  });
});

describe('wake-up frames', () => {
  it('carries pending wakes on the snapshot and on live updates', () => {
    const snapshots: unknown[] = [];
    const live: unknown[] = [];
    deliverServerFrame({ kind: 'snapshot', events: [], wakeups: [row] }, {
      onSnapshot: (_events, _status, _queue, _activity, wakeups) => snapshots.push(wakeups),
    });
    deliverServerFrame({ kind: 'wakeups', wakeups: [row] }, { onWakeups: (wakeups) => live.push(wakeups) });
    expect(snapshots).toEqual([toPendingWakeups([row])]);
    expect(live).toEqual([toPendingWakeups([row])]);
  });
});
