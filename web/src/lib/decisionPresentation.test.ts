import { describe, expect, it } from 'vitest';
import { decisionSection, decisionStatusLabel } from './decisionPresentation';
import type { BotDecision } from './bots';

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
