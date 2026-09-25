import { describe, expect, it } from 'vitest';
import { emptyTranscript, reduceEvents, subagentProgressSummary, transcriptItemsForDisplay } from './transcript';
import type { ConversationEvent } from './types';

describe('message authorship transcript', () => {
  it('uses a durable message key for an exact handoff target', () => {
    const state = reduceEvents(emptyTranscript(), [{
      type: 'turn_started',
      turnId: 'turn-1',
      role: 'user',
      text: 'Use these findings.',
      at: '2026-01-01T00:00:00.000Z',
      via: 'web',
      messageId: 42,
    }]);

    expect(state.items[0]).toMatchObject({ key: 'u-message-42', text: 'Use these findings.' });
  });

  it('preserves authenticated agent origin metadata on user-role prompt events', () => {
    const origin = {
      kind: 'agent' as const,
      from: 'Researcher',
      to: 'Writer',
      local: true as const,
      sourceChat: {
        id: 'research-chat',
        title: 'Market research',
      },
    };
    const state = reduceEvents(emptyTranscript(), [{
      type: 'turn_started',
      turnId: 'turn-1',
      role: 'user',
      text: 'Use these findings.',
      at: '2026-01-01T00:00:00.000Z',
      via: 'web',
      origin,
    }]);

    expect(state.items).toEqual([expect.objectContaining({
      kind: 'user',
      text: 'Use these findings.',
      origin,
    })]);
  });

  it('preserves authenticated build queue origin metadata', () => {
    const state = reduceEvents(emptyTranscript(), [{
      type: 'turn_started',
      turnId: 'turn-build',
      role: 'user',
      text: 'Automatic build instructions',
      at: '2026-01-01T00:00:00.000Z',
      via: 'web',
      origin: { kind: 'build_queue', from: 'Build queue', to: 'platform-dev' },
    }]);

    expect(state.items[0]).toMatchObject({
      kind: 'user',
      origin: { kind: 'build_queue', from: 'Build queue', to: 'platform-dev' },
    });
  });

  it('does not trust malformed origin metadata from a transcript', () => {
    const state = reduceEvents(emptyTranscript(), [{
      type: 'turn_started',
      turnId: 'turn-1',
      role: 'user',
      text: 'Human message',
      at: '2026-01-01T00:00:00.000Z',
      via: 'web',
      origin: { kind: 'agent', from: 'Spoofed' },
    } as unknown as ConversationEvent]);

    expect(state.items[0]).not.toHaveProperty('origin');
  });

  it('drops malformed or internal source-link metadata from the web transcript', () => {
    const state = reduceEvents(emptyTranscript(), [{
      type: 'turn_started',
      turnId: 'turn-1',
      role: 'user',
      text: 'Agent message',
      at: '2026-01-01T00:00:00.000Z',
      via: 'web',
      origin: {
        kind: 'agent',
        from: 'Researcher',
        to: 'Writer',
        sourceChat: { id: '', title: 'Should not link' },
        sourceConversationId: 'private-chat',
        sourceConversationTitle: 'Private title',
      },
    } as unknown as ConversationEvent]);

    expect(state.items[0]).toMatchObject({
      origin: { kind: 'agent', from: 'Researcher', to: 'Writer' },
    });
    expect(state.items[0]).not.toHaveProperty('origin.sourceChat');
    expect(state.items[0]).not.toHaveProperty('origin.sourceConversationId');
    expect(state.items[0]).not.toHaveProperty('origin.sourceConversationTitle');
  });

  it('accepts only the authenticated boolean local-handoff marker', () => {
    const accepted = reduceEvents(emptyTranscript(), [{
      type: 'turn_started',
      turnId: 'turn-local',
      role: 'user',
      text: 'Local agent message',
      at: '2026-01-01T00:00:00.000Z',
      via: 'web',
      origin: { kind: 'agent', from: 'Researcher', to: 'Writer', local: true },
    }]);
    expect(accepted.items[0]).toMatchObject({ origin: { local: true } });

    const rejected = reduceEvents(emptyTranscript(), [{
      type: 'turn_started',
      turnId: 'turn-spoofed',
      role: 'user',
      text: 'Untrusted marker',
      at: '2026-01-01T00:00:00.000Z',
      via: 'web',
      origin: { kind: 'agent', from: 'Researcher', to: 'Writer', local: 'yes' },
    } as unknown as ConversationEvent]);
    expect(rejected.items[0]).not.toHaveProperty('origin.local');
  });
});

