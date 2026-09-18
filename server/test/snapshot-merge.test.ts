import { describe, expect, it, vi } from 'vitest';
import { promptWithMemoryReference } from '../src/instructions/context.js';
import { mergeLiveIntoSnapshot, settleOrphanedSubagentEvents } from '../src/runtime/conversationManager.js';
import type { ConversationEvent } from '../src/runtime/events.js';

const started = (turnId: string, text: string): ConversationEvent => ({
  type: 'turn_started',
  turnId,
  role: 'user',
  text,
  at: '2026-01-01T00:00:00Z',
  via: 'web',
});
const final = (turnId: string, markdown: string): ConversationEvent => ({
  type: 'text_final',
  turnId,
  markdown,
  at: '2026-01-01T00:00:01Z',
});

describe('mergeLiveIntoSnapshot', () => {
  it('returns file events untouched when no turn is live', () => {
    const file = [started('t1', 'hi'), final('t1', 'hello')];
    expect(mergeLiveIntoSnapshot(file, null)).toEqual(file);
  });

  it('appends the live buffer when the file lags (in-flight user row not on disk yet)', () => {
    const file = [started('t1', 'hi'), final('t1', 'hello')];
    const turn = { promptText: 'next question', events: [started('live', 'next question')], partialText: 'par' };
    const merged = mergeLiveIntoSnapshot(file, turn);
    expect(merged).toHaveLength(4);
    expect(merged[2]).toMatchObject({ type: 'turn_started', text: 'next question' });
    expect(merged[3]).toMatchObject({ type: 'text_delta', text: 'par' });
  });

  it("replaces the file's copy of the in-flight turn with the live buffer", () => {
    const file = [
      started('t1', 'hi'),
      final('t1', 'hello'),
      started('t2', 'next question'), // in-flight turn already on disk
      final('t2', 'partial answer written to file'),
    ];
    const turn = {
      promptText: 'next question',
      events: [started('live', 'next question'), final('live', 'partial answer written to file')],
      partialText: '',
    };
    const merged = mergeLiveIntoSnapshot(file, turn);
    expect(merged).toHaveLength(4);
    expect(merged[2]).toMatchObject({ turnId: 'live', text: 'next question' });
    expect(merged[3]).toMatchObject({ turnId: 'live' });
  });

  it("replaces a provider echo containing the turn's memory envelope", () => {
    const prompt = 'next question';
    const file = [
      started('t1', 'hi'),
      final('t1', 'hello'),
      started('t2', promptWithMemoryReference(prompt, '<stored_user_data>remember this</stored_user_data>')),
    ];
    const turn = {
      promptText: prompt,
      events: [started('live', prompt)],
      partialText: '',
    };

    const merged = mergeLiveIntoSnapshot(file, turn);

    expect(merged).toHaveLength(3);
    expect(merged[2]).toMatchObject({ turnId: 'live', text: prompt });
  });

  it('does not truncate history when the tail turn_started is a previous turn', () => {
    const file = [started('t1', 'old prompt'), final('t1', 'old answer')];
    const turn = { promptText: 'brand new', events: [started('live', 'brand new')], partialText: '' };
    const merged = mergeLiveIntoSnapshot(file, turn);
    expect(merged).toHaveLength(3);
    expect(merged[0]).toMatchObject({ text: 'old prompt' });
  });

  it('does not cut a completed prior turn when the in-flight turn repeats its prompt', () => {
    // Turn 1 ("ok") finished and is on disk; turn 2 ("ok") is in flight but its
    // user row hasn't flushed yet. Identical text must NOT cut turn 1's exchange.
    const file = [started('t1', 'ok'), final('t1', 'first answer')];
    const turn = { promptText: 'ok', events: [started('live', 'ok')], partialText: '' };
    const merged = mergeLiveIntoSnapshot(file, turn);
    expect(merged).toHaveLength(3);
    expect(merged[0]).toMatchObject({ text: 'ok' });
    expect(merged[1]).toMatchObject({ type: 'text_final', markdown: 'first answer' });
    expect(merged[2]).toMatchObject({ turnId: 'live', text: 'ok' });
  });

  it("still replaces the in-flight turn's partial when it duplicates the prior prompt", () => {
    // Same duplicate "ok", but now turn 2's partial answer HAS landed on disk and
    // the live turn has produced content — that disk copy is the one to drop.
    const file = [
      started('t1', 'ok'),
      final('t1', 'first answer'),
      started('t2', 'ok'),
      final('t2', 'partial second answer'),
    ];
    const turn = {
      promptText: 'ok',
      events: [started('live', 'ok'), final('live', 'authoritative second answer')],
      partialText: '',
    };
    const merged = mergeLiveIntoSnapshot(file, turn);
    expect(merged).toHaveLength(4);
    expect(merged[1]).toMatchObject({ markdown: 'first answer' });
    expect(merged[2]).toMatchObject({ turnId: 'live', text: 'ok' });
    expect(merged[3]).toMatchObject({ turnId: 'live', markdown: 'authoritative second answer' });
  });
});

describe('settleOrphanedSubagentEvents', () => {
  const launched = (turnId: string, agentKey: string): ConversationEvent => ({
    type: 'subagent_started',
    turnId,
    agentKey,
    label: 'Task',
    status: 'running',
    startedAt: '2026-01-01T00:00:00Z',
  });

  it('marks trailing running agents stopped when nothing is live', () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-01-01T00:01:00Z'));
    try {
      const events = [started('t1', 'go'), launched('t1', 'a')];
      const settled = settleOrphanedSubagentEvents(events);
      expect(settled.at(-1)).toMatchObject({ type: 'subagent_updated', turnId: 't1', agentKey: 'a', status: 'stopped' });
      expect(mergeLiveIntoSnapshot(events, null, { settleOrphans: true })).toEqual(settled);
    } finally { clock.mockRestore(); }
  });

  it('leaves settled agents alone and returns the same array', () => {
    const events = [
      started('t1', 'go'),
      launched('t1', 'a'),
      { type: 'subagent_updated', turnId: 't1', agentKey: 'a', status: 'completed' } as ConversationEvent,
    ];
    expect(settleOrphanedSubagentEvents(events)).toBe(events);
  });

  it('does not touch agents while a live turn is overlaying the snapshot', () => {
    const events = [started('t1', 'go'), launched('t1', 'a')];
    const merged = mergeLiveIntoSnapshot(
      events,
      { promptText: 'go', events: [started('t1', 'go'), launched('t1', 'a')], partialText: '' },
      { settleOrphans: true },
    );
    expect(merged.some((event) => event.type === 'subagent_updated')).toBe(false);
  });
});
