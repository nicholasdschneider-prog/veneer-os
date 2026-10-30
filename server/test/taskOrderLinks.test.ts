import { describe, expect, it } from 'vitest';
import { orderNumbersIn, taskOrderLinks, taskOrderNumbers } from '../src/tasks/orderLinks.js';
import { orderReference } from '../src/bots/orderReference.js';

describe('Shopify order links on tasks', () => {
  it('finds the orders a task names, never phone or tracking numbers', () => {
    expect(orderNumbersIn('Jim #100121742 · Create one no-cost replacement spring order?')).toEqual(['100121742']);
    expect(orderNumbersIn('Ticket codes: none found; orders: 100119466, 100119907, 100119971.')).toEqual(['100119466', '100119907', '100119971']);
    expect(orderNumbersIn('Approve the refund for order #100120666')).toEqual(['100120666']);
    expect(orderNumbersIn('Call 5743708714; FedEx 383912234706 delivered')).toEqual([]);
  });
  it('takes the case key first, then title, ticket subject and brief, at most three, without repeats', () => {
    expect(taskOrderNumbers({ case_key: '100122604', title: 'Shower door for #100122604', brief: 'orders: 100121511, 100121512, 100121513' }, null)).toEqual(['100122604', '100121511', '100121512']);
    expect(taskOrderNumbers({ case_key: 'DSAYCL', title: "Gary's Oct 30 customer update", brief: '' }, 'A shipment from order #100122104 is on the way')).toEqual(['100122104']);
    expect(taskOrderNumbers({ case_key: 'VLDD79', title: 'Follow-up check', brief: '' }, 'Where is my stuff')).toEqual([]);
  });
  it('builds the same Shopify link question cards use, and none without a store', () => {
    const card = orderReference({}, ['Refund order #100121742?'], 'elkhart-rv-parts');
    expect(taskOrderLinks(['100121742'], 'elkhart-rv-parts')).toEqual([{ number: '100121742', url: card!.url }]);
    expect(card!.url).toBe('https://admin.shopify.com/store/elkhart-rv-parts/orders?query=%23100121742');
    expect(taskOrderLinks(['100121742'], null)).toEqual([]);
  });
});
