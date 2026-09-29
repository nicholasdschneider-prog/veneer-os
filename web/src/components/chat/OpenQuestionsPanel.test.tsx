import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { questionsForConversation, OpenQuestionsPanel } from './OpenQuestionsPanel';
import { BotCommunicationContent } from '../BotCommunication';
import type { BotDecision } from '@/lib/bots';

const decision = (id: string, state: string, action?: string, conversationId = 'chat') => ({
  id, state, conversation_id: conversationId, answer: action ? { action } : null,
} as BotDecision);

describe('chat open questions', () => {
  it('keeps only unanswered questions for this chat; answered work stays in history', () => {
    const decisions = [
      decision('pending', 'needs_input'), decision('blocked', 'blocked', 'approve'),
      decision('deferred', 'decided', 'defer'), decision('running', 'running', 'approve'),
      decision('completed', 'verified_completed', 'approve'), decision('rejected', 'decided', 'reject'),
      decision('withdrawn', 'decided', 'withdraw'), decision('other', 'needs_input', undefined, 'other-chat'),
    ];
    expect(questionsForConversation(decisions, 'chat').map(d => d.id)).toEqual(['pending']);
    expect(questionsForConversation(decisions, 'other-chat').map(d => d.id)).toEqual(['other']);
  });

  it('removes persistent obligations from transcript rendering without dropping the underlying records', () => {
    const props = { data: { drafts: [], briefings: [], approved_obligations: [{ decision_id: 'original', version: 4, ready: false, reason: 'Awaiting source mapping' }] }, error: '', refresh: () => {} };
    expect(renderToStaticMarkup(<BotCommunicationContent {...props} hideDrafts hideObligations />)).not.toContain('Original approved message');
    expect(renderToStaticMarkup(<BotCommunicationContent {...props} />)).toContain('Awaiting source mapping');
    expect(props.data.approved_obligations).toHaveLength(1);
  });

  it('exposes unanswered questions and a separate progress link while loading', () => {
    const html = renderToStaticMarkup(<OpenQuestionsPanel conversationId="chat" onClose={() => {}} onNavigate={() => {}} />);
    expect(html).toContain('Close open questions');
    expect(html).toContain('aria-label="Needs your input"');
    expect(html).not.toContain('aria-label="Follow-through"');
    expect(html).toContain('Progress &amp; history');
    expect(html).toContain('Loading questions');
    expect(html).not.toContain('No questions waiting');
  });
});
