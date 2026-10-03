import { replyTime, type ThreadReply } from './threadReplies';
import type { ChatItem } from './transcript';

type AssistantItem = Extract<ChatItem, { kind: 'assistant' }>;

// Diagrams and images are content in their own right and need a mounted,
// visible row, so a message carrying one always keeps its full bubble.
const RICH_CONTENT_RE = /!\[|<img\b|^[ \t]{0,3}(?:`{3,}|~{3,})[ \t]*mermaid\b/im;

const collapsedCache = new WeakMap<AssistantItem, Partial<Record<'note' | 'repeat', AssistantItem>>>();

function collapsedItem(item: AssistantItem, collapsed: 'note' | 'repeat'): AssistantItem {
  // Stable identities keep memoized rows and frozen history from re-rendering.
  const cached = collapsedCache.get(item) ?? {};
  cached[collapsed] ??= { ...item, collapsed };
  collapsedCache.set(item, cached);
  return cached[collapsed]!;
}

function messageTime(item: AssistantItem) {
  const value = item.at ? Date.parse(item.at) : NaN;
  return Number.isFinite(value) ? value : null;
}

/** A turn's answer is its last message. Earlier text from the same turn is a
 * progress note, shown as a compact expandable row so the answer is not read
 * twice. A human message or a question card starts a new stretch: whatever the
 * bot last said before it stays a full message. Rows without a turn id (older
 * history) are never collapsed, and neither is the newest text of a turn that
 * is still running or that ended without an answer. */
export function markProgressNotes(items: ChatItem[]): ChatItem[] {
  let laterTurn: string | null = null;
  let result: ChatItem[] | null = null;
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!;
    if (item.kind === 'user' || item.kind === 'question') {
      laterTurn = null;
      continue;
    }
    if (item.kind !== 'assistant') continue;
    const turn = item.turnId || null;
    if (turn && turn === laterTurn && !item.collapsed && !RICH_CONTENT_RE.test(item.markdown)) {
      result ??= [...items];
      result[i] = collapsedItem(item, 'note');
    }
    laterTurn = turn;
  }
  return result ?? items;
}

function significantWords(text: string) {
  return new Set((text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((word) => word.length >= 4));
}

/** Share of the smaller text's distinctive words that also appear in the
 * other one. Restatements are usually shorter than the reply they repeat. */
export function restatementScore(a: string, b: string): number {
  const first = significantWords(a);
  const second = significantWords(b);
  const [small, large] = first.size <= second.size ? [first, second] : [second, first];
  if (small.size < 5) return 0;
  let shared = 0;
  for (const word of small) if (large.has(word)) shared++;
  return shared / small.size;
}

export const RESTATEMENT_WINDOW_MS = 5 * 60_000;
export const RESTATEMENT_SCORE = 0.5;

/** A bot that answered in a result thread and then restated that answer as its
 * closing message shows the same answer twice. Collapse the restatement: the
 * first bot message after the bot's own thread reply, when it follows closely,
 * no human message came between them, and it says the same thing. Run this
 * before markProgressNotes, which leaves already collapsed rows alone. */
export function markRepeatedReplies(items: ChatItem[], replies: ThreadReply[]): ChatItem[] {
  const botReplies = replies.filter((reply) => reply.actor_conversation_id);
  if (!botReplies.length) return items;
  let result: ChatItem[] | null = null;
  for (const reply of botReplies) {
    const postedAt = replyTime(reply);
    if (!Number.isFinite(postedAt)) continue;
    for (let i = 0; i < items.length; i++) {
      const item = items[i]!;
      if (item.kind !== 'assistant' && item.kind !== 'user') continue;
      const at = item.kind === 'assistant' ? messageTime(item) : item.at ? Date.parse(item.at) : NaN;
      // Replies are stored to the second; message times carry milliseconds.
      if (at === null || !Number.isFinite(at) || at < postedAt - 1000) continue;
      if (item.kind === 'user' || at > postedAt + RESTATEMENT_WINDOW_MS) break;
      if (!item.collapsed && !RICH_CONTENT_RE.test(item.markdown) && restatementScore(reply.text, item.markdown) >= RESTATEMENT_SCORE) {
        result ??= [...items];
        result[i] = collapsedItem(item, 'repeat');
      }
      break;
    }
  }
  return result ?? items;
}

/** One-line plain preview for a collapsed message row. */
export function notePreview(markdown: string, limit = 160): string {
  const text = markdown
    .replace(/^[ \t]{0,3}(?:`{3,}|~{3,}).*$/gm, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^[ \t]*(?:#{1,6}|>+|[-*+]|\d+[.)])[ \t]+/gm, '')
    .replace(/[*_`~]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text;
}
