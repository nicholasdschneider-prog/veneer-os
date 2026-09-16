import { describe, expect, it } from 'vitest';
import { resolveEffectiveApprovalMode } from './approvalMode';

describe('resolveEffectiveApprovalMode', () => {
  it('shows autonomous when Full Access overrides stored Ask modes', () => {
    expect(resolveEffectiveApprovalMode(true, 'ask', 'ask')).toBe('auto');
  });

  it('preserves chat overrides and agent defaults when Full Access is off', () => {
    expect(resolveEffectiveApprovalMode(false, 'ask', 'auto')).toBe('ask');
    expect(resolveEffectiveApprovalMode(false, null, 'auto')).toBe('auto');
  });
});
