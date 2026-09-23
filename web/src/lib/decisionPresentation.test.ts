import { describe, expect, it } from 'vitest';
import { discussionTimestamp, decisionCopy, decisionSection, decisionStatusLabel, decisionTitle } from './decisionPresentation';
import type { BotDecision, BotProposal } from './bots';

describe('readable proposal copy', () => {
  const base = { recommendation: 'Ask the customer for photos.', consequence: '$0 message only. No replacement approved. Delivery is an estimate.', blocked_action: 'Check both parcels. EXACT DRAFT: Hi Branden, UPS has not received the second parcel. We cannot confirm a delivery date.' } as BotDecision['proposal'];
  it('separates an explicitly labeled draft without rewriting facts or conditions', () => {
    expect(decisionCopy(base)).toEqual({ proposedAction: base.recommendation, limits: base.consequence, instructions: 'Check both parcels.', draft: 'Hi Branden, UPS has not received the second parcel. We cannot confirm a delivery date.' });
    expect(base.blocked_action).toContain('EXACT DRAFT:');
  });
  it('keeps unknown or ambiguous formats whole instead of guessing a reply', () => {
    for (const blocked_action of ['Send only after approval. No refund.', 'EXACT DRAFT:', 'EXACT DRAFT: old. EXACT DRAFT: new.']) {
      expect(decisionCopy({ ...base, blocked_action })).toMatchObject({ draft: null, instructions: blocked_action });
    }
  });
});

describe('decision-specific lifecycle presentation', () => {
  it.each([
    ['needs_input', null, 'input', 'Needs your input'],
    ['decided', 'approve', 'execution', 'Approved · Awaiting execution'],
    ['action_pending', 'approve', 'execution', 'Queued for execution'],
    ['running', 'approve', 'execution', 'Executing this task'],
    ['blocked', 'approve', 'attention', 'Blocked'],
    ['failed', 'approve', 'attention', 'Failed'],
    ['verified_completed', 'approve', 'history', 'Scoped task complete'],
    ['decided', 'reject', 'history', 'Rejected · No execution authorized'],
    ['decided', 'withdraw', 'history', 'Withdrawn · No execution authorized'],
    ['decided', 'defer', 'deferred', 'Deferred · Awaiting follow-up'],
    ['blocked', 'reject', 'attention', 'Blocked'],
  ])('%s / %s belongs in %s', (state, action, section, label) => {
    const d = { state, answer: action ? { action } : null } as BotDecision;
    expect(decisionSection(d)).toBe(section);
    expect(decisionStatusLabel(d)).toBe(label);
  });
  it('moves the scoped task into history on verified completion regardless of other bot work', () => {
    const d = { state: 'running', answer: { action: 'approve' } } as BotDecision;
    expect(decisionSection(d)).toBe('execution');
    d.state = 'verified_completed';
    expect(decisionSection(d)).toBe('history');
    expect(decisionStatusLabel(d)).not.toMatch(/running|executing/i);
  });
});

describe('discussion timestamp', () => {
  it('treats SQLite UTC and ISO timestamps as the same instant and includes seconds and date', () => {
    const result = discussionTimestamp('2026-09-21 15:37:44');
    expect(result).toBe(discussionTimestamp('2026-09-21T15:37:44Z'));
    expect(result).toBe(discussionTimestamp('2026-09-21T11:37:44-04:00'));
    expect(result).toContain('2026');
    expect(result).toContain(':37:44');
    expect(discussionTimestamp('bad')).toBe('Time unavailable');
  });
});

it('only an explicit current question raises a hand; execution failures do not reinterpret the answer',()=>{
 for(const action of ['approve','reject','withdraw','defer']) {
  for(const state of ['decided','blocked','failed','action_pending','running','verified_completed'])
   expect(decisionSection({state,answer:{action}} as BotDecision)).not.toBe('input');
 }
 expect(decisionSection({state:'needs_input',answer:null} as BotDecision)).toBe('input');
});

it('uses explicit human titles or neutral legacy fallbacks without interpreting dollar amounts', () => {
 const proposal={question:'Scott — $0 new action',recommendation:'Background',blocked_action:'EXACT DRAFT: Exact body.  \n',consequence:'No new refund'} as BotProposal;
 expect(decisionTitle(proposal)).toBe('Review the proposed customer reply');
 expect(decisionCopy(proposal).draft).toBe('Exact body.  \n');
 expect(decisionTitle({...proposal,review_summary:{action_title:'Send Scott an update',customer_request:'Update requested',background:[],refund:{status:'not_verified'}}})).toBe('Send Scott an update');
});
