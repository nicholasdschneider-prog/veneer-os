import { shopifyOrderSearchUrl } from '../bots/orderReference.js';

export const MAX_TASK_ORDER_LINKS = 3;
/**
 * Order numbers a task refers to, in priority order: an order-number case key, then "order #…",
 * "#…" and "orders: a, b" mentions in the title, the OrderOps ticket's subject, and the brief.
 * Never guesses from bare numbers, so phone and tracking numbers stay out.
 */
export function orderNumbersIn(text: string): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(/\b(?:shopify\s+)?orders?\s*(?:number|no\.?)?\s*[:#]?\s*((?:#?\d{6,12}(?:\s*(?:,|and|&)\s*)?)+)/gi))
    for (const n of m[1]!.matchAll(/\d{6,12}/g)) found.push(n[0]);
  for (const m of text.matchAll(/(?:^|[\s(])#(\d{6,12})\b/g)) found.push(m[1]!);
  return [...new Set(found)];
}
export function taskOrderNumbers(t: { case_key: string | null; title: string; brief: string }, ticketSubject?: string | null): string[] {
  const all = [...(t.case_key && /^\d{6,12}$/.test(t.case_key.trim()) ? [t.case_key.trim()] : []), ...orderNumbersIn(t.title), ...orderNumbersIn(ticketSubject ?? ''), ...orderNumbersIn(t.brief)];
  return [...new Set(all)].slice(0, MAX_TASK_ORDER_LINKS);
}
export function taskOrderLinks(numbers: string[], store: string | null | undefined): { number: string; url: string }[] {
  return numbers.flatMap((number) => { const url = shopifyOrderSearchUrl(store, number); return url ? [{ number, url }] : []; });
}
