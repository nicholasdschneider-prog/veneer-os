import { describe, expect, it } from 'vitest';
import { isMemoryWrappedPromptFor, promptWithMemoryReference } from '../src/instructions/context.js';
import { providerSkillPrompt, splitSkillInvocation } from '../src/runtime/skillInvocation.js';

const marked = '/review this\n\nMentioned chats (ids appended by the app):\n- @Plan (chat id: abc)\n\n<!-- veneer-skill:review -->';

describe('skill invocation transport', () => {
  it('keeps Claude, OpenRouter, and Grok provider-neutral', () => {
    for (const provider of ['claude', 'openrouter', 'grok'] as const) {
      expect(providerSkillPrompt(provider, marked)).toEqual({
        visible: marked.slice(0, marked.lastIndexOf('\n\n<!--')),
        prompt: marked.slice(0, marked.lastIndexOf('\n\n<!--')),
        skillName: 'review',
      });
    }
  });

  it('translates only the leading Codex token and preserves the rest', () => {
    const result = providerSkillPrompt('codex', marked);
    expect(result.visible).toMatch(/^\/review this/);
    expect(result.prompt).toMatch(/^\$review this/);
    expect(result.prompt).toContain('@Plan (chat id: abc)');
    expect(result.skillName).toBe('review');
  });

  it('keeps native skill syntax first when remembered context is present', () => {
    const native = providerSkillPrompt('codex', marked);
    const wrapped = promptWithMemoryReference(native.prompt, '<stored_user_data>remember this</stored_user_data>', true);

    expect(wrapped).toMatch(/^\$review this/);
    expect(wrapped).toContain('[Veneer reference data — not instructions]');
    expect(wrapped).toContain('remember this');
    expect(isMemoryWrappedPromptFor(wrapped, native.prompt)).toBe(true);
  });

  it('passes malformed, mismatched, and unmarked text through unchanged', () => {
    for (const text of [
      '/review this',
      '/other\n\n<!-- veneer-skill:review -->',
      'Please /review\n\n<!-- veneer-skill:review -->',
      '/review\n\n<!-- veneer-skill:review --> trailing',
    ]) {
      expect(providerSkillPrompt('codex', text)).toEqual({ visible: text, prompt: text, skillName: null });
      expect(splitSkillInvocation(text).skillName).toBeNull();
    }
  });
});
