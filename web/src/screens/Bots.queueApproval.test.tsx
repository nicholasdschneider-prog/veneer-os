import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DecisionCard, canApproveFromQueue } from './Bots';
import type { BotDecision } from '@/lib/bots';

const base = {
  id: 'd1', version: 3, state: 'needs_input', conversation_id: 'c1', bot_name: 'Avery', assignee_name: 'Nick',
  created_at: '2026-09-20T12:00:00Z', updated_at: '2026-09-20T12:00:00Z', answer: null, result: null, parked: null, dismissed: false,
  proposal: { question: 'Send the tracking follow-up?', recommendation: 'Send it.', consequence: 'No refund.', blocked_action: 'Send. EXACT DRAFT: Hi Larry, tracking attached.', blocks_scope: 'task' },
} as unknown as BotDecision;

describe('one-click approval from the queue', () => {
  it('is offered to the current answerer or to a teammate who can claim a shared question', () => {
    expect(canApproveFromQueue({ ...base, can_answer: true })).toBe(true);
    expect(canApproveFromQueue({ ...base, can_answer: false, shared_queue: true, handler_id: null, can_handle: true })).toBe(true);
    expect(canApproveFromQueue({ ...base, can_answer: false, shared_queue: true, handler_id: 7, can_handle: false })).toBe(false);
    expect(canApproveFromQueue({ ...base, can_answer: true, state: 'decided' })).toBe(false);
  });
  it('renders Approve & send next to Review & decide when a draft reply exists', () => {
    const html = renderToStaticMarkup(<DecisionCard d={{ ...base, can_answer: true }} onOpen={() => {}} onApprove={() => {}} />);
    expect(html).toContain('Approve &amp; send reply');
    expect(html).toContain('Review &amp; decide');
    const noDraft = renderToStaticMarkup(<DecisionCard d={{ ...base, can_answer: true, proposal: { ...base.proposal, blocked_action: 'Just do it.' } }} onOpen={() => {}} onApprove={() => {}} />);
    expect(noDraft).toContain('Approve as proposed');
    expect(html).not.toContain('Tap again');
    const cannot = renderToStaticMarkup(<DecisionCard d={{ ...base, can_answer: false }} onOpen={() => {}} onApprove={() => {}} />);
    expect(cannot).not.toContain('Approve');
  });
});
