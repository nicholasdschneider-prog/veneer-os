import { describe, expect, it } from 'vitest';
import { markProgressNotes, markRepeatedReplies, notePreview, restatementScore } from './assistantNotes';
import type { ThreadReply } from './threadReplies';
import { emptyTranscript, reduceEvents, transcriptItemsForDisplay, type ChatItem } from './transcript';
import { voiceTimeline } from './voiceTimeline';

const user = (key: string, turnId?: string, extra: Partial<Extract<ChatItem, { kind: 'user' }>> = {}): ChatItem =>
  ({ kind: 'user', key, text: 'question', turnId, ...extra });
const text = (key: string, turnId?: string, markdown = `message ${key}`, at?: string): ChatItem =>
  ({ kind: 'assistant', key, markdown, turnId, at });
const tool = (key: string): ChatItem => ({
  kind: 'tool', key, label: 'Running a command', actionLabel: 'Running a command', toolName: 'Bash',
  inputPreview: '', resultPreview: '', images: [], running: false, ok: true,
});
const collapsed = (items: ChatItem[]) =>
  Object.fromEntries(items.flatMap((item) => item.kind === 'assistant' && item.collapsed ? [[item.key, item.collapsed]] : []));

function reply(textValue: string, createdAt: string, bot = true, seq = 1): ThreadReply {
  return {
    id: `reply-${seq}`, seq, thread_id: 'thread', anchor: '{}', source_text: 'original', text: textValue,
    actor_name: bot ? 'Bot' : 'Nick', actor_conversation_id: bot ? 'chat' : null, bot_name: 'Bot',
    created_at: createdAt, unread: 0,
  };
}

