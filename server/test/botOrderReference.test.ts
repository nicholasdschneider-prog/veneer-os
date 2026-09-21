import { describe, expect, it } from 'vitest';
import { isShopifyOrderUrl, orderReference, shopifyOrderSchema } from '../src/bots/orderReference.js';

describe('Shopify decision references', () => {
  it('uses explicit structured order references and validates destinations', () => {
    const order = { number: '#100121631', url: 'https://admin.shopify.com/store/example/orders/6123856527512' };
    expect(orderReference({ shopify_order: order }, [], null)).toEqual({ ...order, direct: true });
    expect(shopifyOrderSchema.safeParse({ ...order, url: 'https://evil.test/orders/1' }).success).toBe(false);
    for (const url of ['javascript:alert(1)', 'https://admin.shopify.com.evil.test/store/test/orders/1', 'https://name:password@admin.shopify.com/store/test/orders/1', 'https://admin.shopify.com/store/test/orders/1?redirect=evil']) expect(isShopifyOrderUrl(url)).toBe(false);
  });
  it('uses verified store configuration and explicit legacy numbers, not case IDs', () => {
    expect(orderReference({}, ['9BXZQS · David needs assistance'], 'example')).toBeNull();
    expect(orderReference({}, ['Shopify order #100121631, Shopify order ID 6123856527512.'], 'example')).toEqual({ number: '100121631', url: 'https://admin.shopify.com/store/example/orders/6123856527512', direct: true });
    expect(orderReference({}, ['Order #100121713'], 'example')).toEqual({ number: '100121713', url: 'https://admin.shopify.com/store/example/orders?query=%23100121713', direct: false });
    expect(orderReference({}, ['Order #100121713'], null)).toEqual({ number: '100121713', url: null, direct: false });
    expect(orderReference({}, ['Order #1 and order #2'], 'example')).toBeNull();
  });
});
