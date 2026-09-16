import { describe, expect, it } from 'vitest';
import type { QuestionRow } from '../src/db/db.js';
import { reconcileQuestionEvents } from '../src/runtime/conversationManager.js';
import type { ConversationEvent } from '../src/runtime/events.js';

const started = (turnId: string, text: string, at: string): ConversationEvent => ({
  type: 'turn_started',
  turnId,
  role: 'user',
  text,
  at,
  via: 'web',
});

const final = (turnId: string, markdown: string, at: string): ConversationEvent => ({
  type: 'text_final',
  turnId,
  markdown,
  at,
});

const toolStarted = (
  turnId: string,
  toolId: string,
  toolName = 'mcp__agents__request_secret',
): ConversationEvent => ({
  type: 'tool_started',
  turnId,
  toolId,
  toolName,
  displayName: 'Request secret',
  inputPreview: '',
});

const toolFinished = (turnId: string, toolId: string): ConversationEvent => ({
  type: 'tool_finished',
  turnId,
  toolId,
  ok: true,
});

const row = (overrides: Partial<QuestionRow> = {}): QuestionRow => ({
  request_id: 'req-1',
  conversation_id: 'conv-1',
  // The runtime's UUID turn id — never appears in a reloaded Claude transcript.
  turn_id: 'dcedb8db-1f0e-4f2e-9a4f-0c5f6c9a2f11',
  response_mode: 'poll',
  questions_json: JSON.stringify([{ id: 'q1', question: 'API key?', options: [], multi: false }]),
  status: 'answered',
  answers_json: JSON.stringify({ q1: ['saved'] }),
  // sqlite datetime('now'): UTC, space separator, whole seconds.
  created_at: '2026-09-12 04:40:23',
  resolved_at: '2026-09-12 04:41:00',
  ...overrides,
});

const types = (events: ConversationEvent[]) => events.map((event) => event.type);