describe('agent message tool receipts', () => {
  it('merges finished delivery metadata onto the exact outbound tool item', () => {
    const started = {
      kind: 'agent-message' as const,
      text: 'Exact outbound text.',
      targetChat: { id: 'swap-chat', title: 'Swap testing', agentName: 'SwapBot' },
    };
    const state = reduceEvents(emptyTranscript(), [
      {
        type: 'tool_started',
        turnId: 'turn-1',
        toolId: 'send-1',
        toolName: 'mcp__agents__send_message',
        displayName: 'Using agents',
        inputPreview: 'truncated',
        agentMessageDetails: started,
      },
      {
        type: 'tool_finished',
        turnId: 'turn-1',
        toolId: 'send-1',
        ok: true,
        agentMessageDetails: { ...started, disposition: 'steered', messageId: 42 },
      },
    ]);

    expect(state.items[0]).toMatchObject({
      kind: 'tool',
      running: false,
      ok: true,
      agentMessageDetails: {
        text: 'Exact outbound text.',
        disposition: 'steered',
        messageId: 42,
        targetChat: { agentName: 'SwapBot' },
      },
    });
  });

  it('keeps the delivered disposition, which reports a live but unread hand-off', () => {
    const details = {
      kind: 'agent-message' as const,
      text: 'Exact outbound text.',
      targetChat: { id: 'swap-chat', title: 'Swap testing', agentName: 'SwapBot' },
    };
    const state = reduceEvents(emptyTranscript(), [
      {
        type: 'tool_started',
        turnId: 'turn-1',
        toolId: 'send-1',
        toolName: 'mcp__agents__send_message',
        displayName: 'Using agents',
        inputPreview: 'truncated',
        agentMessageDetails: details,
      },
      {
        type: 'tool_finished',
        turnId: 'turn-1',
        toolId: 'send-1',
        ok: true,
        agentMessageDetails: { ...details, disposition: 'delivered', messageId: 7 },
      },
    ]);
    expect(state.items[0]).toMatchObject({
      agentMessageDetails: { disposition: 'delivered', messageId: 7 },
    });
  });
});

describe('assistant response metadata transport', () => {
  it('keeps the final timestamp and applies completion usage to the matching response', () => {
    const state = reduceEvents(emptyTranscript(), [
      {
        type: 'text_final',
        turnId: 'turn-1',
        markdown: 'Finished.',
        at: '2026-08-28T19:45:00.000Z',
      },
      {
        type: 'turn_done',
        turnId: 'turn-1',
        outcome: 'completed',
        usage: {
          inputTokens: 18_000,
          outputTokens: 24,
          totalInputTokens: 31_176,
          totalOutputTokens: 24,
          totalTokens: 31_200,
        },
      },
    ]);

    expect(state.items).toEqual([{
      kind: 'assistant',
      key: 'a0',
      turnId: 'turn-1',
      markdown: 'Finished.',
      at: '2026-08-28T19:45:00.000Z',
      usage: { totalInputTokens: 31_176, totalOutputTokens: 24, totalTokens: 31_200 },
    }]);
  });

  it('prefers response-specific usage and gracefully omits malformed legacy metadata', () => {
    const state = reduceEvents(emptyTranscript(), [
      {
        type: 'text_final',
        turnId: 'turn-1',
        markdown: 'One provider response.',
        at: 'invalid',
        usage: {
          inputTokens: 1_200,
          outputTokens: 50,
          totalInputTokens: 1_200,
          totalOutputTokens: 50,
          totalTokens: 1_250,
        },
      },
      {
        type: 'turn_done',
        turnId: 'turn-1',
        usage: {
          inputTokens: 9_999,
          outputTokens: 999,
          totalInputTokens: 9_999,
          totalOutputTokens: 999,
          totalTokens: 10_998,
        },
      },
      {
        type: 'text_final',
        turnId: 'turn-2',
        markdown: 'Old response.',
        at: '',
        usage: { inputTokens: -1, outputTokens: 4, totalTokens: -1 },
      } as ConversationEvent,
    ]);

    expect(state.items[0]).toMatchObject({
      usage: { totalInputTokens: 1_200, totalOutputTokens: 50, totalTokens: 1_250 },
    });
    expect(state.items[1]).not.toHaveProperty('usage');
    expect(state.items[1]).not.toHaveProperty('at');
  });

  // The browser reduces ONE live frame at a time, so completion usage always
  // lands in a later call than the response it belongs to. Batched-array tests
  // cannot catch a regression that only breaks that incremental path.
  it('attaches live completion usage delivered one frame at a time', () => {
    const frames: ConversationEvent[] = [
      { type: 'turn_started', turnId: 'turn-1', text: 'first', at: '2026-08-28T19:40:00.000Z', role: 'user' },
      { type: 'text_final', turnId: 'turn-1', markdown: 'Older reply.', at: '2026-08-28T19:40:01.000Z' },
      {
        type: 'turn_done',
        turnId: 'turn-1',
        outcome: 'completed',
        usage: { inputTokens: 10, outputTokens: 2, totalInputTokens: 10, totalOutputTokens: 2, totalTokens: 12 },
      },
      { type: 'turn_started', turnId: 'turn-2', text: 'second', at: '2026-08-28T19:44:00.000Z', role: 'user' },
      { type: 'text_delta', turnId: 'turn-2', text: 'Working' },
      { type: 'text_final', turnId: 'turn-2', markdown: 'Working on it.', at: '2026-08-28T19:44:30.000Z' },
      { type: 'tool_started', turnId: 'turn-2', toolId: 'tool-1', toolName: 'Bash', displayName: 'Running', inputPreview: 'ls' },
      { type: 'tool_finished', turnId: 'turn-2', toolId: 'tool-1', ok: true, resultPreview: 'done' },
      { type: 'text_final', turnId: 'turn-2', markdown: 'Finished.', at: '2026-08-28T19:45:00.000Z' },
      {
        type: 'turn_done',
        turnId: 'turn-2',
        outcome: 'completed',
        usage: {
          inputTokens: 18_000,
          outputTokens: 24,
          totalInputTokens: 31_176,
          totalOutputTokens: 24,
          totalTokens: 31_200,
        },
      },
    ];

    const state = frames.reduce((acc, frame) => reduceEvents(acc, [frame]), emptyTranscript());
    const assistants = state.items.filter((item) => item.kind === 'assistant');

    expect(assistants).toHaveLength(3);
    // Whole-turn usage belongs to the turn's LAST response, and an earlier
    // turn's response must never be rewritten by a later completion.
    expect(assistants[0]).toMatchObject({
      markdown: 'Older reply.',
      usage: { totalTokens: 12 },
    });
    expect(assistants[1]).not.toHaveProperty('usage');
    expect(assistants[2]).toMatchObject({
      markdown: 'Finished.',
      at: '2026-08-28T19:45:00.000Z',
      usage: { totalInputTokens: 31_176, totalOutputTokens: 24, totalTokens: 31_200 },
    });
  });
});

