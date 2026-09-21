import { describe, expect, it } from 'vitest';
import { proposalSchema } from '../src/bots/service.js';
const proposal = { question: 'Refund?', recommendation: 'Review the request.', consequence: 'No refund yet.', assignee_id: 1, blocked_action: 'Refund only if approved.' };
const entry = { when: null, actor: 'Customer', kind: 'request', summary: 'Requested a refund.', source: 'Ticket 123' };
describe('case timeline proposal data', () => {
  it('keeps legacy proposals valid and retains supported history verbatim', () => {
    expect(proposalSchema.parse(proposal).case_timeline).toBeUndefined();
    expect(proposalSchema.parse({ ...proposal, case_timeline: [entry] }).case_timeline).toEqual([entry]);
  });
  it('requires traceable evidence and bounds highlights', () => {
    expect(proposalSchema.safeParse({ ...proposal, case_timeline: [{ ...entry, source: '' }] }).success).toBe(false);
    expect(proposalSchema.safeParse({ ...proposal, case_timeline: Array(13).fill(entry) }).success).toBe(false);
    expect(proposalSchema.safeParse({ ...proposal, case_timeline: [{ ...entry, kind: 'approved' }] }).success).toBe(false);
  });
});
