import { z } from 'zod';

export function isShopifyOrderUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && !u.username && !u.password && !u.port && !u.search && !u.hash &&
      ((u.hostname === 'admin.shopify.com' && /^\/store\/[a-z0-9-]+\/orders\/\d+\/?$/.test(u.pathname)) ||
       (/^[a-z0-9-]+\.myshopify\.com$/.test(u.hostname) && /^\/admin\/orders\/\d+\/?$/.test(u.pathname)));
  } catch { return false; }
}
export const shopifyOrderSchema = z.object({
  number: z.string().trim().min(1).max(100),
  url: z.string().url().refine(isShopifyOrderUrl, 'Use a direct HTTPS Shopify admin order URL'),
}).strict();

/** Legacy cards: use explicit order labels only, never case codes or arbitrary numbers. */
export function orderReference(proposal: { shopify_order?: z.infer<typeof shopifyOrderSchema> | null }, texts: string[], store?: string | null) {
  if (proposal.shopify_order && shopifyOrderSchema.safeParse(proposal.shopify_order).success)
    return { ...proposal.shopify_order, direct: true };
  const text = texts.join('\n');
  const numbers = [...new Set([...text.matchAll(/\b(?:Shopify\s+)?order\s*(?:number\s*|no\.?\s*)?#\s*([A-Za-z0-9-]+)/gi)].map(m => m[1]!))];
  const urls = [...new Set((text.match(/https:\/\/[^\s<>"\])]+/g) ?? []).filter(isShopifyOrderUrl))];
  const ids = [...new Set([...text.matchAll(/\bShopify\s+order\s+ID\s*[:#]?\s*(\d+)/gi)].map(m => m[1]!))];
  // Ambiguous multi-order proposals need explicit metadata from the owning bot.
  if (numbers.length !== 1 || urls.length > 1 || ids.length > 1) return null;
  if (urls[0]) return { number: numbers[0]!, url: urls[0], direct: true };
  if (!store || !/^[a-z0-9-]+$/.test(store)) return { number: numbers[0]!, url: null, direct: false };
  const base = `https://admin.shopify.com/store/${store}/orders`;
  return { number: numbers[0]!, url: ids[0] ? `${base}/${ids[0]}` : `${base}?query=${encodeURIComponent('#' + numbers[0])}`, direct: Boolean(ids[0]) };
}