describe('structured question transcript', () => {
  it('replaces a represented raw ask_user tool row with one durable card', () => {
    const events: ConversationEvent[] = [
      {
        type: 'tool_started',
        turnId: 'turn-1',
        toolId: 'tool-1',
        toolName: 'mcp__agents__ask_user',
        displayName: 'Asking you a question',
        inputPreview: '{"question":"Which channel?"}',
      },
      {
        type: 'question_asked',
        requestId: 'question-1',
        turnId: 'turn-1',
        responseMode: 'poll',
        questions: [{
          id: 'q1',
          question: 'Which channel?',
          options: [{ label: 'Stable', value: 'stable', description: 'Use the proven channel.' }],
          multi: false,
          allowOther: true,
        }],
      },
      { type: 'tool_finished', turnId: 'turn-1', toolId: 'tool-1', ok: true },
      { type: 'question_answered', requestId: 'question-1', answers: { q1: ['stable'] } },
    ];

    const state = reduceEvents(emptyTranscript(), events);
    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({
      kind: 'question',
      requestId: 'question-1',
      status: 'answered',
      answers: { q1: ['stable'] },
      questions: [{ options: [{ description: 'Use the proven channel.' }], allowOther: true }],
    });
  });

  it('replaces a represented raw request_secret tool row with the secret card', () => {
    const events: ConversationEvent[] = [
      {
        type: 'tool_started',
        turnId: 'turn-1',
        toolId: 'tool-1',
        toolName: 'mcp__agents__request_secret',
        displayName: 'Asking you for a secret',
        inputPreview: '{"name":"LINEAR_API_KEY"}',
      },
      {
        type: 'question_asked',
        requestId: 'secret-1',
        turnId: 'turn-1',
        responseMode: 'poll',
        questions: [{
          id: 'q1',
          question: 'I need a Linear API key.',
          options: [],
          multi: false,
          allowOther: true,
          kind: 'secret',
          secret: { name: 'LINEAR_API_KEY', project: 'veneer', config: 'prd', exists: false },
        }],
      },
      { type: 'tool_finished', turnId: 'turn-1', toolId: 'tool-1', ok: true },
    ];

    const state = reduceEvents(emptyTranscript(), events);
    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({
      kind: 'question',
      requestId: 'secret-1',
      status: 'pending',
      questions: [{
        kind: 'secret',
        secret: { name: 'LINEAR_API_KEY', project: 'veneer', config: 'prd', exists: false },
      }],
    });
  });

  it('keeps an unmatched legacy tool row as a diagnostic fallback', () => {
    const state = reduceEvents(emptyTranscript(), [{
      type: 'tool_started',
      turnId: 'turn-1',
      toolId: 'tool-1',
      toolName: 'mcp__agents__ask_user',
      displayName: 'Asking you a question',
      inputPreview: '{}',
    }]);
    expect(state.items).toEqual([expect.objectContaining({ kind: 'tool', toolName: 'mcp__agents__ask_user' })]);
  });

  it('rehydrates legacy single-question events', () => {
    const state = reduceEvents(emptyTranscript(), [
      {
        type: 'question_asked',
        requestId: 'legacy-question',
        question: 'Choose one',
        options: [{ label: 'A', value: 'a' }],
        multi: false,
      },
      { type: 'question_answered', requestId: 'legacy-question', answer: 'a' },
    ]);
    expect(state.items[0]).toMatchObject({
      kind: 'question',
      questions: [{ id: 'q1', question: 'Choose one' }],
      answers: { q1: ['a'] },
    });
  });

  it('hides dismissed question cards without discarding their lifecycle state', () => {
    const state = reduceEvents(emptyTranscript(), [
      {
        type: 'question_asked',
        requestId: 'dismissed-question',
        question: 'Choose one',
        options: [{ label: 'A', value: 'a' }],
        multi: false,
      },
      { type: 'question_answered', requestId: 'dismissed-question', dismissed: true },
    ]);

    expect(state.items).toEqual([expect.objectContaining({ kind: 'question', status: 'dismissed' })]);
    expect(transcriptItemsForDisplay(state.items)).toEqual([]);
  });
});

