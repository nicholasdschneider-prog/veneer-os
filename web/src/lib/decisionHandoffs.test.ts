import {describe,it,expect} from 'vitest';
import {threadMentionQuery,threadToken,retainsThreadMention} from './decisionHandoffs';
describe('explicit thread selection',()=>{
 const target={id:'opaque-id',project:'Parts',title:'Purchasing'};
 it('queries only the active mention, not email or an earlier line',()=>{
  expect(threadMentionQuery('mail@example.test',17)).toBeNull();
  expect(threadMentionQuery('@old\nnormal',11)).toBeNull();
  expect(threadMentionQuery('Please @Purch',13)).toMatchObject({query:'Purch',start:7});
 });
 it('keeps the selected ID separate from labels and clears altered tokens',()=>{
  expect(retainsThreadMention(threadToken(target)+' investigate',target)).toBe(true);
  expect(retainsThreadMention('@Parts / PurchasingElse',target)).toBe(false);
  expect(retainsThreadMention('x@Parts / Purchasing',target)).toBe(false);
  expect(retainsThreadMention('no mention',target)).toBe(false);
 });
});
