import { describe, expect, it } from 'vitest';
import { proposalInputSchema, reviewSummarySchema } from '../src/bots/service.js';
const base = { action_title:'Send Scott a factual update',customer_request:'Customer wants the shades',background:['Vendor acceptance is unconfirmed'] };
describe('grounded decision review summary', () => {
 it('defaults through omission for legacy proposals without rewriting their question', () => {
  const raw={question:'$0 new action',recommendation:'Update',consequence:'No refund authorized',assignee_id:1,blocked_action:'Exact conditions'};
  expect(proposalInputSchema.parse(raw)).toMatchObject(raw);
  expect(proposalInputSchema.parse(raw).review_summary).toBeUndefined();
 });
 it('requires evidence type, source, as-of, scope and completed receipt for positive refunds', () => {
  expect(reviewSummarySchema.safeParse({...base,refund:{status:'full'}}).success).toBe(false);
  expect(reviewSummarySchema.safeParse({...base,refund:{status:'none'}}).success).toBe(false);
  for(const status of ['partial','full']) {
   const refund={status,source:'ledger',as_of:'2026-09-23T12:00:00Z',scope:'exact order',receipt:'completed-1',evidence_kind:'completed_refund',amount:12,currency:'USD'};
   expect(reviewSummarySchema.safeParse({...base,refund}).success).toBe(true);
   expect(reviewSummarySchema.safeParse({...base,refund:{...refund,evidence_kind:'proposed_refund'}}).success).toBe(false);
   expect(reviewSummarySchema.safeParse({...base,refund:{...refund,amount:0}}).success).toBe(false);
  }
 });
 it('requires complete checked history for NO, and permits explicit unknown', () => {
  expect(reviewSummarySchema.safeParse({...base,refund:{status:'none',source:'complete order refund ledger',as_of:'2026-09-23T12:00:00Z',scope:'exact order',evidence_kind:'complete_refund_history'}}).success).toBe(true);
  expect(reviewSummarySchema.safeParse({...base,refund:{status:'not_verified'}}).success).toBe(true);
  expect(reviewSummarySchema.safeParse({...base,background:['x'.repeat(241)],refund:{status:'not_verified'}}).success).toBe(false);
 });
});
