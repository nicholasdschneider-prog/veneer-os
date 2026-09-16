import { connectorSlugForMention } from './connectorTools';

/** A run of plain text, one connector @mention, or one chat @mention. */
export type MentionSegment =
  | { kind: 'text'; text: string }
  | { kind: 'mention'; text: string; mention: string; slug: string }
  | { kind: 'chat'; text: string; id: string };

/**
 * Split text into plain runs and connector @mention tokens (`@gmail`,
 * `@gmail-work`, `@gmail-team-2`). A token only counts at the start of the
 * text or after whitespace, so email addresses (user@gmail.com) stay plain.
 *
 * With `allowed` (lowercase mention tokens, e.g. the connected installs
 * visible in the composer), only exact members match. Without it, any token
 * that resolves to a catalog slug matches — usable in frozen transcript rows
 * where no live connector state is available.
 *
 * `chatTokens` maps literal chat-mention tokens (`@Some chat title`) to
 * conversation ids. Titles contain spaces, so they match as exact literals
 * (longest first) rather than by token pattern; matches become `chat`
 * segments carrying the id.
 */
export function segmentMentions(
  text: string,
  allowed?: ReadonlySet<string>,
  chatTokens?: ReadonlyMap<string, string>,
): MentionSegment[] {
  const segments: MentionSegment[] = [];
  for (const run of splitChatTokens(text, chatTokens)) {
    if (run.kind === 'chat') {
      segments.push(run);
      continue;
    }
    segments.push(...segmentConnectorMentions(run.text, allowed));
  }
  return segments;
}

function segmentConnectorMentions(text: string, allowed?: ReadonlySet<string>): MentionSegment[] {
  const segments: MentionSegment[] = [];
  let cursor = 0;
  for (const match of text.matchAll(/@([A-Za-z0-9][A-Za-z0-9_-]*)/g)) {
    const start = match.index;
    if (start > 0 && !/\s/.test(text[start - 1]!)) continue;
    const mention = match[1]!.toLowerCase();
    if (allowed ? !allowed.has(mention) : connectorSlugForMention(mention) === undefined) continue;
    if (start > cursor) segments.push({ kind: 'text', text: text.slice(cursor, start) });
    segments.push({
      kind: 'mention',
      text: match[0],
      mention,
      // Unknown-catalog installs still highlight when explicitly allowed;
      // ConnectorGlyph shows its generic plug for the unmatched slug.
      slug: connectorSlugForMention(mention) ?? mention,
    });
    cursor = start + match[0].length;
  }
  if (cursor < text.length) segments.push({ kind: 'text', text: text.slice(cursor) });
  return segments;
}

/** Cut the text at literal chat-token occurrences (word-boundary guarded,
 *  longest token wins on overlap), leaving connector parsing to the gaps. */
function splitChatTokens(
  text: string,
  chatTokens?: ReadonlyMap<string, string>,
): Array<{ kind: 'gap'; text: string } | { kind: 'chat'; text: string; id: string }> {
  if (!chatTokens?.size) return [{ kind: 'gap', text }];
  const hits: Array<{ start: number; end: number; token: string; id: string }> = [];
  const tokens = [...chatTokens.keys()].sort((a, b) => b.length - a.length);
  for (const token of tokens) {
    const id = chatTokens.get(token)!;
    for (let from = 0; ; ) {
      const start = text.indexOf(token, from);
      if (start < 0) break;
      from = start + 1;
      if (start > 0 && !/\s/.test(text[start - 1]!)) continue;
      const after = text[start + token.length];
      // The token must end at a word edge so "@Foo" doesn't hit inside "@Foobar"
      // when both were mentioned (longest-first still needs this for gaps).
      if (after !== undefined && /[\p{L}\p{N}]/u.test(after)) continue;
      hits.push({ start, end: start + token.length, token, id });
    }
  }
  hits.sort((a, b) => a.start - b.start || b.end - a.end);
  const runs: Array<{ kind: 'gap'; text: string } | { kind: 'chat'; text: string; id: string }> = [];
  let cursor = 0;
  for (const hit of hits) {
    if (hit.start < cursor) continue; // overlapped by an earlier (longer) hit
    if (hit.start > cursor) runs.push({ kind: 'gap', text: text.slice(cursor, hit.start) });
    runs.push({ kind: 'chat', text: hit.token, id: hit.id });
    cursor = hit.end;
  }
  if (cursor < text.length) runs.push({ kind: 'gap', text: text.slice(cursor) });
  return runs;
}

/**
 * Chat-mention footer: the composer shows only `@<Title>`, and the ids the
 * agent needs ride along in a machine-readable footer appended at send time.
 * The transcript strips it for display and uses it to link the chips.
 * The `(chat id: …)` phrasing is what agent guidance already documents.
 */
const CHAT_FOOTER_HEADER = 'Mentioned chats (ids appended by the app):';
const CHAT_FOOTER_LINE = /^- (@.+) \(chat id: ([A-Za-z0-9-]+)\)$/;

/** Tokens from `map` that appear verbatim (boundary-guarded) in `text`. */
export function chatMentionsInText(
  text: string,
  map: ReadonlyMap<string, string>,
): Array<{ token: string; id: string }> {
  const seen = new Map<string, string>();
  for (const seg of splitChatTokens(text, map)) {
    if (seg.kind === 'chat') seen.set(seg.text, seg.id);
  }
  return [...seen].map(([token, id]) => ({ token, id }));
}

export function appendChatMentionFooter(
  text: string,
  mentions: Array<{ token: string; id: string }>,
): string {
  if (mentions.length === 0) return text;
  const lines = mentions.map((m) => `- ${m.token} (chat id: ${m.id})`);
  return `${text}\n\n${CHAT_FOOTER_HEADER}\n${lines.join('\n')}`;
}

/** Split a stored message back into the visible prompt and the token → id map.
 *  Only a fully well-formed footer at the very end is recognized; anything
 *  else returns the text untouched. */
export function splitChatMentionFooter(text: string): {
  visible: string;
  chatTokens: Map<string, string>;
} {
  const none = { visible: text, chatTokens: new Map<string, string>() };
  const marker = `\n\n${CHAT_FOOTER_HEADER}\n`;
  const at = text.lastIndexOf(marker);
  if (at < 0) return none;
  const lines = text.slice(at + marker.length).split('\n');
  if (lines.length === 0) return none;
  const chatTokens = new Map<string, string>();
  for (const line of lines) {
    const parsed = CHAT_FOOTER_LINE.exec(line);
    if (!parsed) return none;
    chatTokens.set(parsed[1]!, parsed[2]!);
  }
  return { visible: text.slice(0, at), chatTokens };
}
