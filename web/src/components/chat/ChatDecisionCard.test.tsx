import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ChatDecisionCard } from './ChatDecisionCard';
import { DecisionChoices } from '../DecisionChoices';
import { questionsForConversation } from './OpenQuestionsPanel';
import type { BotDecision } from '@/lib/bots';

const decision = {
  id: 'one', conversation_id: 'chat', version: 3, state: 'needs_input', bot_name: 'Speed', can_answer: true,
  proposal: { question: 'How do 10 × IRV-BRACKET-3-PREM pack for #100122179?', recommendation: 'Teach the ten pack', consequence: 'Picking an answer only teaches the pack. It will not ship anything.', blocked_action: 'Only the worker records the pack',
    review_summary: { action_title: 'Teach the ten pack', request: 'You taught 6 in a 10×4×4 at 15 oz and 12 in a 10×4×4 at 2 lb, but never 10.', background: ['Order is paid and unfulfilled.'] },
    choices: [
      { id: 'twolb', label: '10×4×4 poly, 2 lb', description: 'Same as the 12 pack', action: 'approve', answer: '10x4x4:32oz' },
      { id: 'mid', label: '10×4×4 poly, 27 oz', description: 'About 1.7 lb, between the 6 and 12 packs', action: 'approve', answer: '10x4x4:27oz', recommended: true },
      { id: 'hold', label: 'Hold this order', action: 'defer' },
    ],
  }, answer: null,
} as BotDecision;

describe('inline decision cards', () => {
  it('asks the question with what the bot found, researched options first and a typed answer', () => {
    const html = renderToStaticMarkup(<ChatDecisionCard decision={decision} />);
    expect(html).toContain('How do 10 × IRV-BRACKET-3-PREM pack');
    expect(html).toContain('never 10.');
    expect(html).toContain('It will not ship anything.');
    expect(html).toContain('Recommended');
    expect(html.indexOf('10×4×4 poly, 27 oz')).toBeLessThan(html.indexOf('10×4×4 poly, 2 lb'));
    expect(html).toContain('Same as the 12 pack');
    expect(html).not.toContain('Approves this proposal');
    expect(html).toContain('Something else');
    expect(html).toContain('Hold this order');
    expect(html.indexOf('Something else')).toBeLessThan(html.indexOf('Hold this order'));
    expect(html).toContain('Or answer in the chat below');
    expect(html).not.toContain('Only the worker records the pack');
  });
  it('keeps action explanations for legacy proposals without bot-supplied choices', () => {
    const html = renderToStaticMarkup(<ChatDecisionCard decision={{ ...decision, proposal: { ...decision.proposal, choices: undefined } }} />);
    expect(html).toContain('Approve recommendation');
    expect(html).toContain('Approves this proposal');
    expect(html).toContain('Not now');
  });
  it('does not offer answer controls without permission and disables them after refresh failure', () => {
    const html = renderToStaticMarkup(<ChatDecisionCard decision={{ ...decision, can_answer: false }} />);
    expect(html).not.toContain('Something else');
    expect(html).toContain('Waiting for an authorized answer');
    const unavailable = renderToStaticMarkup(<ChatDecisionCard decision={decision} unavailable />);
    expect(unavailable.match(/disabled=""/g)).toHaveLength(4);
  });
  it('renders every option as a button when the bot offers only hold reasons', () => {
    const html = renderToStaticMarkup(<DecisionChoices choices={[{ id: 'a', label: 'Hold: vendor', action: 'defer' }, { id: 'b', label: 'Hold: customer', action: 'defer' }]} disabled={false} onChoose={() => {}} />);
    expect(html.match(/<button/g)).toHaveLength(2);
    expect(html).not.toContain('underline');
  });
  it.each(['approve', 'reject', 'defer', 'withdraw', 'custom'])('retains an inline %s answer while clearing Open questions', action => {
    const answered = { ...decision, state: 'decided', answer: { action, text: 'Human answer', scope: 'this_case', actor_id: 1, ...(action === 'custom' ? { choice_label: 'Something else' } : {}) } };
    expect(questionsForConversation([answered], 'chat')).toEqual([]);
    const html = renderToStaticMarkup(<ChatDecisionCard decision={answered} />);
    expect(html).toContain('Human answer');
    expect(html).not.toContain('Approves this proposal');
    expect(html).toContain('Details &amp; history');
  });
});
