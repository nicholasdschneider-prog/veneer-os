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

describe('mergeLiveIntoSnapshot with steered lines', () => {
  // A voice call steers "[Voice call] bin 018260821" into the running turn; the
  // adapter echoes it as a further turn_started with the same turnId.
  it('drops the whole disk copy of a steered in-flight turn, echo included', () => {
    const file = [
      started('t1', 'old prompt'), final('t1', 'old answer'),
      started('t2', 'find the part'), final('t2', 'I found a likely match: 2021124055'),
      started('t2', '[Voice call] bin 018260821'), final('t2', 'Normalized bin BIN-018-260821'),
    ];
    const turn = { promptText: 'find the part', events: [
      started('live', 'find the part'), final('live', 'I found a likely match: 2021124055'),
      started('live', '[Voice call] bin 018260821'), final('live', 'Normalized bin BIN-018-260821'),
    ], partialText: '' };
    const merged = mergeLiveIntoSnapshot(file, turn);
    expect(merged).toHaveLength(6);
    expect(merged.slice(0, 2)).toEqual(file.slice(0, 2));
    expect(merged.slice(2)).toEqual(turn.events);
    expect(merged.filter(e => e.type === 'text_final')).toHaveLength(3);
  });
  it('cuts at the opening prompt when the steered echo has not reached the disk yet', () => {
    const file = [started('t1', 'old prompt'), final('t1', 'old answer'), started('t2', 'find the part'), final('t2', 'I found a likely match')];
    const turn = { promptText: 'find the part', events: [started('live', 'find the part'), final('live', 'I found a likely match'), started('live', '[Voice call] bin 018260821')], partialText: '' };
    const merged = mergeLiveIntoSnapshot(file, turn);
    expect(merged).toHaveLength(5);
    expect(merged.slice(2)).toEqual(turn.events);
  });
  it('does not cut history when a steered line repeats an older completed prompt', () => {
    const file = [
      started('t1', 'check status'), final('t1', 'all clear'),
      started('t2', 'find the part'), final('t2', 'partial'),
      started('t2', 'check status'), final('t2', 'still clear'),
    ];
    const turn = { promptText: 'find the part', events: [started('live', 'find the part'), final('live', 'partial'), started('live', 'check status'), final('live', 'still clear')], partialText: '' };
    const merged = mergeLiveIntoSnapshot(file, turn);
    expect(merged).toHaveLength(6);
    expect(merged[0]).toMatchObject({ turnId: 't1', text: 'check status' });
    expect(merged[1]).toMatchObject({ markdown: 'all clear' });
    expect(merged.slice(2)).toEqual(turn.events);
    // Without the echo on disk, the older completed exchange is still kept.
    const lagging = mergeLiveIntoSnapshot(file.slice(0, 4), turn);
    expect(lagging).toHaveLength(6);
    expect(lagging[0]).toMatchObject({ turnId: 't1' });
  });
  it('keeps an identical completed prompt when the steered echo also repeats the prompt text', () => {
    const file = [started('t1', 'ok'), final('t1', 'first'), started('t2', 'ok'), final('t2', 'second partial'), started('t2', 'ok'), final('t2', 'after steer')];
    const turn = { promptText: 'ok', events: [started('live', 'ok'), final('live', 'second partial'), started('live', 'ok'), final('live', 'after steer')], partialText: '' };
    const merged = mergeLiveIntoSnapshot(file, turn);
    expect(merged).toHaveLength(6);
    expect(merged[1]).toMatchObject({ markdown: 'first' });
    expect(merged.slice(2)).toEqual(turn.events);
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
