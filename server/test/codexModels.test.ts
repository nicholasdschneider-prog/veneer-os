import { describe, expect, it } from 'vitest';
import { toModelOptions } from '../src/providers/codex/models.js';

// Shape re-verified live against Codex CLI 0.153.4 `model/list` (2026-09-04),
// including GPT-6 Astra with the same per-model effort vocabulary.
const RAW_56_SOL = {
  id: 'gpt-5.6-sol',
  model: 'gpt-5.6-sol',
  displayName: 'GPT-5.6-Sol',
  hidden: false,
  supportedReasoningEfforts: [
    { reasoningEffort: 'low', description: 'Fast' },
    { reasoningEffort: 'medium', description: 'Balanced' },
    { reasoningEffort: 'high', description: 'Deeper' },
    { reasoningEffort: 'xhigh', description: 'Extra' },
    { reasoningEffort: 'max', description: 'Maximum' },
    { reasoningEffort: 'ultra', description: 'Ultra' },
  ],
  defaultReasoningEffort: 'low',
  isDefault: true,
};

describe('toModelOptions', () => {
  it('maps GPT-5.6 per-model effort metadata onto the option', () => {
    const [sol] = toModelOptions({ data: [RAW_56_SOL] });
    expect(sol).toEqual({
      id: 'gpt-5.6-sol',
      label: 'GPT-5.6-Sol',
      efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
      defaultEffort: 'low',
      isDefault: true,
    });
  });

  it('omits effort metadata a model does not report (pre-5.6 CLIs)', () => {
    const [m] = toModelOptions({ data: [{ id: 'gpt-5.5', displayName: 'GPT-5.5', isDefault: false }] });
    expect(m).toEqual({ id: 'gpt-5.5', label: 'GPT-5.5' });
    expect(m).not.toHaveProperty('efforts');
    expect(m).not.toHaveProperty('isDefault');
  });

  it('drops hidden and id-less entries and tolerates a malformed result', () => {
    const options = toModelOptions({
      data: [{ id: 'gpt-5.6-sol', hidden: true }, { displayName: 'no id' }, { model: 'gpt-5.6-luna' }],
    });
    expect(options).toEqual([{ id: 'gpt-5.6-luna', label: 'gpt-5.6-luna' }]);
    expect(toModelOptions(undefined)).toEqual([]);
    expect(toModelOptions({})).toEqual([]);
  });
});
