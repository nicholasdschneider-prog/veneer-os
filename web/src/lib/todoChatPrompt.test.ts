import { describe, expect, it } from 'vitest';

import { newChatSubmissionPrompt, todoNewChatHash, todoPlanningPrompt } from './todoChatPrompt';

describe('to-do chat planning prompt', () => {
  it('keeps the edited request intact and first so chat titles remain meaningful', () => {
    const request = 'Replace the billing chart.\n\nUse the linked design:\nhttps://example.com/mockup';
    const prompt = todoPlanningPrompt(request);

    expect(prompt.startsWith(`${request}\n\n---\n\n`)).toBe(true);
    expect(prompt).toContain('This chat was started from a to-do.');
  });

  it('limits the first turn to understanding, inspection, and clarification', () => {
    const prompt = todoPlanningPrompt('Update the dashboard');

    expect(prompt).toContain('This first turn is planning-only.');
    expect(prompt).toContain('Do not edit, create, move, or delete files.');
    expect(prompt).toContain('Do not enqueue a build or run builds, tests');
    expect(prompt).toContain('Summarize your understanding');
    expect(prompt).toContain('Ask any necessary clarifying questions.');
    expect(prompt).toContain('until the user responds in a later turn');
  });

  it('leaves ordinary new-chat submissions unchanged', () => {
    const request = 'Please implement the approved design.';

    expect(newChatSubmissionPrompt(request, null)).toBe(request);
    expect(newChatSubmissionPrompt(request, 'todo-123')).toBe(todoPlanningPrompt(request));
  });

  it('uses the saved planning prompt for a new chat fired off from a to-do', () => {
    const request = 'Update the dashboard';
    const planningPrompt = 'First inspect the existing dashboard, then ask me about any unclear requirements.';

    expect(newChatSubmissionPrompt(request, 'todo-123', planningPrompt)).toBe(
      `${request}\n\n---\n\n${planningPrompt}`,
    );
  });

  it('carries a pending todo project into its new-chat route', () => {
    expect(todoNewChatHash('todo-123', null)).toBe('#/chat/new?todo=todo-123');
    expect(todoNewChatHash('todo 123', 'project/alpha')).toBe(
      '#/chat/new?todo=todo+123&project=project%2Falpha',
    );
  });
});
