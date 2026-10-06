import type Database from 'better-sqlite3';
import type { ConversationEvent } from '../runtime/events.js';

export type MessageAnchor = { turn: string; at: string };
type TextFinal = Extract<ConversationEvent, { type: 'text_final' }>;
type LiveRow = { markdown: string; canonical_anchor: string | null };

/** The same reply is written to the transcript within moments of being streamed. */
const SETTLE_WINDOW_MS = 10 * 60 * 1000;
const RETAIN_DAYS = 14;

export const anchorJson = (anchor: MessageAnchor) => JSON.stringify({ turn: anchor.turn, at: anchor.at });
const squash = (text: string) => text.replace(/\s+/g, ' ').trim();

/** Called by the runtime for every reply it streams. */
export function recordLiveMessage(db: Database.Database, conversationId: string, event: TextFinal) {
  if (!event.turnId || !event.at || !event.markdown) return;
  db.prepare('INSERT OR REPLACE INTO live_message_anchors(conversation_id,turn_id,at,markdown) VALUES(?,?,?,?)')
    .run(conversationId, event.turnId, event.at, event.markdown);
}

export function pruneLiveMessages(db: Database.Database) {
  db.prepare(`DELETE FROM live_message_anchors WHERE created_at < datetime('now', ?)`).run(`-${RETAIN_DAYS} days`);
}

/**
 * Find the real message an anchor names. `event` is the transcript's own copy, whose turn id and
 * time are the durable anchor. `markdown` alone means the reply was streamed by this server but its
 * transcript copy could not be identified; it is still the text the server itself delivered.
 */
export function resolveMessage(db: Database.Database, events: ConversationEvent[], conversationId: string, anchor: MessageAnchor):
  { event: TextFinal; markdown: string } | { event: null; markdown: string } | null {
  const finals = events.filter((e): e is TextFinal => e.type === 'text_final');
  const exact = (a: MessageAnchor) => finals.find(e => e.turnId === a.turn && e.at === a.at);
  const direct = exact(anchor);
  if (direct) return { event: direct, markdown: direct.markdown };
  const row = db.prepare('SELECT markdown,canonical_anchor FROM live_message_anchors WHERE conversation_id=? AND turn_id=? AND at=?')
    .get(conversationId, anchor.turn, anchor.at) as LiveRow | undefined;
  if (!row) return null;
  if (row.canonical_anchor) {
    const known = exact(JSON.parse(row.canonical_anchor) as MessageAnchor);
    if (known) return { event: known, markdown: known.markdown };
  }
  // The transcript may merge several streamed parts into one message, so the streamed text is
  // contained in its transcript copy rather than always equal to it.
  const streamed = squash(row.markdown), at = Date.parse(anchor.at);
  let best: TextFinal | null = null, bestGap = Infinity;
  for (const e of finals) {
    const gap = Math.abs(Date.parse(e.at) - at);
    if (!(gap <= SETTLE_WINDOW_MS) || gap >= bestGap || !squash(e.markdown).includes(streamed)) continue;
    best = e; bestGap = gap;
  }
  if (!best) return { event: null, markdown: row.markdown };
  db.prepare('UPDATE live_message_anchors SET canonical_anchor=? WHERE conversation_id=? AND turn_id=? AND at=?')
    .run(anchorJson({ turn: best.turnId, at: best.at }), conversationId, anchor.turn, anchor.at);
  return { event: best, markdown: best.markdown };
}

/** Streamed anchors already matched to a transcript anchor, so a page still holding them can find its threads. */
export function liveAnchorAliases(db: Database.Database, conversationId: string): Record<string, string> {
  const rows = db.prepare('SELECT turn_id,at,canonical_anchor FROM live_message_anchors WHERE conversation_id=? AND canonical_anchor IS NOT NULL')
    .all(conversationId) as { turn_id: string; at: string; canonical_anchor: string }[];
  return Object.fromEntries(rows.map(r => [anchorJson({ turn: r.turn_id, at: r.at }), r.canonical_anchor]));
}
