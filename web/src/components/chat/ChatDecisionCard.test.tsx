import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ChatDecisionCard } from './ChatDecisionCard';
import { questionsForConversation } from './OpenQuestionsPanel';
import type { BotDecision } from '@/lib/bots';

const decision = {
  id: 'one', conversation_id: 'chat', version: 3, state: 'needs_input', bot_name: 'Avery', can_answer: true,
  proposal: { question: 'Send the proposed reply?', recommendation: 'Send one reply', consequence: 'No replacement authorized', blocked_action: 'Only the named executor sends',
    choices: [{ id: 'yes', label: 'Yes, send this reply', action: 'approve' }, { id: 'hold', label: 'Not now', action: 'defer' }],
  }, answer: null,
} as BotDecision;

describe('inline decision cards', () => {
  it('asks the question with scoped clickable choices and conditions in the conversation', () => {
    const html = renderToStaticMarkup(<ChatDecisionCard decision={decision} />);
    expect(html).toContain('Send the proposed reply?');
    expect(html).toContain('Yes, send this reply');
    expect(html).toContain('No replacement authorized');
    expect(html).toContain('Only the named executor sends');
    expect(html).toContain('Applies to this case only');
    expect(html).toContain('Defers this decision');
  });
  it('does not offer answer controls without permission and disables them after refresh failure', () => {
    const html = renderToStaticMarkup(<ChatDecisionCard decision={{ ...decision, can_answer: false }} />);
    expect(html).not.toContain('Approves this proposal');
    expect(html).toContain('Waiting for an authorized answer');
    const unavailable = renderToStaticMarkup(<ChatDecisionCard decision={decision} unavailable />);
    expect(unavailable.match(/disabled=""/g)).toHaveLength(2);
  });
  it.each(['approve', 'reject', 'defer', 'withdraw'])('retains an inline %s answer while clearing Open questions', action => {
    const answered = { ...decision, state: 'decided', answer: { action, text: 'Human answer', scope: 'this_case', actor_id: 1 } };
    expect(questionsForConversation([answered], 'chat')).toEqual([]);
    const html = renderToStaticMarkup(<ChatDecisionCard decision={answered} />);
    expect(html).toContain('Human answer');
    expect(html).not.toContain('Approves this proposal');
    expect(html).toContain('Details &amp; history');
  });
});