describe('reconcileQuestionEvents', () => {
  it('replaces the raw tool row in the right turn when turn ids do not match', () => {
    const events = [
      started('t0', 'first', '2026-09-12T04:30:00.000Z'),
      final('t0', 'done', '2026-09-12T04:30:05.000Z'),
      started('t1', 'need a key', '2026-09-12T04:40:20.000Z'),
      toolStarted('t1', 'tool-a'),
      toolFinished('t1', 'tool-a'),
      final('t1', 'saved it', '2026-09-12T04:41:10.000Z'),
      started('t2', 'later', '2026-09-12T04:50:00.000Z'),
      final('t2', 'ok', '2026-09-12T04:50:05.000Z'),
    ];

    const out = reconcileQuestionEvents(events, [row()]);

    expect(types(out)).toEqual([
      'turn_started',
      'text_final',
      'turn_started',
      'question_asked',
      'question_answered',
      'text_final',
      'turn_started',
      'text_final',
    ]);
    expect(out[3]).toMatchObject({ type: 'question_asked', requestId: 'req-1' });
    // The raw tool pair is gone, not merely hidden behind the card.
    expect(out.some((event) => event.type === 'tool_started')).toBe(false);
    expect(out.some((event) => event.type === 'tool_finished')).toBe(false);
  });

  it('lands the card at the end of its turn when no raw tool row is on disk', () => {
    const events = [
      started('t0', 'first', '2026-09-12T04:30:00.000Z'),
      final('t0', 'done', '2026-09-12T04:30:05.000Z'),
      started('t1', 'need a key', '2026-09-12T04:40:20.000Z'),
      final('t1', 'saved it', '2026-09-12T04:41:10.000Z'),
      started('t2', 'later', '2026-09-12T04:50:00.000Z'),
      final('t2', 'ok', '2026-09-12T04:50:05.000Z'),
    ];

    const out = reconcileQuestionEvents(events, [row()]);

    expect(types(out)).toEqual([
      'turn_started',
      'text_final',
      'turn_started',
      'text_final',
      'question_asked',
      'question_answered',
      'turn_started',
      'text_final',
    ]);
    // Regression guard: the card must not be appended to the transcript tail.
    expect(out[out.length - 1]).toMatchObject({ type: 'text_final', markdown: 'ok' });
  });

  it('keeps subagent tool rows inside the asking turn', () => {
    const events = [
      started('t0', 'need a key', '2026-09-12T04:40:20.000Z'),
      // Subagent events carry their own per-subagent turn id.
      toolStarted('sub-1', 'tool-a'),
      toolFinished('sub-1', 'tool-a'),
      final('t0', 'saved it', '2026-09-12T04:41:10.000Z'),
      started('t1', 'later', '2026-09-12T04:50:00.000Z'),
    ];

    const out = reconcileQuestionEvents(events, [row()]);

    expect(types(out)).toEqual([
      'turn_started',
      'question_asked',
      'question_answered',
      'text_final',
      'turn_started',
    ]);
  });

  it('places a question asked in the same second as its turn start', () => {
    const events = [
      started('t0', 'first', '2026-09-12T04:30:00.000Z'),
      final('t0', 'done', '2026-09-12T04:30:05.000Z'),
      // sqlite truncated the row to 04:40:23, half a second "before" this start.
      started('t1', 'need a key', '2026-09-12T04:40:23.500Z'),
      final('t1', 'saved it', '2026-09-12T04:41:10.000Z'),
    ];

    const out = reconcileQuestionEvents(events, [row()]);

    expect(types(out)).toEqual([
      'turn_started',
      'text_final',
      'turn_started',
      'text_final',
      'question_asked',
      'question_answered',
    ]);
  });

  it('orders several cards in one turn by created_at', () => {
    const events = [
      started('t0', 'need keys', '2026-09-12T04:40:00.000Z'),
      toolStarted('t0', 'tool-a'),
      toolFinished('t0', 'tool-a'),
      toolStarted('t0', 'tool-b', 'mcp__agents__ask_user'),
      toolFinished('t0', 'tool-b'),
      final('t0', 'done', '2026-09-12T04:45:00.000Z'),
    ];

    const out = reconcileQuestionEvents(events, [
      row({ request_id: 'second', created_at: '2026-09-12 04:42:00' }),
      row({ request_id: 'first', created_at: '2026-09-12 04:41:00' }),
    ]);

    expect(out.filter((event) => event.type === 'question_asked')).toMatchObject([
      { requestId: 'first' },
      { requestId: 'second' },
    ]);
  });

  it('still matches on an exact turn id (live turns, Codex)', () => {
    const events = [
      started('turn-uuid', 'need a key', '2026-09-12T04:40:20.000Z'),
      toolStarted('turn-uuid', 'tool-a'),
      toolFinished('turn-uuid', 'tool-a'),
      final('turn-uuid', 'saved it', '2026-09-12T04:41:10.000Z'),
    ];

    const out = reconcileQuestionEvents(events, [row({ turn_id: 'turn-uuid' })]);

    expect(types(out)).toEqual(['turn_started', 'question_asked', 'question_answered', 'text_final']);
  });

  it('replaces raw question_asked/question_answered events with the durable row', () => {
    const events: ConversationEvent[] = [
      started('t0', 'need a key', '2026-09-12T04:40:20.000Z'),
      { type: 'question_asked', requestId: 'req-1', turnId: 't0', questions: [], responseMode: 'poll' },
      { type: 'question_answered', requestId: 'req-1', answers: {}, answer: '' },
      final('t0', 'saved it', '2026-09-12T04:41:10.000Z'),
    ];

    const out = reconcileQuestionEvents(events, [row({ status: 'dismissed' })]);

    expect(types(out)).toEqual(['turn_started', 'question_asked', 'question_answered', 'text_final']);
    expect(out[2]).toMatchObject({ dismissed: true });
  });

  it('appends when no turn can be resolved at all', () => {
    const events = [final('t0', 'orphan transcript', '2026-09-12T04:30:00.000Z')];

    const out = reconcileQuestionEvents(events, [row()]);

    expect(types(out)).toEqual(['text_final', 'question_asked', 'question_answered']);
  });

  it('returns the events untouched when there are no rows', () => {
    const events = [started('t0', 'hi', '2026-09-12T04:30:00.000Z')];
    expect(reconcileQuestionEvents(events, [])).toBe(events);
  });
});