describe('sub-agent progress transcript', () => {
  it('upserts live aggregates in place and renders a compact receipt', () => {
    const state = reduceEvents(emptyTranscript(), [
      {
        type: 'subagent_started',
        turnId: 'turn-1',
        agentKey: 'safe-agent',
        label: 'Review UI',
        status: 'running',
        startedAt: '2026-01-01T00:00:00.000Z',
        currentAction: 'Starting',
        actionCount: 0,
      },
      {
        type: 'subagent_updated',
        turnId: 'turn-1',
        agentKey: 'safe-agent',
        status: 'running',
        currentAction: 'Running tests',
        actionCount: 2,
        filesChanged: 1,
        linesAdded: 3,
        linesRemoved: 1,
        resultLabel: 'Tests passed',
      },
    ]);
    const agents = state.items.filter((item) => item.kind === 'subagent');
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({ actionCount: 2, filesChanged: 1, linesAdded: 3, linesRemoved: 1 });
    expect(subagentProgressSummary(agents[0]!, Date.parse('2026-01-01T00:02:14.000Z'))).toBe(
      'Running tests · 2m 14s · 2 actions · 1 file changed · +3/−1 · Tests passed',
    );
  });

  it('uses a provider duration for stable rehydrated receipts and preserves zero totals', () => {
    const state = reduceEvents(emptyTranscript(), [{
      type: 'subagent_started',
      turnId: 'turn-1',
      agentKey: 'safe-agent',
      label: 'Inspect',
      status: 'completed',
      durationMs: 104_301,
      currentAction: 'Finished',
      actionCount: 0,
      filesChanged: 0,
      linesAdded: 0,
      linesRemoved: 0,
    }]);
    const agent = state.items.find((item) => item.kind === 'subagent');
    expect(agent?.kind).toBe('subagent');
    if (agent?.kind !== 'subagent') return;
    expect(subagentProgressSummary(agent)).toBe('Finished · 1m 44s · 0 actions · 0 files changed · +0/−0');
  });
});


it('preserves result-reply delivery provenance for deduplication against the reply feed', () => {
  const state = reduceEvents(emptyTranscript(), [{
    type: 'turn_started', turnId: 'reply-turn', text: 'Please explain', role:'user', at:'2026-09-25T21:00:00Z', via:'web',
    origin: {kind:'result_reply',from:'Human',to:'Bot'},
  }]);
  expect(state.items[0]).toMatchObject({origin:{kind:'result_reply',from:'Human',to:'Bot'}});
  expect(transcriptItemsForDisplay(state.items)).toEqual([]);
});
