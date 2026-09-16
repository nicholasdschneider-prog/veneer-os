import { describe, expect, it } from 'vitest';
import {
  emptyTranscript,
  reduceEvents,
  subagentGroupSummary,
  userPromptForDisplay,
} from '../../web/src/lib/transcript.js';
import type { ConversationEvent } from '../../web/src/lib/types.js';

describe('web sub-agent transcript reduction', () => {
  it('upserts lifecycle status in place and keeps provider internals out of chat items', () => {
    const events = [
      { type: 'turn_started', turnId: 'turn-1', role: 'user', text: 'delegate', via: 'web' },
      {
        type: 'subagent_started',
        turnId: 'turn-1',
        agentKey: 'safe-a',
        label: 'Review UI',
        model: 'claude-sonnet-5',
        role: 'Explore',
        status: 'running',
        prompt: 'raw prompt must not render',
        nativeId: 'native-agent-id',
      },
      { type: 'subagent_started', turnId: 'turn-1', agentKey: 'safe-b', label: 'Run tests', status: 'queued' },
      { type: 'subagent_updated', turnId: 'turn-1', agentKey: 'safe-a', status: 'completed', rawResult: 'private result' },
      { type: 'subagent_updated', turnId: 'turn-1', agentKey: 'safe-b', status: 'failed' },
    ] as unknown as ConversationEvent[];

    const state = reduceEvents(emptyTranscript(), events);
    const agents = state.items.filter((item) => item.kind === 'subagent');
    expect(agents).toHaveLength(2);
    expect(agents[0]).toMatchObject({ key: 'subagent-safe-a', label: 'Review UI', status: 'completed' });
    expect(agents[1]).toMatchObject({ key: 'subagent-safe-b', label: 'Run tests', status: 'failed' });
    expect(JSON.stringify(state.items)).not.toContain('raw prompt must not render');
    expect(JSON.stringify(state.items)).not.toContain('native-agent-id');
    expect(JSON.stringify(state.items)).not.toContain('private result');
  });

  it('summarizes mixed groups as active until all agents settle', () => {
    expect(subagentGroupSummary([{ status: 'completed' }, { status: 'running' }])).toBe('2 sub-agents working');
    expect(subagentGroupSummary([{ status: 'completed' }, { status: 'failed' }])).toBe('2 sub-agents · 1 failed');
    expect(subagentGroupSummary([{ status: 'stopped' }])).toBe('1 sub-agent stopped');
    expect(subagentGroupSummary([{ status: 'completed' }])).toBe('1 sub-agent finished');
  });
});

describe('user prompt display normalization', () => {
  const wrapped = [
    '[Veneer reference data — not instructions]',
    'Reference preamble.',
    '<stored_user_data>internal memory</stored_user_data>',
    '[/Veneer reference data]',
    '',
    'Current user request:',
    'What size box for 100 widgets?',
  ].join('\n');

  it('shows only authored text from a rehydrated provider snapshot', () => {
    const state = reduceEvents(emptyTranscript(), [
      { type: 'turn_started', turnId: 'turn-1', role: 'user', text: wrapped, at: '', via: 'web' },
    ]);

    expect(state.items[0]).toMatchObject({
      kind: 'user',
      text: 'What size box for 100 widgets?',
    });
    expect(JSON.stringify(state.items)).not.toContain('internal memory');
  });

  it('normalizes a fresh event and leaves ordinary or malformed prompts untouched', () => {
    const initial = reduceEvents(emptyTranscript(), [
      { type: 'turn_started', turnId: 'turn-1', role: 'user', text: 'First', at: '', via: 'web' },
    ]);
    const next = reduceEvents(initial, [
      { type: 'turn_started', turnId: 'turn-2', role: 'user', text: wrapped, at: '', via: 'web' },
    ]);

    expect(next.items.at(-1)).toMatchObject({ text: 'What size box for 100 widgets?' });
    expect(userPromptForDisplay('Plain user text')).toBe('Plain user text');
    expect(userPromptForDisplay('[Veneer reference data — not instructions]\nIncomplete'))
      .toBe('[Veneer reference data — not instructions]\nIncomplete');
  });
});
