import { describe, expect, it } from 'vitest';
import { decisionCopy, decisionSection, decisionStatusLabel } from './decisionPresentation';
import type { BotDecision } from './bots';

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
