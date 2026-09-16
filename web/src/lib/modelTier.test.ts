import { describe, expect, it } from 'vitest';
import { modelTier } from './modelTier';

describe('modelTier', () => {
  it('ranks the Claude families', () => {
    expect(modelTier('claude', 'claude-fable-5')).toBe(4);
    expect(modelTier('claude', 'claude-opus-5')).toBe(3);
    expect(modelTier('claude', 'claude-opus-4-8')).toBe(3);
    expect(modelTier('claude', 'claude-sonnet-5')).toBe(2);
    expect(modelTier('claude', 'claude-haiku-4-5-20251001')).toBe(1);
    expect(modelTier('claude', 'opus')).toBe(3);
  });

  it('ranks Codex, Grok, and OpenRouter models', () => {
    expect(modelTier('codex', 'gpt-5.6-sol')).toBe(3);
    expect(modelTier('codex', 'gpt-daybreak-blue-latest')).toBe(3);
    expect(modelTier('codex', 'gpt-5.6-luna')).toBe(2);
    expect(modelTier('codex', 'gpt-5-mini')).toBe(1);
    expect(modelTier('grok', 'grok-4.5')).toBe(3);
    expect(modelTier('openrouter', 'z-ai/glm-5.2')).toBe(3);
  });

  it('returns null for unknown or non-chat models so no dots render', () => {
    expect(modelTier('claude', '')).toBeNull();
    expect(modelTier('openrouter', 'someone/new-model')).toBeNull();
    expect(modelTier('grok', 'grok-imagine')).toBeNull();
  });
});