describe('progress notes', () => {
  it('keeps only the last message of a finished turn as a full answer', () => {
    const items = [user('u', 't1'), text('a1', 't1'), tool('x'), text('a2', 't1'), tool('y'), text('a3', 't1')];
    expect(collapsed(markProgressNotes(items))).toEqual({ a1: 'note', a2: 'note' });
  });

  it('leaves a single-message turn and separate turns untouched, returning the same array', () => {
    const items = [user('u1', 't1'), text('a1', 't1'), user('u2', 't2'), tool('x'), text('a2', 't2')];
    expect(markProgressNotes(items)).toBe(items);
  });

  it('keeps the newest text of a running turn readable until a later message arrives', () => {
    const running = [user('u', 't1'), text('a1', 't1'), tool('x')];
    expect(collapsed(markProgressNotes(running))).toEqual({});
    expect(collapsed(markProgressNotes([...running, text('a2', 't1')]))).toEqual({ a1: 'note' });
  });

  it('keeps the last note of a turn that ended in an error or was stopped', () => {
    const items: ChatItem[] = [
      user('u', 't1'), text('a1', 't1'), tool('x'), text('a2', 't1'), tool('y'),
      { kind: 'error', key: 'e', message: 'Stopped' },
      user('u2', 't2'), text('a3', 't2'),
    ];
    expect(collapsed(markProgressNotes(items))).toEqual({ a1: 'note' });
  });

  it('treats a human message steered into the turn as the start of a new stretch', () => {
    const items = [user('u', 't1'), text('a1', 't1'), text('a2', 't1'), user('steer', 't1'), text('a3', 't1'), text('a4', 't1')];
    expect(collapsed(markProgressNotes(items))).toEqual({ a1: 'note', a3: 'note' });
  });

  it('keeps the text that introduces a question card', () => {
    const items: ChatItem[] = [
      user('u', 't1'), text('a1', 't1'),
      { kind: 'question', key: 'q', requestId: 'q', questions: [], status: 'answered', answers: {} },
      text('a2', 't1'),
    ];
    expect(collapsed(markProgressNotes(items))).toEqual({});
  });

  it('never collapses older rows that have no turn id', () => {
    const items = [user('u'), text('a1'), tool('x'), text('a2')];
    expect(markProgressNotes(items)).toBe(items);
  });

  it('never collapses a message that carries an image or a diagram', () => {
    const items = [
      user('u', 't1'), text('a1', 't1', 'Here it is ![shot](/tmp/a.png)'),
      text('a2', 't1', '```mermaid\ngraph TD;A-->B\n```'), text('a3', 't1', 'plain'), text('a4', 't1'),
    ];
    expect(collapsed(markProgressNotes(items))).toEqual({ a3: 'note' });
  });

  it('returns the same collapsed object on every pass so memoized rows stay put', () => {
    const items = [user('u', 't1'), text('a1', 't1'), text('a2', 't1')];
    expect(markProgressNotes(items)[1]).toBe(markProgressNotes([...items])[1]);
    expect(items[1]).not.toHaveProperty('collapsed');
  });

  it.each([
    ['Claude and OpenRouter', [
      { type: 'turn_started', turnId: 't', text: 'hi', at: '2026-10-03T14:00:00.000Z' },
      { type: 'text_delta', turnId: 't', text: 'Let me' },
      { type: 'text_final', turnId: 't', markdown: 'Let me look.', at: '2026-10-03T14:00:01.000Z' },
      { type: 'tool_started', turnId: 't', toolId: 'a', toolName: 'Bash', displayName: 'Running a command' },
      { type: 'tool_finished', turnId: 't', toolId: 'a', ok: true },
      { type: 'text_final', turnId: 't', markdown: 'Found it.', at: '2026-10-03T14:00:05.000Z' },
      { type: 'turn_done', turnId: 't' },
    ]],
    ['Codex app server', [
      { type: 'turn_started', turnId: 't', text: 'hi', at: '2026-10-03T14:00:00.000Z' },
      { type: 'text_final', turnId: 't', markdown: 'Yes, I see it. Checking the cause.', at: '2026-10-03T14:00:01.000Z' },
      { type: 'tool_started', turnId: 't', toolId: 'a', toolName: 'shell', displayName: 'Running a command' },
      { type: 'tool_finished', turnId: 't', toolId: 'a', ok: true },
      { type: 'text_final', turnId: 't', markdown: 'Yes, I see exactly what you mean.', at: '2026-10-03T14:00:05.000Z' },
      { type: 'turn_done', turnId: 't', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
    ]],
    ['Grok', [
      { type: 'turn_started', turnId: 't', text: 'hi', at: '2026-10-03T14:00:00.000Z' },
      { type: 'text_delta', turnId: 't', text: 'Checking' },
      { type: 'text_final', turnId: 't', markdown: 'Checking now.', at: '2026-10-03T14:00:01.000Z' },
      { type: 'tool_started', turnId: 't', toolId: 'a', toolName: 'read_file', displayName: 'Reading a file' },
      { type: 'tool_finished', turnId: 't', toolId: 'a', ok: true },
      { type: 'text_delta', turnId: 't', text: 'Done' },
      { type: 'text_final', turnId: 't', markdown: 'Done.', at: '2026-10-03T14:00:05.000Z' },
      { type: 'turn_done', turnId: 't' },
    ]],
  ])('collapses the note and keeps the answer for %s event streams', (_provider, events) => {
    const state = reduceEvents(emptyTranscript(), events as never);
    const marked = markProgressNotes(state.items).filter((item) => item.kind === 'assistant');
    expect(marked.map((item) => item.collapsed ?? 'full')).toEqual(['note', 'full']);
  });

  it('follows a live stream: the first message collapses only once the next one is final', () => {
    let state = reduceEvents(emptyTranscript(), [
      { type: 'turn_started', turnId: 't', text: 'hi' },
      { type: 'text_final', turnId: 't', markdown: 'Looking.' },
      { type: 'text_delta', turnId: 't', text: 'The answer' },
    ] as never);
    expect(collapsed(markProgressNotes(state.items))).toEqual({});
    state = reduceEvents(state, [{ type: 'text_final', turnId: 't', markdown: 'The answer is 4.' }] as never);
    expect(Object.values(collapsed(markProgressNotes(state.items)))).toEqual(['note']);
  });

  it('survives the timeline: collapsed notes stay in place between tool groups, live and frozen', () => {
    const items = markProgressNotes([user('u', 't1'), text('a1', 't1'), tool('x'), tool('y'), text('a2', 't1')]);
    for (const frozen of [0, items.length]) {
      const rows = voiceTimeline(items, frozen, []).entries.flatMap((entry) =>
        entry.kind === 'live' ? [entry.item] : entry.kind === 'static' ? entry.items : []);
      expect(rows.map((row) => row.kind === 'assistant' ? row.collapsed ?? 'full' : row.kind))
        .toEqual(['user', 'note', 'tool-group', 'full']);
    }
  });
});

describe('restated thread replies', () => {
  const answer = 'The custom shower door quote is high because the glass is tempered half inch low iron, the hardware is brushed nickel, and installation includes a second visit for sealing.';
  const restated = 'Short version: the quote is high because of tempered half inch low iron glass, brushed nickel hardware, and an installation with a second sealing visit.';

  it('collapses the closing message that restates the bot’s own thread reply', () => {
    const items = [
      user('u', 't1', { at: '2026-10-03T14:09:00.000Z' }),
      text('a1', 't1', restated, '2026-10-03T14:10:10.000Z'),
    ];
    expect(collapsed(markRepeatedReplies(items, [reply(answer, '2026-10-03 14:09:55')]))).toEqual({ a1: 'repeat' });
  });

  it('leaves a closing message with different content alone', () => {
    const items = [text('a1', 't1', 'I also updated the measurements file and scheduled the supplier follow-up for Monday morning.', '2026-10-03T14:10:10.000Z')];
    expect(markRepeatedReplies(items, [reply(answer, '2026-10-03 14:09:55')])).toBe(items);
  });

  it('ignores human replies, earlier messages, late messages and anything after a new human message', () => {
    const at = '2026-10-03 14:09:55';
    expect(collapsed(markRepeatedReplies([text('a', 't', restated, '2026-10-03T14:10:10.000Z')], [reply(answer, at, false)]))).toEqual({});
    expect(collapsed(markRepeatedReplies([text('a', 't', restated, '2026-10-03T14:09:00.000Z')], [reply(answer, at)]))).toEqual({});
    expect(collapsed(markRepeatedReplies([text('a', 't', restated, '2026-10-03T14:20:00.000Z')], [reply(answer, at)]))).toEqual({});
    expect(collapsed(markRepeatedReplies([
      user('u2', 't2', { at: '2026-10-03T14:10:00.000Z' }), text('a', 't2', restated, '2026-10-03T14:10:10.000Z'),
    ], [reply(answer, at)]))).toEqual({});
  });

  it('only considers the first message after the reply', () => {
    const items = [
      text('a1', 't1', 'Unrelated closing words about a different customer order entirely today.', '2026-10-03T14:10:00.000Z'),
      text('a2', 't1', restated, '2026-10-03T14:10:10.000Z'),
    ];
    expect(collapsed(markRepeatedReplies(items, [reply(answer, '2026-10-03 14:09:55')]))).toEqual({});
  });

  it('matches a message stamped in the same second as the reply', () => {
    const items = [text('a1', 't1', restated, '2026-10-03T14:09:55.300Z')];
    expect(collapsed(markRepeatedReplies(items, [reply(answer, '2026-10-03 14:09:55')]))).toEqual({ a1: 'repeat' });
  });

  it('labels a repeat as a repeat even when it also ends the turn after a note', () => {
    const items = [
      user('u', 't1', { at: '2026-10-03T14:09:00.000Z' }),
      text('a0', 't1', 'Reading the thread.', '2026-10-03T14:09:30.000Z'),
      text('a1', 't1', restated, '2026-10-03T14:10:10.000Z'),
    ];
    expect(collapsed(markProgressNotes(markRepeatedReplies(items, [reply(answer, '2026-10-03 14:09:55')]))))
      .toEqual({ a0: 'note', a1: 'repeat' });
  });

  it('does not let a hidden result-reply delivery merge two stretches', () => {
    const items = markProgressNotes([
      user('u', 't1'), text('a1', 't1'),
      user('r', 't1', { origin: { kind: 'result_reply', from: 'Nick', to: 'Bot' } }), text('a2', 't1'),
    ]);
    expect(collapsed(transcriptItemsForDisplay(items))).toEqual({});
  });

  it('scores restatements high and unrelated text low', () => {
    expect(restatementScore(answer, restated)).toBeGreaterThanOrEqual(0.5);
    expect(restatementScore(answer, 'Done.')).toBe(0);
    expect(restatementScore(answer, 'The warehouse manifest for Tuesday shipped late because the carrier missed the afternoon pickup window.')).toBeLessThan(0.5);
  });
});

describe('note preview', () => {
  it('flattens markdown to one plain line and truncates', () => {
    expect(notePreview('## Plan\n\n- **First** check the `logs`\n- then [the doc](https://x.test/a)')).toBe('Plan First check the logs then the doc');
    expect(notePreview('x'.repeat(300)).length).toBe(160);
    expect(notePreview('```\n```')).toBe('');
  });
});
