import { describe, expect, it } from 'vitest';
import { canUseChatComposer, canUseChatControls } from './chatAccess';

describe('chat composer access', () => {
  it('shows the composer for a new chat', () => {
    expect(canUseChatComposer(true, false)).toBe(true);
  });

  it('shows the composer when the API permits sending', () => {
    expect(canUseChatComposer(false, true)).toBe(true);
  });

  it('hides the composer when sending is not permitted', () => {
    expect(canUseChatComposer(false, false)).toBe(false);
  });
});

describe('chat control access', () => {
  it('shows agent and approval controls when the API permits management', () => {
    expect(canUseChatControls(false, true)).toBe(true);
  });

  it('hides agent and approval controls when management is not permitted', () => {
    expect(canUseChatControls(false, false)).toBe(false);
  });
});
