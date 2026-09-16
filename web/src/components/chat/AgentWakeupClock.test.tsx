import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AgentWakeupClock } from './AgentWakeupClock';

describe('AgentWakeupClock', () => {
  it('renders only while the agent has a pending wake-up', () => {
    expect(renderToStaticMarkup(<AgentWakeupClock active={false} />)).toBe('');
    expect(renderToStaticMarkup(<AgentWakeupClock active />)).toContain(
      'aria-label="Agent has a scheduled wake-up"',
    );
  });
});
