import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BotProposalSummary } from './BotProposalSummary';
import type { BotDecision } from '@/lib/bots';

describe('human decision review', () => {
  it('keeps limits visible and puts the unmodified draft and protocol in separate disclosures', () => {
    const decision = { id: 'reference-1', version: 2, proposal: {
      recommendation: 'Send a tracking update.', consequence: 'No refund approved. The date is an estimate.',
      blocked_action: 'Recheck material evidence. EXACT DRAFT: Hello, we cannot confirm delivery yet.',
    } } as BotDecision;
    const html = renderToStaticMarkup(<BotProposalSummary decision={decision} showIdentifiers />);
    const firstDisclosure = html.indexOf('<details');
    expect(html.indexOf('No refund approved. The date is an estimate.')).toBeLessThan(firstDisclosure);
    expect(html).toContain('Read the proposed customer reply');
    expect(html).toContain('Hello, we cannot confirm delivery yet.');
    expect(html.indexOf('Recheck material evidence.')).toBeGreaterThan(html.indexOf('Full instructions &amp; conditions'));
    expect(html).toContain('reference-1');
    expect(html).not.toContain('line-clamp');
  });
  it('keeps card limits visible while preserving the complete background behind an explicit disclosure', () => {
    const decision = { proposal: {
      recommendation: 'Check parcel 1 and parcel 2. Only one has carrier acceptance.',
      consequence: '$0 update only; no refund or replacement. Delivery is not guaranteed.',
      blocked_action: 'Refresh tracking before sending.',
    } } as BotDecision;
    const html = renderToStaticMarkup(<BotProposalSummary decision={decision} compact />);
    expect(html.indexOf(decision.proposal.consequence)).toBeLessThan(html.indexOf('<details'));
    expect(html.indexOf(decision.proposal.recommendation)).toBeGreaterThan(html.indexOf('Read recommendation &amp; background'));
    expect(html).toContain(decision.proposal.blocked_action);
    expect(html).not.toContain('Read the proposed customer reply');
    expect(html).not.toContain('line-clamp');
  });

});
