import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { liveAnchorAliases, pruneLiveMessages, recordLiveMessage, resolveMessage } from '../src/bots/messageAnchors.js';
import type { ConversationEvent } from '../src/runtime/events.js';

let db: Database.Database;
const final = (turnId: string, at: string, markdown: string): Extract<ConversationEvent, { type: 'text_final' }> => ({ type: 'text_final', turnId, at, markdown });
beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`CREATE TABLE live_message_anchors (conversation_id TEXT NOT NULL, turn_id TEXT NOT NULL, at TEXT NOT NULL, markdown TEXT NOT NULL,
    canonical_anchor TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (conversation_id, turn_id, at))`);
});

describe('message anchors', () => {
  it('prefers the transcript anchor and never resolves an anchor nothing was streamed under', () => {
    const events = [final('t1', '2026-10-06T20:10:00.000Z', 'Done.')];
    expect(resolveMessage(db, events, 'c', { turn: 't1', at: '2026-10-06T20:10:00.000Z' })?.event).toBe(events[0]);
    expect(resolveMessage(db, events, 'c', { turn: 'live', at: '2026-10-06T20:10:01.000Z' })).toBeNull();
  });

  it('maps a streamed reply to its transcript copy, choosing the closest of identical replies', () => {
    const events = [
      final('t1', '2026-10-06T20:00:00.000Z', 'Done.'),
      final('t2', '2026-10-06T20:10:00.000Z', 'Done.'),
      final('t3', '2026-10-06T20:20:00.000Z', 'Done.'),
    ];
    recordLiveMessage(db, 'c', final('live-2', '2026-10-06T20:10:01.200Z', 'Done.'));
    const found = resolveMessage(db, events, 'c', { turn: 'live-2', at: '2026-10-06T20:10:01.200Z' });
    expect(found?.event).toBe(events[1]);
    expect(liveAnchorAliases(db, 'c')).toEqual({
      '{"turn":"live-2","at":"2026-10-06T20:10:01.200Z"}': '{"turn":"t2","at":"2026-10-06T20:10:00.000Z"}',
    });
    // The remembered mapping holds even when the text no longer distinguishes it.
    expect(resolveMessage(db, [events[1]!], 'c', { turn: 'live-2', at: '2026-10-06T20:10:01.200Z' })?.event).toBe(events[1]);
    expect(liveAnchorAliases(db, 'other')).toEqual({});
  });

  it('matches a streamed part inside the merged transcript message', () => {
    const events = [final('t4', '2026-10-06T20:10:05.000Z', 'First part.\n\nSecond part.')];
    recordLiveMessage(db, 'c', final('live', '2026-10-06T20:10:04.000Z', 'Second  part.'));
    expect(resolveMessage(db, events, 'c', { turn: 'live', at: '2026-10-06T20:10:04.000Z' })?.event).toBe(events[0]);
  });

  it('returns the streamed text itself when no transcript copy is nearby, and prunes old records', () => {
    const events = [final('t9', '2026-10-06T23:00:00.000Z', 'Later reply.'), final('t1', '2026-10-06T20:10:00.000Z', 'Different text.')];
    recordLiveMessage(db, 'c', final('live', '2026-10-06T20:10:01.000Z', 'Later reply.'));
    expect(resolveMessage(db, events, 'c', { turn: 'live', at: '2026-10-06T20:10:01.000Z' })).toEqual({ event: null, markdown: 'Later reply.' });
    expect(liveAnchorAliases(db, 'c')).toEqual({});
    db.prepare(`UPDATE live_message_anchors SET created_at=datetime('now','-15 days')`).run();
    pruneLiveMessages(db);
    expect(resolveMessage(db, events, 'c', { turn: 'live', at: '2026-10-06T20:10:01.000Z' })).toBeNull();
  });
});
