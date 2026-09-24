import { describe, expect, it } from 'vitest';
import { coordinationItems, type CoordinationView } from './Coordination';

describe('coordination timeline', () => {
  it('orders the two sessions chronologically without mixing their streaming text or tool output', () => {
    const view: CoordinationView = {
      label: 'Clara ↔ Grant',
      lanes: [
        {
          id: 'c',
          name: 'Clara',
          status: 'idle',
          events: [
            {
              type: 'turn_started',
              turnId: 'c1',
              role: 'user',
              text: 'Lookup',
              at: '2026-09-24T12:00:00Z',
              via: 'web',
            },
            { type: 'text_final', turnId: 'c1', markdown: 'Clara result' },
            {
              type: 'turn_started',
              turnId: 'c2',
              role: 'user',
              text: 'Follow-up',
              at: '2026-09-24T12:02:00Z',
              via: 'web',
            },
            { type: 'text_delta', turnId: 'c2', text: 'Checking' },
          ],
        },
        {
          id: 'g',
          name: 'Grant',
          status: 'idle',
          events: [
            {
              type: 'turn_started',
              turnId: 'g1',
              role: 'user',
              text: 'Result received',
              at: '2026-09-24T12:01:00Z',
              via: 'web',
            },
            { type: 'text_final', turnId: 'g1', markdown: 'Grant response' },
          ],
        },
      ],
    };
    const items = coordinationItems(view);
    expect(items.map((i) => i.name)).toEqual(['Clara', 'Grant', 'Clara']);
    expect(
      items[0]!.items.some(
        (i) => i.kind === 'assistant' && i.markdown === 'Clara result',
      ),
    ).toBe(true);
    expect(
      items[1]!.items.some(
        (i) => i.kind === 'assistant' && i.markdown === 'Grant response',
      ),
    ).toBe(true);
    expect(
      items[0]!.items.some(
        (i) => i.kind === 'assistant' && i.markdown.includes('Checking'),
      ),
    ).toBe(false);
  });
});
