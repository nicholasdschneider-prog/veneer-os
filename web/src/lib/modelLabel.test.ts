import { describe, expect, it } from 'vitest';
import { contextWindowFor, modelLabel } from './modelLabel';

describe('Daybreak Blue model presentation', () => {
  it('uses the product name instead of the raw model id', () => {
    expect(modelLabel('gpt-daybreak-blue-latest')).toBe('Daybreak Blue');
  });

  it('uses the model\'s 1.05M context window', () => {
    expect(contextWindowFor('codex', 'gpt-daybreak-blue-latest')).toBe(1_050_000);
  });
});

describe('Claude Fable 5.2 model presentation', () => {
  it('labels the model and uses its 1M context window', () => {
    expect(modelLabel('claude-fable-5-2')).toBe('Fable 5.2');
    expect(contextWindowFor('claude', 'claude-fable-5-2')).toBe(1_000_000);
  });
});
