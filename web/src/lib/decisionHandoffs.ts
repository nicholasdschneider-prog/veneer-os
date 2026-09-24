import { requestJson } from './api';
export interface ThreadTarget { id: string; title: string; project: string }
export interface DecisionHandoff {
  id: string; target_id: string | null; target_label: string; version: number;
  delivery_status: 'pending' | 'delivered' | 'cancelled'; completed_at: string | null;
}
export const decisionHandoffsApi = {
  targets: (id: string, q: string) => requestJson<{ targets: ThreadTarget[] }>(`/api/bots/decisions/${encodeURIComponent(id)}/handoff-targets?q=${encodeURIComponent(q)}`),
  list: (id: string) => requestJson<{ handoffs: DecisionHandoff[] }>(`/api/bots/decisions/${encodeURIComponent(id)}/handoffs`),
};
/** Match only the current @ query, never an email address or earlier line. */
export function threadMentionQuery(text: string, caret: number) {
  const before = text.slice(0, caret);
  const match = /(?:^|\s)@([^@\n]{0,200})$/.exec(before);
  return match ? { start: caret - match[1]!.length - 1, end: caret, query: match[1]! } : null;
}
export function threadToken(target: ThreadTarget) {
  return `@${target.project} / ${target.title}`;
}
export function retainsThreadMention(text: string, target: ThreadTarget) {
  const token = threadToken(target);
  let from = 0;
  while (from < text.length) {
    const at = text.indexOf(token, from);
    if (at < 0) return false;
    const next = text[at + token.length];
    if ((at === 0 || /\s/.test(text[at - 1]!)) && (next === undefined || !/[\p{L}\p{N}]/u.test(next))) return true;
    from = at + 1;
  }
  return false;
}
