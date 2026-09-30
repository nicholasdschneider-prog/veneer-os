import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DecisionEvidence } from './DecisionEvidence';
import { ChatDecisionCard } from './chat/ChatDecisionCard';
import { questionsForConversation } from './chat/OpenQuestionsPanel';
import { staleSummary } from '@/lib/decisionPresentation';
import type { BotDecision } from '@/lib/bots';

const decision = {
  id: 'd1', conversation_id: 'chat', version: 2, state: 'needs_input', bot_name: 'Avery', can_answer: true, created_at: '2026-09-30 14:00:00', answer: null,
  proposal: { question: 'Refund the rooftop AC line for #100120886?', recommendation: 'Refund after return', consequence: 'Covers one line only.', blocked_action: 'Refund after receipt',
    choices: [{ id: 'a', label: 'Refund $1,393.21 after return', description: 'Once the unit is back', action: 'approve', recommended: true }, { id: 'b', label: 'Replace the unit', description: 'No refund', action: 'approve' }],
    evidence_items: [
      { kind: 'image', label: 'Box damage 1', source: { system: 'gmail', message_id: 'm1', attachment_id: 'a1' }, sha256: 'a'.repeat(64), retained: true },
      { kind: 'message', label: 'William, Sep 29 (email)', source: { system: 'orderops', ticket_id: 'T1', message_id: 'm3' }, text: 'The unit arrived with the foam crushed.' },
      { kind: 'record', label: 'Shopify refunds', source: { system: 'shopify', order_id: '5551' }, text: 'No refunds recorded. Paid $1,690.67.', captured_at: '2026-09-30T14:00:00Z' },
      { kind: 'document', label: 'Carrier claim.pdf', source: { system: 'orderops', ticket_id: 'T1', attachment_id: 'x' }, sha256: 'b'.repeat(64), retained: true },
      { kind: 'image', label: 'Missing photo', source: { system: 'orderops', ticket_id: 'T1', attachment_id: 'y' }, retained: false },
    ],
  },
  human_evidence: [{ kind: 'image', label: 'unit.png', source: { system: 'upload', path: '/x' }, sha256: 'c'.repeat(64), retained: true, added_by: 'human' }],
} as unknown as BotDecision;

describe('decision evidence on the card', () => {
  it('groups evidence by kind with photos open, other groups folded, and per-version URLs', () => {
    const html = renderToStaticMarkup(<DecisionEvidence decision={decision} />);
    expect(html).toContain('Photos · 2');
    expect(html).toContain('/api/bots/decisions/d1/evidence/2/0');
    expect(html).toContain('/api/bots/decisions/d1/evidence/2/5');
    expect(html).toContain('alt="unit.png"');
    expect(html).toContain('Customer messages · 1');
    expect(html).toContain('The unit arrived with the foam crushed.');
    expect(html).toContain('Order &amp; refund facts · 1');
    expect(html).toContain('No refunds recorded. Paid $1,690.67.');
    expect(html).toContain('Documents · 1');
    expect(html).toContain('/api/bots/decisions/d1/evidence/2/3');
    expect(html).toContain('1 cited file was not retained');
    expect(html).not.toContain('<details open');
    expect(renderToStaticMarkup(<DecisionEvidence decision={decision} defaultOpen />)).toContain('<details open');
    expect(renderToStaticMarkup(<DecisionEvidence decision={{ ...decision, proposal: { ...decision.proposal, evidence_items: [] }, human_evidence: [] }} />)).toBe('');
  });
  it('shows the evidence on the chat card, and a stale card hides the choices', () => {
    const fresh = renderToStaticMarkup(<ChatDecisionCard decision={decision} />);
    expect(fresh).toContain('Photos · 2');
    expect(fresh).toContain('Refund $1,393.21 after return');
    expect(fresh).toContain('Something else');
    const stale = renderToStaticMarkup(<ChatDecisionCard decision={{ ...decision, stale: { reason: 'customer_replied', since: new Date(Date.now() - 12 * 60000).toISOString(), detail: 'the customer replied' } }} />);
    expect(stale).toContain('Stale: customer replied 12 min ago');
    expect(stale).toContain('Bot is refreshing this question');
    expect(stale).not.toContain('Refund $1,393.21 after return');
    expect(stale).not.toContain('Something else');
  });
  it('orders open questions by the latest case activity', () => {
    const older = { ...decision, id: 'old', created_at: '2026-09-30 10:00:00', stale: null };
    const newer = { ...decision, id: 'new', created_at: '2026-09-30 12:00:00', stale: null };
    const moved = { ...decision, id: 'moved', created_at: '2026-09-30 09:00:00', stale: { reason: 'customer_replied', since: '2026-09-30T13:00:00Z', detail: 'replied' } };
    expect(questionsForConversation([older, newer, moved], 'chat').map(d => d.id)).toEqual(['moved', 'new', 'old']);
    expect(staleSummary({ reason: 'ticket_created', since: new Date(Date.now() - 3 * 3600000).toISOString(), detail: '' })).toBe('Stale: new ticket on this case 3 h ago');
  });
});
