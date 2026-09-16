import { describe, expect, it } from 'vitest';
import { resolveEffectiveApprovalMode } from '../src/approvalMode.js';

describe('resolveEffectiveApprovalMode', () => {
  it('makes Full Access stronger than agent and chat Ask modes', () => {
    expect(resolveEffectiveApprovalMode(true, 'ask', 'ask')).toBe('auto');
  });

  it('preserves normal precedence when Full Access is off', () => {
    expect(resolveEffectiveApprovalMode(false, 'ask', 'auto')).toBe('ask');
    expect(resolveEffectiveApprovalMode(false, null, 'auto')).toBe('auto');
    expect(resolveEffectiveApprovalMode(false, null, null)).toBe('ask');
  });
});
