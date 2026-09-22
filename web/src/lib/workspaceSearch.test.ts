import { describe, it, expect } from 'vitest';
import { workspaceSearchFocusKey } from './workspaceSearch';
describe('workspace search permalinks', () => {
  const items = [
    { kind: 'user', key: 'u1', turnId: 't1', at: '2026-09-22T12:00:00Z' },
    { kind: 'assistant', key: 'a4', turnId: 't1', at: '2026-09-22T12:01:00Z' },
    { kind: 'assistant', key: 'a5', turnId: 't1', at: '2026-09-22T12:02:00Z' },
  ];
  it('lands on the exact response even when the same turn has several responses', () => {
    expect(
      workspaceSearchFocusKey(
        'search:' +
          JSON.stringify({
            role: 'assistant',
            turn: 't1',
            at: '2026-09-22T12:02:00Z',
          }),
        items,
      ),
    ).toBe('a5');
  });
  it('ignores invalid, stale and ordinary message references', () => {
    for (const value of [
      '7',
      'search:broken',
      'search:null',
      'search:' +
        JSON.stringify({ role: 'tool', turn: 't1', at: items[0]!.at }),
      'search:' +
        JSON.stringify({
          role: 'assistant',
          turn: 'missing',
          at: items[0]!.at,
        }),
    ])
      expect(workspaceSearchFocusKey(value, items)).toBeNull();
  });
});
